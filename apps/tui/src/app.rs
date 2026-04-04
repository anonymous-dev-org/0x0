use std::collections::HashMap;
use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use tui_textarea::{Input, Key, TextArea};

use crate::agent::{Agent, AgentRegistry};
use crate::context;
use crate::conversation::Conversation;
use crate::event::{AppEvent, ProviderInfo};
use crate::mention::parse_mentions;
use crate::message::{ChatMessage, ContentBlock, ExecutionTarget, ProviderModeKind, Role};

/// Known models per provider. The server doesn't expose a models list,
/// so we maintain a sensible set here.
const CLAUDE_MODELS: &[&str] = &["sonnet", "opus", "haiku"];
const CODEX_MODELS: &[&str] = &[
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "codex-1",
    "codex-mini-latest",
];
const CLAUDE_EFFORTS_FULL: &[&str] = &["low", "medium", "high", "max"];
const CLAUDE_EFFORTS_NO_MAX: &[&str] = &["low", "medium", "high"];
const CODEX_EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh"];
const CLAUDE_PERMISSION_MODES: &[&str] = &[
    "plan",
    "default",
    "auto",
    "acceptEdits",
    "dontAsk",
    "bypassPermissions",
];
const CODEX_SANDBOX_MODES: &[&str] = &["read-only", "workspace-write", "danger-full-access"];

fn known_models(provider: &str) -> &'static [&'static str] {
    match provider {
        "claude" => CLAUDE_MODELS,
        "codex" => CODEX_MODELS,
        _ => &[],
    }
}

/// A selectable entry in the LLM picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmOption {
    pub provider: String,
    pub model: String,
}

impl std::fmt::Display for LlmOption {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.provider, self.model)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaletteCommand {
    CreateWorkgroup,
    ChooseLlm,
    ChooseMode,
    ChooseEffort,
    OpenConversations,
    NewConversation,
    DeleteConversation,
    ShowHelp,
}

impl PaletteCommand {
    pub fn label(self) -> &'static str {
        match self {
            Self::CreateWorkgroup => "Create Workgroup",
            Self::ChooseLlm => "Choose LLM",
            Self::ChooseMode => "Choose Mode",
            Self::ChooseEffort => "Choose Effort",
            Self::OpenConversations => "Open Conversation",
            Self::NewConversation => "New Conversation",
            Self::DeleteConversation => "Delete Conversation",
            Self::ShowHelp => "Show Help",
        }
    }

    pub fn shortcut(self) -> &'static str {
        match self {
            Self::CreateWorkgroup => "via Ctrl+P",
            Self::ChooseLlm => "Ctrl+L",
            Self::ChooseMode => "Ctrl+M",
            Self::ChooseEffort => "Ctrl+E",
            Self::OpenConversations => "Ctrl+S",
            Self::NewConversation => "Ctrl+N",
            Self::DeleteConversation => "Ctrl+D",
            Self::ShowHelp => "via Ctrl+P",
        }
    }
}

/// Handoff mode selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffMode {
    Summary,
    Fresh,
}

/// State for the handoff radio prompt.
#[derive(Debug, Clone)]
pub struct HandoffState {
    pub selected: HandoffMode,
    pub new_target: ExecutionTarget,
}

/// A single question with its options.
#[derive(Debug, Clone)]
pub struct QuestionEntry {
    pub question: String,
    pub options: Vec<String>,
    pub selected: usize,
}

/// State for inline question prompts (e.g. Claude's AskUserQuestion).
/// Supports multiple questions navigated with Left/Right,
/// options within each question navigated with Up/Down.
#[derive(Debug, Clone)]
pub struct PendingQuestion {
    pub entries: Vec<QuestionEntry>,
    pub current: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Idle,
    StreamingMessage,
    StreamingHandoff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum Overlay {
    Help,
    CommandPalette,
    AgentManager,
    LlmPicker,
    ModePicker,
    EffortPicker,
    ActivityInspector,
    ConversationSwitcher,
    ConfirmDelete,
    HandoffPrompt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteTarget {
    CurrentConversation,
    Conversation(uuid::Uuid),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveRequestKind {
    Message,
    Handoff,
    Compaction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockRef {
    pub message_id: uuid::Uuid,
    pub block_index: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InspectableLine {
    pub line_index: usize,
    pub block_ref: BlockRef,
}

/// Trigger compaction when context usage exceeds this fraction of the window.
const COMPACTION_THRESHOLD: f64 = 0.75;

/// Commands emitted by App::handle_event for the main loop to dispatch.
#[derive(Debug)]
pub enum Command {
    Quit,
    SendMessage {
        prompt: String,
        provider: String,
        model: String,
        cwd: String,
        session_id: Option<String>,
        extra_options: HashMap<String, serde_json::Value>,
        request_id: u64,
    },
    CancelStream,
    SaveConversation(Conversation),
    FetchProviders,
    /// Send a handoff prompt to the outgoing model to generate a summary.
    SendHandoff {
        prompt: String,
        provider: String,
        model: String,
        cwd: String,
        extra_options: HashMap<String, serde_json::Value>,
        request_id: u64,
    },
    /// Compact conversation history into a summary, then resend.
    SendCompaction {
        prompt: String,
        provider: String,
        model: String,
        cwd: String,
        extra_options: HashMap<String, serde_json::Value>,
        request_id: u64,
    },
    /// Load all conversations from disk (async).
    LoadConversations,
    /// Delete a conversation by ID.
    DeleteConversation {
        id: uuid::Uuid,
    },
    CopyToClipboard(String),
    Redraw,
}

pub struct App<'a> {
    pub input: TextArea<'a>,
    pub conversation: Conversation,
    pub status: Status,
    pub overlay: Option<Overlay>,
    pub base_url: String,
    pub cwd: PathBuf,

    // Scroll state
    pub scroll_offset: u16,
    pub auto_scroll: bool,
    pub content_height: u16,
    pub viewport_height: u16,
    pub messages_area_y: u16,

    // Request tracking
    pub active_request: Option<(ActiveRequestKind, u64)>,
    pub active_assistant_message_id: Option<uuid::Uuid>,
    pub next_request_id: u64,

    // Saved conversations for the switcher
    pub conversations: Vec<Conversation>,
    pub switcher_index: usize,

    // Command palette and picker state
    pub palette_commands: Vec<PaletteCommand>,
    pub palette_index: usize,
    pub agent_manager_index: usize,
    pub available_providers: Vec<ProviderInfo>,
    pub llm_options: Vec<LlmOption>,
    pub llm_index: usize,
    pub mode_index: usize,
    pub effort_index: usize,
    pub picker_agent_name: Option<String>,

    // Handoff state
    pub handoff: Option<HandoffState>,
    pub pending_delete: Option<DeleteTarget>,
    pub inspector_target: Option<BlockRef>,
    pub inspector_scroll: u16,
    pub inspectable_lines: Vec<InspectableLine>,
    pub pending_question: Option<PendingQuestion>,

    // Session and context tracking
    pub server_session_id: Option<String>,
    pub last_input_tokens: Option<u64>,
    pub context_window: Option<u64>,

    // Quit state: tracks last Ctrl+C when idle for double-press detection
    pub last_ctrl_c: Option<std::time::Instant>,

    // Message queue: messages sent while streaming, dispatched after StreamDone
    pub pending_messages: Vec<uuid::Uuid>,
    pub pending_message_targets: HashMap<uuid::Uuid, Option<String>>,
    pub deferred_commands: Vec<Command>,

    // Animation state for thinking indicator
    pub animation_tick: u64,

    // Multi-agent tracking
    /// Maps agent_name -> (request_kind, request_id) for multi-agent active requests
    pub active_requests: HashMap<String, (ActiveRequestKind, u64)>,
    /// Maps agent_name -> assistant message id for multi-agent
    pub active_assistant_ids: HashMap<String, uuid::Uuid>,
    /// Maps request_id -> agent_name for routing incoming stream events
    pub request_agent_map: HashMap<u64, String>,

    // Server spawn error (shown in UI if the server could not be started)
    pub server_error: Option<String>,
}

impl<'a> App<'a> {
    pub fn new(base_url: String) -> Self {
        let cwd = context::canonical_cwd().unwrap_or_else(|| PathBuf::from("."));

        let default_target = ExecutionTarget {
            provider: "claude".to_string(),
            model: "sonnet".to_string(),
            provider_mode: Some("plan".to_string()),
            thinking_effort: Some("medium".to_string()),
        };

        let conversation = Conversation::new(cwd.clone(), default_target);

        let mut input = TextArea::default();
        input.set_placeholder_text("Type a message...");
        input.set_cursor_line_style(ratatui::style::Style::default());
        input.set_cursor_style(
            ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::REVERSED),
        );

        Self {
            input,
            conversation,
            status: Status::Idle,
            overlay: None,
            base_url,
            cwd,
            scroll_offset: 0,
            auto_scroll: true,
            content_height: 0,
            viewport_height: 0,
            messages_area_y: 0,
            active_request: None,
            active_assistant_message_id: None,
            next_request_id: 1,
            conversations: Vec::new(),
            switcher_index: 0,
            palette_commands: vec![
                PaletteCommand::CreateWorkgroup,
                PaletteCommand::ChooseLlm,
                PaletteCommand::ChooseMode,
                PaletteCommand::ChooseEffort,
                PaletteCommand::OpenConversations,
                PaletteCommand::NewConversation,
                PaletteCommand::DeleteConversation,
                PaletteCommand::ShowHelp,
            ],
            palette_index: 0,
            agent_manager_index: 0,
            available_providers: Vec::new(),
            llm_options: Vec::new(),
            llm_index: 0,
            mode_index: 0,
            effort_index: 0,
            picker_agent_name: None,
            handoff: None,
            pending_delete: None,
            inspector_target: None,
            inspector_scroll: 0,
            inspectable_lines: Vec::new(),
            pending_question: None,
            server_session_id: None,
            last_input_tokens: None,
            context_window: None,
            last_ctrl_c: None,
            pending_messages: Vec::new(),
            pending_message_targets: HashMap::new(),
            deferred_commands: Vec::new(),
            animation_tick: 0,
            active_requests: HashMap::new(),
            active_assistant_ids: HashMap::new(),
            request_agent_map: HashMap::new(),
            server_error: None,
        }
    }

    /// Returns the current execution target.
    pub fn target(&self) -> &ExecutionTarget {
        &self.conversation.default_target
    }

    pub fn picker_target(&self) -> &ExecutionTarget {
        if let Some(agent_name) = self.picker_agent_name.as_deref() {
            if let Some(registry) = &self.conversation.agents {
                if let Some(agent) = registry.by_name(agent_name) {
                    return &agent.target;
                }
            }
        }
        &self.conversation.default_target
    }

    /// Returns true if the "press Ctrl+C again to quit" hint should be shown.
    pub fn show_quit_hint(&self) -> bool {
        if let Some(last) = self.last_ctrl_c {
            last.elapsed().as_millis() < 1000
        } else {
            false
        }
    }

    fn is_busy(&self) -> bool {
        self.active_request.is_some() || !self.active_requests.is_empty()
    }

    pub fn provider_mode_kind(provider: &str) -> ProviderModeKind {
        match provider {
            "codex" => ProviderModeKind::Sandbox,
            _ => ProviderModeKind::PermissionMode,
        }
    }

    pub fn provider_mode_options(provider: &str) -> &'static [&'static str] {
        match provider {
            "codex" => CODEX_SANDBOX_MODES,
            _ => CLAUDE_PERMISSION_MODES,
        }
    }

    pub fn effort_options(provider: &str, model: &str) -> &'static [&'static str] {
        match provider {
            "codex" => CODEX_EFFORTS,
            "claude" => {
                // Only opus supports "max" effort
                if model.contains("opus") {
                    CLAUDE_EFFORTS_FULL
                } else {
                    CLAUDE_EFFORTS_NO_MAX
                }
            }
            _ => CLAUDE_EFFORTS_NO_MAX,
        }
    }

    pub fn provider_mode_label(provider: &str, mode: &str) -> String {
        match provider {
            "codex" => match mode {
                "read-only" => "Read only".to_string(),
                "workspace-write" => "Workspace write".to_string(),
                "danger-full-access" => "Full access".to_string(),
                _ => mode.to_string(),
            },
            _ => mode.to_string(),
        }
    }

    pub fn target_summary(target: &ExecutionTarget) -> String {
        let mut parts = vec![format!("{}/{}", target.provider, target.model)];

        if let Some(mode) = target.provider_mode.as_deref() {
            let kind = Self::provider_mode_kind(&target.provider);
            let label = Self::provider_mode_label(&target.provider, mode);
            parts.push(format!("{kind}: {label}"));
        }

        if let Some(effort) = target.thinking_effort.as_deref() {
            parts.push(format!("Effort: {effort}"));
        }

        parts.join(" | ")
    }

    fn active_request_matches(&self, kind: ActiveRequestKind, request_id: u64) -> bool {
        if self.active_request == Some((kind, request_id)) {
            return true;
        }
        self.request_agent_map
            .get(&request_id)
            .is_some_and(|agent_key| {
                self.active_requests
                    .get(agent_key)
                    .is_some_and(|(active_kind, id)| *active_kind == kind && *id == request_id)
            })
    }

    fn active_assistant_message_mut(&mut self) -> Option<&mut ChatMessage> {
        if let Some(id) = self.active_assistant_message_id {
            return self
                .conversation
                .messages
                .iter_mut()
                .find(|msg| msg.id == id);
        }
        self.conversation
            .messages
            .iter_mut()
            .rev()
            .find(|msg| msg.role == Role::Assistant)
    }

    // --- Multi-agent helpers ---

    /// Look up which agent a request_id belongs to.
    fn agent_for_request(&self, request_id: u64) -> Option<String> {
        self.request_agent_map.get(&request_id).cloned()
    }

    /// Get the active assistant message for a specific agent.
    fn active_assistant_for_agent(&mut self, agent_key: &str) -> Option<&mut ChatMessage> {
        if let Some(id) = self.active_assistant_ids.get(agent_key) {
            let id = *id;
            return self.conversation.messages.iter_mut().find(|m| m.id == id);
        }
        None
    }

    /// Get the assistant message for a request, using multi-agent map if available,
    /// falling back to single-agent field.
    fn assistant_for_request(&mut self, request_id: u64) -> Option<&mut ChatMessage> {
        if let Some(agent_key) = self.request_agent_map.get(&request_id).cloned() {
            return self.active_assistant_for_agent(&agent_key);
        }
        self.active_assistant_message_mut()
    }

    pub fn input_placeholder(&self) -> String {
        if let Some(registry) = &self.conversation.agents {
            if !registry.agents.is_empty() {
                return "No @mention -> all agents".to_string();
            }
        }
        "Type a message...".to_string()
    }

    fn agent_names(&self) -> Vec<&str> {
        self.conversation
            .agents
            .as_ref()
            .map(|registry| registry.agent_names())
            .unwrap_or_default()
    }

    fn multi_agent_targets_for_text(&self, text: &str) -> Vec<String> {
        let Some(registry) = self.conversation.agents.as_ref() else {
            return Vec::new();
        };
        if registry.agents.is_empty() {
            return Vec::new();
        }

        let known = self.agent_names();
        let parsed = parse_mentions(text, &known);
        if parsed.mentions.is_empty() {
            registry.agents.iter().map(|a| a.name.clone()).collect()
        } else {
            parsed.mentions
        }
    }

    fn relay_targets_for_agent_reply(&self, sender: &str, text: &str) -> Vec<String> {
        let Some(_registry) = self.conversation.agents.as_ref() else {
            return Vec::new();
        };

        let known = self.agent_names();
        let parsed = parse_mentions(text, &known);
        parsed
            .mentions
            .into_iter()
            .filter(|name| !name.eq_ignore_ascii_case(sender))
            .collect()
    }

    fn ensure_agent_registry(&mut self) -> &mut AgentRegistry {
        if self.conversation.agents.is_none() {
            let mut registry = AgentRegistry::new();
            registry.add(Agent::new(
                "Agent1".to_string(),
                self.conversation.default_target.clone(),
            ));
            self.conversation.agents = Some(registry);
        }
        self.conversation
            .agents
            .as_mut()
            .expect("agent registry set")
    }

    fn build_prompt_for_agent(&self, agent_name: &str, current_message: &str) -> String {
        let history: Vec<String> = self
            .conversation
            .messages
            .iter()
            .filter_map(|msg| {
                let t = msg.text();
                match msg.role {
                    Role::User if !msg.is_queued && !t.trim().is_empty() => {
                        Some(format!("User: {}", t.trim()))
                    }
                    Role::Assistant if !t.trim().is_empty() => {
                        let speaker = msg.agent_name.clone().unwrap_or_else(|| msg.display_name());
                        Some(format!("{speaker}: {}", t.trim()))
                    }
                    Role::System if msg.is_handoff && !t.trim().is_empty() => {
                        Some(format!("[Context summary]: {}", t.trim()))
                    }
                    _ => None,
                }
            })
            .collect();

        let mut parts: Vec<String> = Vec::new();
        let mut total_chars = 0usize;
        let max_chars = 4000usize;
        let max_turns = 10usize;
        let mut truncated = false;
        for part in history.iter().rev().take(max_turns) {
            total_chars += part.len();
            if total_chars > max_chars && !parts.is_empty() {
                truncated = true;
                break;
            }
            parts.push(part.clone());
        }
        if history.len() > max_turns {
            truncated = true;
        }
        parts.reverse();

        if parts.is_empty() {
            return current_message.to_string();
        }

        let mut preamble = format!("Given this group conversation so far for {agent_name}");
        if truncated {
            preamble.push_str(" (earlier messages omitted for brevity)");
        }
        preamble.push_str(":\n\n");
        format!(
            "{preamble}{}\n\nUser: {current_message}",
            parts.join("\n\n")
        )
    }

    fn estimated_tokens_for_agent_history(&self, agent_name: &str) -> usize {
        let total_chars: usize = self
            .conversation
            .messages
            .iter()
            .filter_map(|msg| {
                let t = msg.text();
                match msg.role {
                    Role::User => Some(format!("User: {}", t.trim())),
                    Role::Assistant if !t.trim().is_empty() => {
                        let speaker = msg.agent_name.clone().unwrap_or_else(|| msg.display_name());
                        Some(format!("{speaker}: {}", t.trim()))
                    }
                    Role::System if msg.is_handoff && !t.trim().is_empty() => {
                        Some(format!("[Context summary]: {}", t.trim()))
                    }
                    _ => None,
                }
            })
            .map(|part| part.len())
            .sum();
        let _ = agent_name;
        total_chars / 4
    }

    fn needs_compaction_for(
        provider: &str,
        last_input_tokens: Option<u64>,
        context_window: Option<u64>,
        estimated_tokens: usize,
    ) -> bool {
        // Claude has native context management — skip.
        if provider == "claude" {
            return false;
        }

        if let (Some(tokens), Some(window)) = (last_input_tokens, context_window) {
            if window > 0 {
                return tokens as f64 > window as f64 * COMPACTION_THRESHOLD;
            }
        }

        let default_window = 128_000f64;
        estimated_tokens as f64 > default_window * COMPACTION_THRESHOLD
    }

    fn maybe_compact_agent_context(&mut self, agent_name: &str) {
        let Some(agent) = self
            .conversation
            .agents
            .as_ref()
            .and_then(|registry| registry.by_name(agent_name))
        else {
            return;
        };

        if agent.server_session_id.is_none() {
            return;
        }

        let estimated_tokens = self.estimated_tokens_for_agent_history(agent_name);
        let should_compact = Self::needs_compaction_for(
            &agent.target.provider,
            agent.last_input_tokens,
            agent.context_window,
            estimated_tokens,
        );
        if !should_compact {
            return;
        }

        if let Some(registry) = self.conversation.agents.as_mut() {
            if let Some(agent) = registry.by_name_mut(agent_name) {
                agent.server_session_id = None;
                agent.last_input_tokens = None;
                agent.context_window = None;
            }
        }
        self.conversation.messages.push(ChatMessage::system(format!(
            "[Context compacted for {agent_name}]"
        )));
    }

    fn dispatch_agent_request(
        &mut self,
        agent_name: &str,
        user_text: &str,
        surfaced_text: &str,
    ) -> Option<Command> {
        self.maybe_compact_agent_context(agent_name);

        let agent = self
            .conversation
            .agents
            .as_ref()?
            .by_name(agent_name)?
            .clone();
        let assistant_msg = ChatMessage::agent_assistant(
            agent.name.clone(),
            agent.target.provider.clone(),
            agent.target.model.clone(),
        );
        // The assistant starts empty; UI shows thinking indicator for active turns
        let assistant_id = assistant_msg.id;
        self.conversation.messages.push(assistant_msg);

        let request_id = self.next_request_id;
        self.next_request_id += 1;
        self.active_requests
            .insert(agent.name.clone(), (ActiveRequestKind::Message, request_id));
        self.active_assistant_ids
            .insert(agent.name.clone(), assistant_id);
        self.request_agent_map
            .insert(request_id, agent.name.clone());
        self.status = Status::StreamingMessage;

        let mut extra_options = HashMap::new();
        self.apply_target_options(&agent.target, &mut extra_options);
        if let Some(registry) = &self.conversation.agents {
            extra_options.insert(
                "append_system_prompt".to_string(),
                serde_json::Value::String(registry.system_prompt_for(&agent.name)),
            );
        }

        let prompt = if agent.server_session_id.is_some() {
            surfaced_text.to_string()
        } else {
            self.build_prompt_for_agent(&agent.name, user_text)
        };

        Some(Command::SendMessage {
            prompt,
            provider: agent.target.provider,
            model: agent.target.model,
            cwd: self.cwd.to_string_lossy().to_string(),
            session_id: self.session_for_agent(&agent.name),
            extra_options,
            request_id,
        })
    }

    fn queue_pending_user_message(&mut self, text: String, target_agent: Option<String>) {
        let queued = ChatMessage::queued(text);
        self.pending_messages.push(queued.id);
        self.pending_message_targets.insert(queued.id, target_agent);
        self.conversation.messages.push(queued);
        if self.auto_scroll {
            self.scroll_to_bottom();
        }
    }

    /// Returns true if a specific agent is busy.
    pub fn is_agent_busy(&self, agent_key: &str) -> bool {
        self.active_requests.contains_key(agent_key)
    }

    /// Check if any message is an active assistant turn (for rendering dots).
    pub fn is_active_assistant(&self, msg_id: uuid::Uuid) -> bool {
        if self.active_assistant_ids.values().any(|id| *id == msg_id) {
            return true;
        }
        self.active_assistant_message_id == Some(msg_id)
    }

    /// Get the session_id for an agent, or the global one for single-agent mode.
    fn session_for_agent(&self, agent_key: &str) -> Option<String> {
        if let Some(registry) = &self.conversation.agents {
            return registry
                .by_name(agent_key)
                .and_then(|a| a.server_session_id.clone());
        }
        self.server_session_id.clone()
    }

    /// Set session_id for an agent, or the global one for single-agent mode.
    fn set_session_for_agent(&mut self, agent_key: &str, session_id: String) {
        if let Some(registry) = &mut self.conversation.agents {
            if let Some(agent) = registry.by_name_mut(agent_key) {
                agent.server_session_id = Some(session_id);
                return;
            }
        }
        self.server_session_id = Some(session_id);
    }

    pub fn color_for_agent(&self, name: &str) -> ratatui::style::Color {
        self.conversation
            .agents
            .as_ref()
            .map(|registry| registry.color_for(name))
            .unwrap_or(ratatui::style::Color::Rgb(150, 120, 255))
    }

    pub fn inspector_content(&self) -> (String, String) {
        let Some(target) = self.inspector_target else {
            return ("Activity".to_string(), "No activity selected.".to_string());
        };

        let Some(message) = self
            .conversation
            .messages
            .iter()
            .find(|msg| msg.id == target.message_id)
        else {
            return ("Activity".to_string(), "No activity selected.".to_string());
        };

        let Some(block) = message.blocks.get(target.block_index) else {
            return ("Activity".to_string(), "No activity selected.".to_string());
        };

        match block {
            ContentBlock::ToolUse { name, id, input } => {
                let mut detail = format!("Tool: {name}");
                if let Some(id) = id {
                    detail.push_str(&format!("\nId: {id}"));
                    // Find matching result
                    if let Some(result) = message.tool_result_for(id) {
                        if !result.trim().is_empty() {
                            detail.push_str(&format!("\n\nOutput:\n{result}"));
                        }
                    }
                }
                if let Some(input) = input.as_deref().filter(|v| !v.trim().is_empty()) {
                    detail.push_str(&format!("\n\nInput:\n{input}"));
                }
                (format!("Tool: {name}"), detail)
            }
            ContentBlock::ToolResult { tool_use_id, content } => {
                let mut detail = String::from("Tool result");
                if let Some(id) = tool_use_id {
                    detail.push_str(&format!("\nTool id: {id}"));
                }
                if let Some(content) = content.as_deref().filter(|v| !v.trim().is_empty()) {
                    detail.push_str(&format!("\n\nOutput:\n{content}"));
                }
                ("Tool result".to_string(), detail)
            }
            ContentBlock::Thinking { text } => {
                ("Thinking".to_string(), text.clone())
            }
            ContentBlock::Event { name, detail } => {
                (name.clone(), detail.clone())
            }
            ContentBlock::AgentStart { label, .. } => {
                (label.clone(), format!("Agent: {label}"))
            }
            _ => ("Activity".to_string(), "No details.".to_string()),
        }
    }

    /// Process an event and return an optional command.
    pub fn handle_event(&mut self, event: AppEvent) -> Vec<Command> {
        match event {
            AppEvent::Key(key) => {
                let mut cmds: Vec<Command> = self.handle_key(key).into_iter().collect();
                cmds.append(&mut self.deferred_commands);
                cmds
            }
            AppEvent::Mouse(mouse) => self.handle_mouse(mouse).into_iter().collect(),
            AppEvent::Resize(_, _) => vec![Command::Redraw],
            AppEvent::Tick => {
                self.animation_tick = self.animation_tick.wrapping_add(1);
                // Only redraw if there's an active animation
                if self.is_busy() || self.show_quit_hint() {
                    vec![Command::Redraw]
                } else {
                    vec![]
                }
            }

            AppEvent::StreamTextDelta { request_id, text } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    if let Some(msg) = self.assistant_for_request(request_id) {
                        msg.push_text(&text);
                    }
                    if self.auto_scroll {
                        self.scroll_to_bottom();
                    }
                }
                vec![]
            }

            AppEvent::StreamToolUse {
                request_id,
                name,
                id,
                input,
            } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    if let Some(msg) = self.assistant_for_request(request_id) {
                        if is_workgroup_open_tool(&name) {
                            let labels = extract_workgroup_open_labels(&input);
                            for (idx, label) in labels.iter().enumerate() {
                                let synthetic_id = id
                                    .as_ref()
                                    .map(|tool_id| format!("{tool_id}::workgroup_open::{idx}"))
                                    .unwrap_or_else(|| {
                                        format!("workgroup_open::{}::{idx}", label)
                                    });
                                msg.blocks.push(ContentBlock::AgentStart {
                                    id: synthetic_id.clone(),
                                    label: format!("Workgroup: {label}"),
                                });
                                msg.blocks.push(ContentBlock::AgentEnd { id: synthetic_id });
                            }
                        } else if is_agent_tool(&name) {
                            let label = extract_agent_label(&input);
                            msg.blocks.push(ContentBlock::AgentStart {
                                id: id.clone().unwrap_or_default(),
                                label,
                            });
                        } else if is_workgroup_agent_tool(&name) {
                            let label = extract_workgroup_agent_label(&name, &input);
                            msg.blocks.push(ContentBlock::AgentStart {
                                id: id.clone().unwrap_or_default(),
                                label,
                            });
                        } else {
                            let input_text = input.as_ref().map(pretty_json_or_text);
                            msg.blocks.push(ContentBlock::ToolUse {
                                name,
                                id,
                                input: input_text,
                            });
                        }
                    }
                    if self.auto_scroll {
                        self.scroll_to_bottom();
                    }
                }
                vec![]
            }

            AppEvent::StreamToolResult {
                request_id,
                tool_use_id,
                content,
            } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    if let Some(msg) = self.assistant_for_request(request_id) {
                        let is_agent_section = tool_use_id
                            .as_deref()
                            .is_some_and(|id| msg.is_agent_start(id));
                        if is_agent_section {
                            msg.blocks.push(ContentBlock::AgentEnd {
                                id: tool_use_id.unwrap_or_default(),
                            });
                        } else {
                            let content_text = content
                                .as_ref()
                                .map(pretty_json_or_text);
                            msg.blocks.push(ContentBlock::ToolResult {
                                tool_use_id,
                                content: content_text,
                            });
                        }
                    }
                    if self.auto_scroll {
                        self.scroll_to_bottom();
                    }
                }
                vec![]
            }

            AppEvent::StreamResult {
                request_id,
                is_error,
                input_tokens,
                context_window,
                ..
            } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    if let Some(msg) = self.assistant_for_request(request_id) {
                        if is_error == Some(true) {
                            msg.is_error = true;
                        }
                    }
                    // Track context usage for compaction decisions
                    if let Some(agent_name) = self.agent_for_request(request_id) {
                        if let Some(registry) = self.conversation.agents.as_mut() {
                            if let Some(agent) = registry.by_name_mut(&agent_name) {
                                if let Some(tokens) = input_tokens {
                                    agent.last_input_tokens = Some(tokens);
                                }
                                if let Some(window) = context_window {
                                    agent.context_window = Some(window);
                                }
                            }
                        }
                    } else {
                        if let Some(tokens) = input_tokens {
                            self.last_input_tokens = Some(tokens);
                        }
                        if let Some(window) = context_window {
                            self.context_window = Some(window);
                        }
                    }
                }
                vec![]
            }

            AppEvent::StreamAskUserQuestion {
                request_id,
                question,
                options,
            } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    let opts = options.clone();
                    if let Some(msg) = self.assistant_for_request(request_id) {
                        let mut detail = question.clone();
                        if let Some(ref options) = options {
                            if !options.is_empty() {
                                detail.push_str(&format!("\n\nOptions:\n- {}", options.join("\n- ")));
                            }
                        }
                        msg.blocks.push(ContentBlock::Event {
                            name: "ask_user_question".to_string(),
                            detail,
                        });
                    }
                    if self.auto_scroll {
                        self.scroll_to_bottom();
                    }
                    // Set up inline question buttons
                    let btn_options = opts
                        .filter(|items| !items.is_empty())
                        .unwrap_or_else(|| vec!["Yes".to_string(), "No".to_string()]);
                    let entry = QuestionEntry {
                        question: question.clone(),
                        options: btn_options,
                        selected: 0,
                    };
                    if let Some(pq) = self.pending_question.as_mut() {
                        pq.entries.push(entry);
                    } else {
                        self.pending_question = Some(PendingQuestion {
                            entries: vec![entry],
                            current: 0,
                        });
                    }
                }
                vec![]
            }

            AppEvent::StreamExitPlanMode { request_id, reason } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    let detail = reason
                        .filter(|r| !r.trim().is_empty())
                        .unwrap_or_else(|| "Plan ready for approval.".to_string());
                    if let Some(msg) = self.assistant_for_request(request_id) {
                        msg.blocks.push(ContentBlock::Event {
                            name: "exit_plan_mode".to_string(),
                            detail: detail.clone(),
                        });
                    }
                    if self.auto_scroll {
                        self.scroll_to_bottom();
                    }
                    // Show approval prompt — mode switches only on user confirmation
                    let entry = QuestionEntry {
                        question: detail,
                        options: vec![
                            "Approve".to_string(),
                            "Reject".to_string(),
                        ],
                        selected: 0,
                    };
                    if let Some(pq) = self.pending_question.as_mut() {
                        pq.entries.push(entry);
                    } else {
                        self.pending_question = Some(PendingQuestion {
                            entries: vec![entry],
                            current: 0,
                        });
                    }
                }
                vec![]
            }

            AppEvent::StreamAgentEvent {
                request_id,
                name,
                data,
            } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    if is_thinking_event(&name) {
                        if let Some(msg) = self.assistant_for_request(request_id) {
                            let text = data
                                .as_ref()
                                .and_then(|d| d.get("text"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if !text.is_empty() {
                                msg.push_thinking(text);
                            }
                        }
                    } else {
                        if let Some(msg) = self.assistant_for_request(request_id) {
                            let detail = data
                                .as_ref()
                                .and_then(summarize_agent_event)
                                .unwrap_or_else(|| name.clone());
                            msg.blocks.push(ContentBlock::Event {
                                name,
                                detail,
                            });
                        }
                        if self.auto_scroll {
                            self.scroll_to_bottom();
                        }
                    }
                }
                vec![]
            }

            AppEvent::StreamError { request_id, error } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    let _sender_agent = self.agent_for_request(request_id);
                    if let Some(msg) = self.assistant_for_request(request_id) {
                        if msg.role == Role::Assistant && !msg.has_text() {
                            msg.is_error = true;
                        }
                    }
                    self.status = Status::Idle;
                    self.active_request = None;
                    self.active_assistant_message_id = None;
                    if let Some(agent_key) = self.agent_for_request(request_id) {
                        self.active_requests.remove(&agent_key);
                        self.active_assistant_ids.remove(&agent_key);
                    }
                    self.request_agent_map.remove(&request_id);
                    self.conversation.messages.push(ChatMessage::error(error));
                    self.conversation.touch();
                    self.conversation.update_title();
                    if self.auto_scroll {
                        self.scroll_to_bottom();
                    }

                    let mut commands = Vec::new();

                    // Dispatch next queued message if any
                    if let Some(cmd) = self.dispatch_next_queued() {
                        commands.push(cmd);
                        commands.append(&mut self.deferred_commands);
                        commands.push(Command::SaveConversation(self.conversation.clone()));
                        return commands;
                    }
                    commands.push(Command::SaveConversation(self.conversation.clone()));
                    return commands;
                }
                vec![]
            }

            AppEvent::StreamDone { request_id } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    let sender_agent = self.agent_for_request(request_id);
                    let final_text = self
                        .assistant_for_request(request_id)
                        .map(|m| m.text())
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    // Fix the assistant placeholder if stream ended without content
                    if let Some(msg) = self.assistant_for_request(request_id) {
                        if msg.role == Role::Assistant && !msg.has_text() {
                            msg.push_text("[no response]");
                        }
                    }
                    self.status = Status::Idle;
                    self.active_request = None;
                    self.active_assistant_message_id = None;
                    if let Some(agent_key) = sender_agent.clone() {
                        self.active_requests.remove(&agent_key);
                        self.active_assistant_ids.remove(&agent_key);
                    }
                    self.request_agent_map.remove(&request_id);
                    self.conversation.touch();
                    self.conversation.update_title();

                    let mut commands = Vec::new();
                    if let (Some(sender), Some(registry)) =
                        (sender_agent.clone(), self.conversation.agents.as_mut())
                    {
                        if let Some(idx) = registry.index_of(&sender) {
                            registry.last_active = idx;
                        }
                    }

                    let should_relay = !final_text.is_empty()
                        && !final_text.eq_ignore_ascii_case("[pass]")
                        && sender_agent.is_some();
                    if should_relay {
                        let sender = sender_agent.clone().unwrap_or_default();
                        let relay_text = format!("{sender}: {final_text}");
                        let targets = self.relay_targets_for_agent_reply(&sender, &final_text);
                        for target in targets {
                            if self.is_agent_busy(&target) {
                                self.queue_pending_user_message(
                                    relay_text.clone(),
                                    Some(target.clone()),
                                );
                            } else if let Some(cmd) =
                                self.dispatch_agent_request(&target, &relay_text, &relay_text)
                            {
                                commands.push(cmd);
                            }
                        }
                    }

                    // Dispatch next queued message if any
                    if let Some(cmd) = self.dispatch_next_queued() {
                        commands.push(cmd);
                        commands.append(&mut self.deferred_commands);
                    }
                    commands.push(Command::SaveConversation(self.conversation.clone()));
                    return commands;
                }
                vec![]
            }

            AppEvent::StreamInit {
                request_id,
                session_id,
            } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    if let Some(id) = session_id {
                        if let Some(agent_key) = self.agent_for_request(request_id) {
                            self.set_session_for_agent(&agent_key, id);
                        } else {
                            self.server_session_id = Some(id);
                        }
                    }
                    // No additional state to reset
                }
                vec![]
            }

            AppEvent::ProvidersList(providers) => {
                self.available_providers = providers;
                self.build_llm_options();
                vec![]
            }

            AppEvent::HandoffComplete {
                request_id,
                summary,
            } => {
                // Handle compaction result
                if self.active_request_matches(ActiveRequestKind::Compaction, request_id) {
                    self.status = Status::Idle;
                    self.active_request = None;
                    // Remove the "Compacting..." system message
                    if let Some(msg) = self.conversation.messages.last() {
                        if msg.role == Role::System && msg.text().contains("Compacting") {
                            self.conversation.messages.pop();
                        }
                    }
                    // Keep only recent messages + add summary
                    let keep_count = 4; // Keep last N user/assistant pairs
                    let mut kept: Vec<ChatMessage> = Vec::new();
                    let recent: Vec<ChatMessage> = self
                        .conversation
                        .messages
                        .iter()
                        .rev()
                        .filter(|m| matches!(m.role, Role::User | Role::Assistant))
                        .take(keep_count)
                        .cloned()
                        .collect();
                    // Add the compaction summary as a handoff-style message
                    kept.push(ChatMessage::handoff(summary));
                    kept.push(ChatMessage::system("[Context compacted]".to_string()));
                    // Add back the recent messages in order
                    kept.extend(recent.into_iter().rev());
                    self.conversation.messages = kept;
                    // Reset session — start fresh with compacted context
                    self.server_session_id = None;
                    self.last_input_tokens = None;
                    if self.auto_scroll {
                        self.scroll_to_bottom();
                    }
                    return vec![Command::SaveConversation(self.conversation.clone())];
                }

                if !self.active_request_matches(ActiveRequestKind::Handoff, request_id) {
                    return vec![];
                }
                self.status = Status::Idle;
                self.active_request = None;
                // Store the handoff summary as a system message
                if let Some(msg) = self.conversation.messages.last() {
                    if msg.role == Role::System && msg.text().contains("Generating handoff") {
                        self.conversation.messages.pop();
                    }
                }
                self.conversation
                    .messages
                    .push(ChatMessage::handoff(summary.clone()));
                // Show completion marker
                self.conversation
                    .messages
                    .push(ChatMessage::system("[Handoff complete]".to_string()));
                if self.auto_scroll {
                    self.scroll_to_bottom();
                }
                // Apply the new target
                if let Some(hs) = self.handoff.take() {
                    self.conversation.default_target = hs.new_target;
                }
                vec![Command::SaveConversation(self.conversation.clone())]
            }

            AppEvent::HandoffError { request_id, error } => {
                // Handle compaction error — just clean up
                if self.active_request_matches(ActiveRequestKind::Compaction, request_id) {
                    self.status = Status::Idle;
                    self.active_request = None;
                    if let Some(msg) = self.conversation.messages.last() {
                        if msg.role == Role::System && msg.text().contains("Compacting") {
                            self.conversation.messages.pop();
                        }
                    }
                    self.conversation
                        .messages
                        .push(ChatMessage::system(format!("[Compaction failed: {error}]")));
                    if self.auto_scroll {
                        self.scroll_to_bottom();
                    }
                    return vec![];
                }

                if !self.active_request_matches(ActiveRequestKind::Handoff, request_id) {
                    return vec![];
                }
                self.status = Status::Idle;
                self.active_request = None;
                // Remove the [Generating handoff...] message
                if let Some(msg) = self.conversation.messages.last() {
                    if msg.role == Role::System && msg.text().contains("Generating handoff") {
                        self.conversation.messages.pop();
                    }
                }
                self.conversation.messages.push(ChatMessage::system(format!(
                    "[Handoff failed: {error} — switching with fresh context]"
                )));
                // Fall back to fresh switch
                if let Some(hs) = self.handoff.take() {
                    self.conversation.default_target = hs.new_target;
                }
                if self.auto_scroll {
                    self.scroll_to_bottom();
                }
                vec![Command::SaveConversation(self.conversation.clone())]
            }

            AppEvent::ConversationsLoaded(convs) => {
                self.conversations = convs;
                vec![]
            }

            AppEvent::ConversationDeleted(_id) => {
                // Deletion confirmed — start fresh
                vec![]
            }

            AppEvent::ApiError(err) => {
                self.conversation.messages.push(ChatMessage::error(err));
                if self.auto_scroll {
                    self.scroll_to_bottom();
                }
                vec![]
            }
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> Option<Command> {
        // Handle overlay-specific keys first
        if self.overlay.is_some() {
            return self.handle_overlay_key(key);
        }

        // Esc during handoff generation → cancel and fall back to fresh
        if self.status == Status::StreamingHandoff && key.code == KeyCode::Esc {
            // Remove [Generating handoff...] message
            if let Some(msg) = self.conversation.messages.last() {
                if msg.role == Role::System && msg.text().contains("Generating handoff") {
                    self.conversation.messages.pop();
                }
            }
            self.conversation.messages.push(ChatMessage::system(
                "[Handoff cancelled — switching with fresh context]".to_string(),
            ));
            if let Some(hs) = self.handoff.take() {
                self.conversation.default_target = hs.new_target;
            }
            self.status = Status::Idle;
            self.active_request = None;
            if self.auto_scroll {
                self.scroll_to_bottom();
            }
            return Some(Command::CancelStream);
        }

        // Ctrl-prefixed global shortcuts
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('c') => {
                    if self.is_busy() {
                        self.last_ctrl_c = None;
                        return Some(Command::CancelStream);
                    }
                    // Double Ctrl+C when idle → quit
                    let now = std::time::Instant::now();
                    if let Some(last) = self.last_ctrl_c {
                        if now.duration_since(last).as_millis() < 1000 {
                            return Some(Command::Quit);
                        }
                    }
                    self.last_ctrl_c = Some(now);
                    // Show hint — add a transient system message
                    // (we'll just set a flag that the UI can render)
                    return None;
                }
                KeyCode::Char('n') => {
                    return self.new_conversation();
                }
                KeyCode::Char('p') => {
                    self.palette_index = 0;
                    self.overlay = Some(Overlay::CommandPalette);
                    return None;
                }
                KeyCode::Char('l') => {
                    if self.is_busy() {
                        return None;
                    }
                    self.picker_agent_name = None;
                    return self.open_llm_picker();
                }
                KeyCode::Char('m') => {
                    if self.is_busy() {
                        return None;
                    }
                    self.picker_agent_name = None;
                    self.open_mode_picker();
                    return None;
                }
                KeyCode::Char('e') => {
                    if self.is_busy() {
                        return None;
                    }
                    self.picker_agent_name = None;
                    self.open_effort_picker();
                    return None;
                }
                KeyCode::Char('s') => {
                    if self.is_busy() {
                        return None;
                    }
                    self.switcher_index = 0;
                    self.overlay = Some(Overlay::ConversationSwitcher);
                    return Some(Command::LoadConversations);
                }
                KeyCode::Char('d') => {
                    if self.is_busy() {
                        return None;
                    }
                    if self.conversation.messages.is_empty() {
                        return None;
                    }
                    self.pending_delete = Some(DeleteTarget::CurrentConversation);
                    self.overlay = Some(Overlay::ConfirmDelete);
                    return None;
                }
                KeyCode::Home => {
                    self.scroll_offset = 0;
                    self.auto_scroll = false;
                    return None;
                }
                KeyCode::End => {
                    self.scroll_to_bottom();
                    self.auto_scroll = true;
                    return None;
                }
                _ => {}
            }
        }

        // Page scroll
        match key.code {
            KeyCode::PageUp => {
                self.scroll_offset = self.scroll_offset.saturating_sub(self.viewport_height / 2);
                self.auto_scroll = false;
                return None;
            }
            KeyCode::PageDown => {
                self.scroll_offset = self
                    .scroll_offset
                    .saturating_add(self.viewport_height / 2)
                    .min(self.max_scroll());
                if self.scroll_offset >= self.max_scroll() {
                    self.auto_scroll = true;
                }
                return None;
            }
            _ => {}
        }

        // Pending question: Up/Down for options, Left/Right for questions, Esc to dismiss
        if self.pending_question.is_some() {
            match key.code {
                KeyCode::Esc => {
                    self.pending_question = None;
                    return None;
                }
                KeyCode::Up => {
                    if let Some(pq) = self.pending_question.as_mut() {
                        if let Some(entry) = pq.entries.get_mut(pq.current) {
                            entry.selected = entry.selected.saturating_sub(1);
                        }
                    }
                    return None;
                }
                KeyCode::Down => {
                    if let Some(pq) = self.pending_question.as_mut() {
                        if let Some(entry) = pq.entries.get_mut(pq.current) {
                            entry.selected =
                                (entry.selected + 1).min(entry.options.len().saturating_sub(1));
                        }
                    }
                    return None;
                }
                KeyCode::Left => {
                    if let Some(pq) = self.pending_question.as_mut() {
                        pq.current = pq.current.saturating_sub(1);
                    }
                    return None;
                }
                KeyCode::Right => {
                    if let Some(pq) = self.pending_question.as_mut() {
                        pq.current = (pq.current + 1).min(pq.entries.len().saturating_sub(1));
                    }
                    return None;
                }
                _ => {}
            }
        }

        // Enter sends unless Shift is held.
        if key.code == KeyCode::Enter && !key.modifiers.contains(KeyModifiers::SHIFT) {
            // If pending question and input is empty, send the selected option
            if self.pending_question.is_some() {
                let input_text: String = self.input.lines().join("\n").trim().to_string();
                if input_text.is_empty() {
                    if let Some(pq) = self.pending_question.take() {
                        // Collect selected answer from the current question
                        if let Some(entry) = pq.entries.get(pq.current) {
                            let answer = entry
                                .options
                                .get(entry.selected)
                                .cloned()
                                .unwrap_or_default();
                            // Handle exit_plan_mode approval
                            if answer == "Approve" {
                                self.conversation.default_target.provider_mode =
                                    Some("default".to_string());
                            }
                            self.input.insert_str(&answer);
                        }
                    }
                } else {
                    // User typed a custom answer; clear the question
                    self.pending_question = None;
                }
            }
            return self.send_message();
        }

        // Shift+Enter -> newline
        if key.code == KeyCode::Enter && key.modifiers.contains(KeyModifiers::SHIFT) {
            self.input.input(Input {
                key: Key::Enter,
                ctrl: false,
                alt: false,
                shift: false,
            });
            return None;
        }

        // Ctrl+J → newline
        if key.code == KeyCode::Char('j') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.input.input(Input {
                key: Key::Enter,
                ctrl: false,
                alt: false,
                shift: false,
            });
            return None;
        }

        // Alt+Left/Right → word movement (macOS Option+Arrow)
        if key.modifiers.contains(KeyModifiers::ALT) {
            match key.code {
                KeyCode::Left => {
                    self.input.input(Input {
                        key: Key::Left,
                        ctrl: false,
                        alt: true,
                        shift: false,
                    });
                    return None;
                }
                KeyCode::Right => {
                    self.input.input(Input {
                        key: Key::Right,
                        ctrl: false,
                        alt: true,
                        shift: false,
                    });
                    return None;
                }
                KeyCode::Backspace => {
                    // Alt+Backspace → delete word backward
                    self.input.input(Input {
                        key: Key::Backspace,
                        ctrl: false,
                        alt: true,
                        shift: false,
                    });
                    return None;
                }
                _ => {}
            }
        }

        // Cmd+Backspace (Super modifier) → delete to start of line
        if key.modifiers.contains(KeyModifiers::SUPER) && key.code == KeyCode::Backspace {
            self.input.delete_line_by_head();
            return None;
        }

        // Forward everything else to textarea
        self.input.input(key);
        None
    }

    fn handle_mouse(&mut self, mouse: MouseEvent) -> Option<Command> {
        if self.overlay.is_some() {
            return None;
        }

        match mouse.kind {
            MouseEventKind::ScrollUp => {
                let scroll_amount = 3u16;
                self.scroll_offset = self.scroll_offset.saturating_sub(scroll_amount);
                self.auto_scroll = false;
                return None;
            }
            MouseEventKind::ScrollDown => {
                let scroll_amount = 3u16;
                self.scroll_offset = self
                    .scroll_offset
                    .saturating_add(scroll_amount)
                    .min(self.max_scroll());
                if self.scroll_offset >= self.max_scroll() {
                    self.auto_scroll = true;
                }
                return None;
            }
            MouseEventKind::Down(MouseButton::Left) => {}
            _ => return None,
        }

        if mouse.row < self.messages_area_y
            || mouse.row >= self.messages_area_y + self.viewport_height
        {
            return None;
        }

        let relative = mouse.row.saturating_sub(self.messages_area_y) as usize;
        let line_index = self.scroll_offset as usize + relative;
        if let Some(target) = self
            .inspectable_lines
            .iter()
            .find(|entry| entry.line_index == line_index)
            .map(|entry| entry.block_ref)
        {
            self.inspector_target = Some(target);
            self.inspector_scroll = 0;
            self.overlay = Some(Overlay::ActivityInspector);
        }

        None
    }

    fn handle_overlay_key(&mut self, key: KeyEvent) -> Option<Command> {
        let overlay = self.overlay.unwrap();

        match overlay {
            Overlay::CommandPalette => self.handle_command_palette_key(key),
            Overlay::AgentManager => self.handle_agent_manager_key(key),
            Overlay::LlmPicker => self.handle_llm_picker_key(key),
            Overlay::ModePicker => self.handle_mode_picker_key(key),
            Overlay::EffortPicker => self.handle_effort_picker_key(key),
            Overlay::ActivityInspector => {
                match key.code {
                    KeyCode::Esc | KeyCode::Enter => {
                        self.overlay = None;
                        self.inspector_target = None;
                    }
                    KeyCode::Char('y') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        let (_, body) = self.inspector_content();
                        return Some(Command::CopyToClipboard(body));
                    }
                    KeyCode::Up | KeyCode::Char('k') => {
                        self.inspector_scroll = self.inspector_scroll.saturating_sub(1);
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        self.inspector_scroll = self.inspector_scroll.saturating_add(1);
                    }
                    KeyCode::PageUp => {
                        self.inspector_scroll = self.inspector_scroll.saturating_sub(10);
                    }
                    KeyCode::PageDown => {
                        self.inspector_scroll = self.inspector_scroll.saturating_add(10);
                    }
                    KeyCode::Home => {
                        self.inspector_scroll = 0;
                    }
                    KeyCode::End => {
                        self.inspector_scroll = u16::MAX; // will be clamped in render
                    }
                    _ => {}
                }
                None
            }
            Overlay::HandoffPrompt => self.handle_handoff_prompt_key(key),
            Overlay::ConversationSwitcher => self.handle_conversation_switcher_key(key),
            Overlay::ConfirmDelete => self.handle_confirm_delete_key(key),
            Overlay::Help => {
                if key.code == KeyCode::Esc {
                    self.overlay = None;
                }
                None
            }
        }
    }

    fn handle_command_palette_key(&mut self, key: KeyEvent) -> Option<Command> {
        match key.code {
            KeyCode::Esc => {
                self.picker_agent_name = None;
                self.overlay = None;
                None
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if self.palette_index > 0 {
                    self.palette_index -= 1;
                }
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.palette_index + 1 < self.palette_commands.len() {
                    self.palette_index += 1;
                }
                None
            }
            KeyCode::Enter => {
                self.overlay = None;
                match self.palette_commands.get(self.palette_index).copied() {
                    Some(PaletteCommand::CreateWorkgroup) => None,
                    Some(PaletteCommand::ChooseLlm) => {
                        self.picker_agent_name = None;
                        self.open_llm_picker()
                    }
                    Some(PaletteCommand::ChooseMode) => {
                        self.picker_agent_name = None;
                        self.open_mode_picker();
                        None
                    }
                    Some(PaletteCommand::ChooseEffort) => {
                        self.picker_agent_name = None;
                        self.open_effort_picker();
                        None
                    }
                    Some(PaletteCommand::OpenConversations) => {
                        self.switcher_index = 0;
                        self.overlay = Some(Overlay::ConversationSwitcher);
                        Some(Command::LoadConversations)
                    }
                    Some(PaletteCommand::NewConversation) => self.new_conversation(),
                    Some(PaletteCommand::DeleteConversation) => {
                        if self.conversation.messages.is_empty() {
                            None
                        } else {
                            self.pending_delete = Some(DeleteTarget::CurrentConversation);
                            self.overlay = Some(Overlay::ConfirmDelete);
                            None
                        }
                    }
                    Some(PaletteCommand::ShowHelp) => {
                        self.overlay = Some(Overlay::Help);
                        None
                    }
                    None => None,
                }
            }
            _ => None,
        }
    }

    fn handle_agent_manager_key(&mut self, key: KeyEvent) -> Option<Command> {
        let len = self
            .conversation
            .agents
            .as_ref()
            .map(|r| r.agents.len())
            .unwrap_or(0);
        match key.code {
            KeyCode::Esc => {
                self.overlay = None;
                None
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if self.agent_manager_index > 0 {
                    self.agent_manager_index -= 1;
                }
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.agent_manager_index + 1 < len {
                    self.agent_manager_index += 1;
                }
                None
            }
            KeyCode::Char('a') => {
                let target = self.conversation.default_target.clone();
                let registry = self.ensure_agent_registry();
                let name = registry.next_name();
                registry.add(Agent::new(name, target));
                self.agent_manager_index = registry.agents.len().saturating_sub(1);
                Some(Command::SaveConversation(self.conversation.clone()))
            }
            KeyCode::Char('l') => {
                let agent_name = self
                    .conversation
                    .agents
                    .as_ref()
                    .and_then(|registry| registry.agents.get(self.agent_manager_index))
                    .map(|a| a.name.clone());
                self.picker_agent_name = agent_name;
                self.open_llm_picker()
            }
            KeyCode::Char('m') => {
                let agent_name = self
                    .conversation
                    .agents
                    .as_ref()
                    .and_then(|registry| registry.agents.get(self.agent_manager_index))
                    .map(|a| a.name.clone());
                self.picker_agent_name = agent_name;
                self.open_mode_picker();
                None
            }
            KeyCode::Char('e') => {
                let agent_name = self
                    .conversation
                    .agents
                    .as_ref()
                    .and_then(|registry| registry.agents.get(self.agent_manager_index))
                    .map(|a| a.name.clone());
                self.picker_agent_name = agent_name;
                self.open_effort_picker();
                None
            }
            KeyCode::Char('r') => None,
            KeyCode::Char('d') => {
                let (name, can_remove) = self
                    .conversation
                    .agents
                    .as_ref()
                    .and_then(|registry| registry.agents.get(self.agent_manager_index))
                    .map(|a| (a.name.clone(), len > 1))
                    .unwrap_or_default();
                if !can_remove {
                    return None;
                }
                if let Some(registry) = self.conversation.agents.as_mut() {
                    registry.remove(&name);
                    self.active_requests.remove(&name);
                    self.active_assistant_ids.remove(&name);
                    self.request_agent_map
                        .retain(|_, v| !v.eq_ignore_ascii_case(&name));
                    if self.agent_manager_index >= registry.agents.len()
                        && self.agent_manager_index > 0
                    {
                        self.agent_manager_index -= 1;
                    }
                }
                Some(Command::SaveConversation(self.conversation.clone()))
            }
            KeyCode::Enter => {
                if let Some(registry) = self.conversation.agents.as_mut() {
                    if self.agent_manager_index < registry.agents.len() {
                        registry.last_active = self.agent_manager_index;
                        return Some(Command::SaveConversation(self.conversation.clone()));
                    }
                }
                None
            }
            _ => None,
        }
    }

    fn open_llm_picker(&mut self) -> Option<Command> {
        if self.llm_options.is_empty() {
            self.build_llm_options();
        }
        let target = self.picker_target();
        self.llm_index = self
            .llm_options
            .iter()
            .position(|t| t.provider == target.provider && t.model == target.model)
            .unwrap_or(0);
        self.overlay = Some(Overlay::LlmPicker);
        if self.available_providers.is_empty() {
            Some(Command::FetchProviders)
        } else {
            None
        }
    }

    fn open_mode_picker(&mut self) {
        let target = self.picker_target();
        let options = Self::provider_mode_options(&target.provider);
        self.mode_index = self
            .picker_target()
            .provider_mode
            .as_deref()
            .and_then(|mode| options.iter().position(|candidate| *candidate == mode))
            .unwrap_or(0);
        self.overlay = Some(Overlay::ModePicker);
    }

    fn open_effort_picker(&mut self) {
        let target = self.picker_target();
        let options = Self::effort_options(&target.provider, &target.model);
        self.effort_index = self
            .picker_target()
            .thinking_effort
            .as_deref()
            .and_then(|effort| options.iter().position(|candidate| *candidate == effort))
            .unwrap_or(0);
        self.overlay = Some(Overlay::EffortPicker);
    }

    fn handle_llm_picker_key(&mut self, key: KeyEvent) -> Option<Command> {
        match key.code {
            KeyCode::Esc => {
                self.overlay = if self.picker_agent_name.is_some() {
                    Some(Overlay::AgentManager)
                } else {
                    None
                };
                None
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if self.llm_index > 0 {
                    self.llm_index -= 1;
                }
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.llm_index + 1 < self.llm_options.len() {
                    self.llm_index += 1;
                }
                None
            }
            KeyCode::Enter => {
                if self.llm_options.is_empty() {
                    self.overlay = if self.picker_agent_name.is_some() {
                        Some(Overlay::AgentManager)
                    } else {
                        None
                    };
                    return None;
                }
                let selected = &self.llm_options[self.llm_index];
                let new_target = ExecutionTarget {
                    provider: selected.provider.clone(),
                    model: selected.model.clone(),
                    provider_mode: default_provider_mode(&selected.provider).map(str::to_string),
                    thinking_effort: default_thinking_effort(&selected.provider)
                        .map(str::to_string),
                };
                if let Some(agent_name) = self.picker_agent_name.clone() {
                    if let Some(registry) = self.conversation.agents.as_mut() {
                        if let Some(agent) = registry.by_name_mut(&agent_name) {
                            agent.target = new_target;
                        }
                    }
                    self.overlay = Some(Overlay::AgentManager);
                    return Some(Command::SaveConversation(self.conversation.clone()));
                }
                self.overlay = None;
                self.apply_target_switch(new_target)
            }
            _ => None,
        }
    }

    fn handle_mode_picker_key(&mut self, key: KeyEvent) -> Option<Command> {
        match key.code {
            KeyCode::Esc => {
                self.overlay = if self.picker_agent_name.is_some() {
                    Some(Overlay::AgentManager)
                } else {
                    None
                };
                None
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if self.mode_index > 0 {
                    self.mode_index -= 1;
                }
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                let provider = self.picker_target().provider.clone();
                if self.mode_index + 1 < Self::provider_mode_options(&provider).len() {
                    self.mode_index += 1;
                }
                None
            }
            KeyCode::Enter => {
                let provider = self.picker_target().provider.clone();
                let model = self.picker_target().model.clone();
                let effort = self.picker_target().thinking_effort.clone();
                let mode = Self::provider_mode_options(&provider)
                    .get(self.mode_index)
                    .copied();
                let new_target = ExecutionTarget {
                    provider,
                    model,
                    provider_mode: mode.map(str::to_string),
                    thinking_effort: effort,
                };
                if let Some(agent_name) = self.picker_agent_name.clone() {
                    if let Some(registry) = self.conversation.agents.as_mut() {
                        if let Some(agent) = registry.by_name_mut(&agent_name) {
                            agent.target = new_target;
                        }
                    }
                    self.overlay = Some(Overlay::AgentManager);
                    return Some(Command::SaveConversation(self.conversation.clone()));
                }
                self.overlay = None;
                self.apply_target_switch(new_target)
            }
            _ => None,
        }
    }

    fn handle_effort_picker_key(&mut self, key: KeyEvent) -> Option<Command> {
        match key.code {
            KeyCode::Esc => {
                self.overlay = if self.picker_agent_name.is_some() {
                    Some(Overlay::AgentManager)
                } else {
                    None
                };
                None
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if self.effort_index > 0 {
                    self.effort_index -= 1;
                }
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                let provider = self.picker_target().provider.clone();
                let model = self.picker_target().model.clone();
                if self.effort_index + 1 < Self::effort_options(&provider, &model).len() {
                    self.effort_index += 1;
                }
                None
            }
            KeyCode::Enter => {
                let provider = self.picker_target().provider.clone();
                let model = self.picker_target().model.clone();
                let mode = self.picker_target().provider_mode.clone();
                let effort = Self::effort_options(&provider, &model)
                    .get(self.effort_index)
                    .copied();
                let new_target = ExecutionTarget {
                    provider,
                    model,
                    provider_mode: mode,
                    thinking_effort: effort.map(str::to_string),
                };
                if let Some(agent_name) = self.picker_agent_name.clone() {
                    if let Some(registry) = self.conversation.agents.as_mut() {
                        if let Some(agent) = registry.by_name_mut(&agent_name) {
                            agent.target = new_target;
                        }
                    }
                    self.overlay = Some(Overlay::AgentManager);
                    return Some(Command::SaveConversation(self.conversation.clone()));
                }
                self.overlay = None;
                self.apply_target_switch(new_target)
            }
            _ => None,
        }
    }

    fn handle_handoff_prompt_key(&mut self, key: KeyEvent) -> Option<Command> {
        match key.code {
            KeyCode::Esc => {
                // Cancel handoff, keep current target
                self.handoff = None;
                self.overlay = None;
                None
            }
            KeyCode::Up | KeyCode::Down => {
                // Toggle between Summary and Fresh
                if let Some(hs) = &mut self.handoff {
                    hs.selected = match hs.selected {
                        HandoffMode::Summary => HandoffMode::Fresh,
                        HandoffMode::Fresh => HandoffMode::Summary,
                    };
                }
                None
            }
            KeyCode::Enter => {
                let hs = match self.handoff.take() {
                    Some(hs) => hs,
                    None => {
                        self.overlay = None;
                        return None;
                    }
                };

                self.overlay = None;

                match hs.selected {
                    HandoffMode::Fresh => {
                        // Immediate switch, no handoff
                        self.conversation.default_target = hs.new_target;
                        self.conversation.messages.push(ChatMessage::system(
                            "[Switched provider — fresh context]".to_string(),
                        ));
                        if self.auto_scroll {
                            self.scroll_to_bottom();
                        }
                        Some(Command::SaveConversation(self.conversation.clone()))
                    }
                    HandoffMode::Summary => {
                        // Start handoff generation
                        self.handoff = Some(HandoffState {
                            selected: HandoffMode::Summary,
                            new_target: hs.new_target,
                        });
                        self.conversation
                            .messages
                            .push(ChatMessage::system("[Generating handoff...]".to_string()));
                        if self.auto_scroll {
                            self.scroll_to_bottom();
                        }
                        self.generate_handoff_command()
                    }
                }
            }
            _ => None,
        }
    }

    fn handle_conversation_switcher_key(&mut self, key: KeyEvent) -> Option<Command> {
        match key.code {
            KeyCode::Esc => {
                self.overlay = None;
                None
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if self.switcher_index > 0 {
                    self.switcher_index -= 1;
                }
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.switcher_index + 1 < self.conversations.len() {
                    self.switcher_index += 1;
                }
                None
            }
            KeyCode::Enter => {
                if self.conversations.is_empty() {
                    self.overlay = None;
                    return None;
                }
                let selected = self.conversations[self.switcher_index].clone();
                self.overlay = None;

                // Check for cwd mismatch
                if selected.cwd != self.cwd {
                    // Open anyway but warn
                    self.conversation = selected;
                    self.conversation.messages.push(ChatMessage::system(format!(
                        "[Warning: this conversation was created in {}]",
                        self.conversation.cwd.display()
                    )));
                } else {
                    self.conversation = selected;
                }
                self.scroll_offset = 0;
                self.auto_scroll = true;
                self.scroll_to_bottom();
                None
            }
            // Ctrl+D within the switcher to delete the selected conversation
            KeyCode::Char('d') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                if !self.conversations.is_empty() {
                    let id = self.conversations[self.switcher_index].id;
                    self.pending_delete = Some(DeleteTarget::Conversation(id));
                    self.overlay = Some(Overlay::ConfirmDelete);
                }
                None
            }
            // Ctrl+N to create new conversation from within the switcher
            KeyCode::Char('n') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.overlay = None;
                self.new_conversation()
            }
            _ => None,
        }
    }

    fn handle_confirm_delete_key(&mut self, key: KeyEvent) -> Option<Command> {
        match key.code {
            KeyCode::Esc | KeyCode::Char('n') => {
                self.pending_delete = None;
                self.overlay = None;
                None
            }
            KeyCode::Char('y') | KeyCode::Enter => {
                let target = match self.pending_delete.take() {
                    Some(target) => target,
                    None => DeleteTarget::CurrentConversation,
                };

                let id = match target {
                    DeleteTarget::CurrentConversation => {
                        let id = self.conversation.id;
                        let target = self.conversation.default_target.clone();
                        self.conversation = Conversation::new(self.cwd.clone(), target);
                        self.scroll_offset = 0;
                        self.auto_scroll = true;
                        id
                    }
                    DeleteTarget::Conversation(id) => {
                        if id == self.conversation.id {
                            let target = self.conversation.default_target.clone();
                            self.conversation = Conversation::new(self.cwd.clone(), target);
                            self.scroll_offset = 0;
                            self.auto_scroll = true;
                        }

                        if let Some(idx) = self.conversations.iter().position(|conv| conv.id == id)
                        {
                            self.conversations.remove(idx);
                            if self.switcher_index >= self.conversations.len()
                                && self.switcher_index > 0
                            {
                                self.switcher_index -= 1;
                            }
                        }

                        id
                    }
                };

                self.overlay = None;
                Some(Command::DeleteConversation { id })
            }
            _ => None,
        }
    }

    /// Dispatch the next queued message. The user message is already in the
    /// conversation — we just need to add the assistant placeholder and
    /// build the send command.
    fn dispatch_next_queued(&mut self) -> Option<Command> {
        let mut attempts = self.pending_messages.len();
        let mut target_agent = None;
        let mut text = None;

        while attempts > 0 {
            let id = *self.pending_messages.first()?;
            self.pending_messages.remove(0);
            let target = self.pending_message_targets.remove(&id).flatten();

            let Some(candidate_text) = self
                .conversation
                .messages
                .iter()
                .find(|m| m.id == id && m.is_queued)
                .map(|m| m.text())
            else {
                attempts -= 1;
                continue;
            };

            if let Some(agent_name) = target.as_ref() {
                if self.is_agent_busy(agent_name) {
                    self.pending_messages.push(id);
                    self.pending_message_targets
                        .insert(id, Some(agent_name.clone()));
                    attempts -= 1;
                    continue;
                }
            } else if self
                .conversation
                .agents
                .as_ref()
                .is_some_and(|r| !r.agents.is_empty())
            {
                let targets = self.multi_agent_targets_for_text(&candidate_text);
                if targets.iter().any(|name| self.is_agent_busy(name)) {
                    self.pending_messages.push(id);
                    self.pending_message_targets.insert(id, None);
                    attempts -= 1;
                    continue;
                }
            }

            let Some(msg) = self
                .conversation
                .messages
                .iter_mut()
                .find(|m| m.id == id && m.is_queued)
            else {
                attempts -= 1;
                continue;
            };

            msg.is_queued = false;
            target_agent = target;
            text = Some(candidate_text);
            break;
        }

        let text = text?;

        if let Some(agent_name) = target_agent {
            return self.dispatch_agent_request(&agent_name, &text, &text);
        }

        if self
            .conversation
            .agents
            .as_ref()
            .is_some_and(|r| !r.agents.is_empty())
        {
            let targets = self.multi_agent_targets_for_text(&text);
            let mut commands = Vec::new();
            for target in targets {
                if let Some(cmd) = self.dispatch_agent_request(&target, &text, &text) {
                    commands.push(cmd);
                }
            }
            if commands.is_empty() {
                return None;
            }
            let first = commands.remove(0);
            self.deferred_commands.extend(commands);
            return Some(first);
        }

        // Add assistant placeholder
        let target = self.conversation.default_target.clone();
        let assistant_msg =
            ChatMessage::assistant(target.provider.clone(), target.model.clone());
        // The assistant starts empty; UI shows thinking indicator for active turns
        self.active_assistant_message_id = Some(assistant_msg.id);
        self.conversation.messages.push(assistant_msg);

        self.auto_scroll = true;
        self.scroll_to_bottom();

        // Build extra options
        let mut extra_options = HashMap::new();
        self.apply_target_options(&target, &mut extra_options);

        let handoff_summary = self.find_pending_handoff();
        if let Some(ref summary) = handoff_summary {
            if target.provider == "claude" {
                extra_options.insert(
                    "append_system_prompt".to_string(),
                    serde_json::Value::String(format!(
                        "Context from previous provider:\n{summary}"
                    )),
                );
            }
        }

        // Check if compaction is needed before sending
        if self.needs_compaction() {
            return self.trigger_compaction();
        }

        let request_id = self.next_request_id;
        self.next_request_id += 1;
        self.active_request = Some((ActiveRequestKind::Message, request_id));
        self.status = Status::StreamingMessage;

        // If we have an active session, send raw message (provider has full context).
        // Otherwise, inject history via build_prompt.
        let prompt = if self.server_session_id.is_some() {
            text.clone()
        } else {
            let mut p = self.build_prompt(&text);
            if let Some(summary) = handoff_summary {
                if target.provider != "claude" {
                    p = format!("Context from previous provider:\n{summary}\n\n{p}");
                }
            }
            p
        };

        let session_id = self.server_session_id.clone();

        Some(Command::SendMessage {
            prompt,
            provider: target.provider,
            model: target.model,
            cwd: self.cwd.to_string_lossy().to_string(),
            session_id,
            extra_options,
            request_id,
        })
    }

    /// Check if the conversation needs compaction before the next message.
    /// Only applies to Codex (Claude handles its own context management).
    fn needs_compaction(&self) -> bool {
        let provider = &self.conversation.default_target.provider;
        // Claude has native context management — skip
        if provider == "claude" {
            return false;
        }

        if let (Some(tokens), Some(window)) = (self.last_input_tokens, self.context_window) {
            if window > 0 {
                return tokens as f64 > window as f64 * COMPACTION_THRESHOLD;
            }
        }

        // Fallback: estimate from message character count (~4 chars per token, 128k default window)
        let total_chars: usize = self
            .conversation
            .messages
            .iter()
            .map(|m| m.text().len())
            .sum();
        let estimated_tokens = total_chars / 4;
        let default_window = 128_000u64;
        estimated_tokens as f64 > default_window as f64 * COMPACTION_THRESHOLD
    }

    /// Trigger a compaction: summarize the conversation and start a fresh session.
    fn trigger_compaction(&mut self) -> Option<Command> {
        let target = self.conversation.default_target.clone();

        // Build a summary prompt from the full conversation
        let mut history_text = String::new();
        for msg in &self.conversation.messages {
            let t = msg.text();
            match msg.role {
                Role::User => {
                    history_text.push_str(&format!("User: {}\n\n", t.trim()));
                }
                Role::Assistant => {
                    history_text.push_str(&format!(
                        "{}: {}\n\n",
                        msg.display_name(),
                        t.trim()
                    ));
                }
                Role::System if msg.is_handoff => {
                    history_text
                        .push_str(&format!("[Context summary]: {}\n\n", t.trim()));
                }
                _ => {}
            }
        }

        let prompt = format!(
            "Summarize the following conversation concisely. Preserve key decisions, \
             code changes, file paths, current task state, and any important context \
             needed to continue the work. Be thorough but compact.\n\n{history_text}"
        );

        self.conversation
            .messages
            .push(ChatMessage::system("[Compacting context...]".to_string()));
        if self.auto_scroll {
            self.scroll_to_bottom();
        }

        let mut extra_options = HashMap::new();
        self.apply_target_options(&target, &mut extra_options);

        let request_id = self.next_request_id;
        self.next_request_id += 1;
        self.active_request = Some((ActiveRequestKind::Compaction, request_id));
        self.status = Status::StreamingHandoff; // Reuse handoff status

        Some(Command::SendCompaction {
            prompt,
            provider: target.provider,
            model: target.model,
            cwd: self.cwd.to_string_lossy().to_string(),
            extra_options,
            request_id,
        })
    }

    fn apply_target_options(
        &self,
        target: &ExecutionTarget,
        extra_options: &mut HashMap<String, serde_json::Value>,
    ) {
        if let Some(effort) = target.thinking_effort.as_ref() {
            if target.provider == "claude" {
                extra_options.insert(
                    "effort".to_string(),
                    serde_json::Value::String(effort.clone()),
                );
            } else if target.provider == "codex" {
                extra_options.insert(
                    "model_reasoning_effort".to_string(),
                    serde_json::Value::String(effort.clone()),
                );
            }
        }

        if let Some(mode) = target.provider_mode.as_ref() {
            if target.provider == "claude" {
                extra_options.insert(
                    "permission_mode".to_string(),
                    serde_json::Value::String(mode.clone()),
                );
            } else if target.provider == "codex" {
                extra_options.insert(
                    "sandbox".to_string(),
                    serde_json::Value::String(mode.clone()),
                );
            }
        }
    }

    fn reset_input(&mut self) {
        self.input = TextArea::default();
        self.input.set_placeholder_text(self.input_placeholder());
        self.input
            .set_cursor_line_style(ratatui::style::Style::default());
        self.input.set_cursor_style(
            ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::REVERSED),
        );
    }

    fn send_message(&mut self) -> Option<Command> {
        let lines: Vec<String> = self.input.lines().to_vec();
        let text = lines.join("\n").trim().to_string();

        if text.is_empty() {
            return None;
        }

        // Clear pending question since user is sending a message
        self.pending_question = None;

        // Clear input
        self.reset_input();

        // If streaming, queue the message for later dispatch (grayed out)
        if self.is_busy() {
            self.queue_pending_user_message(text, None);
            return None;
        }

        // Multi-agent mode: route to mentioned agents or last active.
        if self
            .conversation
            .agents
            .as_ref()
            .is_some_and(|registry| !registry.agents.is_empty())
        {
            let target_names = self.multi_agent_targets_for_text(&text);
            if target_names.is_empty() {
                return None;
            }

            self.conversation
                .messages
                .push(ChatMessage::user(text.clone()));
            self.auto_scroll = true;

            let mut commands: Vec<Command> = Vec::new();
            for target_name in &target_names {
                if self.is_agent_busy(target_name) {
                    self.queue_pending_user_message(text.clone(), Some(target_name.clone()));
                    continue;
                }
                if let Some(cmd) = self.dispatch_agent_request(target_name, &text, &text) {
                    commands.push(cmd);
                }
            }
            let primary_target = target_names.first().cloned();

            if let Some(registry) = self.conversation.agents.as_mut() {
                if let Some(first_target) = primary_target.as_ref() {
                    if let Some(index) = registry.index_of(first_target) {
                        registry.last_active = index;
                    }
                }
            }

            self.scroll_to_bottom();
            if commands.is_empty() {
                return None;
            }
            let first = commands.remove(0);
            self.deferred_commands.extend(commands);
            return Some(first);
        }

        // Add user message
        self.conversation
            .messages
            .push(ChatMessage::user(text.clone()));

        // Add assistant placeholder
        let target = self.conversation.default_target.clone();
        let assistant_msg =
            ChatMessage::assistant(target.provider.clone(), target.model.clone());
        // The assistant starts empty; UI shows thinking indicator for active turns
        self.active_assistant_message_id = Some(assistant_msg.id);
        self.conversation.messages.push(assistant_msg);

        self.auto_scroll = true;
        self.scroll_to_bottom();

        // Build extra options based on intent
        let mut extra_options = HashMap::new();
        self.apply_target_options(&target, &mut extra_options);

        // Inject handoff summary if the most recent handoff message exists
        // and no user/assistant turn has happened since it
        let handoff_summary = self.find_pending_handoff();
        if let Some(ref summary) = handoff_summary {
            if target.provider == "claude" {
                // Claude supports append_system_prompt
                extra_options.insert(
                    "append_system_prompt".to_string(),
                    serde_json::Value::String(format!(
                        "Context from previous provider:\n{summary}"
                    )),
                );
            }
        }

        let request_id = self.next_request_id;
        self.next_request_id += 1;
        self.active_request = Some((ActiveRequestKind::Message, request_id));
        self.status = Status::StreamingMessage;

        // After handoff, session was cleared; use build_prompt with history
        let mut prompt = self.build_prompt(&text);

        if let Some(summary) = handoff_summary {
            if target.provider != "claude" {
                prompt = format!("Context from previous provider:\n{summary}\n\n{prompt}");
            }
        }

        let session_id = self.server_session_id.clone();

        Some(Command::SendMessage {
            prompt,
            provider: target.provider,
            model: target.model,
            cwd: self.cwd.to_string_lossy().to_string(),
            session_id,
            extra_options,
            request_id,
        })
    }

    /// Find a pending handoff summary that hasn't been consumed yet.
    /// A handoff is "pending" if the only user/assistant messages after it
    /// are the ones we just added (current user + assistant placeholder = 2).
    fn find_pending_handoff(&self) -> Option<String> {
        // Walk backwards through messages counting user/assistant turns
        // until we hit a handoff message
        let mut user_assistant_count = 0u32;
        for msg in self.conversation.messages.iter().rev() {
            if matches!(msg.role, Role::User | Role::Assistant) {
                user_assistant_count += 1;
            }
            if msg.role == Role::System && msg.is_handoff {
                // The current send just added 1 user + 1 assistant placeholder = 2
                // If we've seen more than 2, the handoff was already consumed
                return if user_assistant_count <= 2 {
                    Some(msg.text())
                } else {
                    None
                };
            }
        }
        None
    }

    fn new_conversation(&mut self) -> Option<Command> {
        let old_conversation = self.conversation.clone();
        let should_save = !old_conversation.messages.is_empty();
        let target = self.conversation.default_target.clone();
        self.conversation = Conversation::new(self.cwd.clone(), target);
        self.scroll_offset = 0;
        self.auto_scroll = true;
        self.server_session_id = None;
        self.last_input_tokens = None;
        self.context_window = None;
        self.active_requests.clear();
        self.active_assistant_ids.clear();
        self.request_agent_map.clear();
        self.pending_messages.clear();
        self.pending_message_targets.clear();
        self.deferred_commands.clear();
        if should_save {
            Some(Command::SaveConversation(old_conversation))
        } else {
            None
        }
    }

    /// Cancel the active stream. Returns true if a stream was actually cancelled,
    /// so the caller can trigger a save.
    pub fn cancel_stream(&mut self) -> bool {
        if self.is_busy() {
            self.status = Status::Idle;
            self.active_request = None;
            self.active_assistant_message_id = None;
            self.active_requests.clear();
            self.active_assistant_ids.clear();
            self.request_agent_map.clear();
            self.pending_messages.clear();
            self.pending_message_targets.clear();
            self.deferred_commands.clear();
            // Mark last assistant message as interrupted
            if let Some(msg) = self.active_assistant_message_mut() {
                if msg.role == Role::Assistant {
                    msg.interrupted = true;
                    if !msg.has_text() {
                        msg.push_text("[interrupted]");
                    } else {
                        msg.push_text("\n[interrupted]");
                    }
                }
            }
            self.conversation.touch();
            true
        } else {
            false
        }
    }

    /// Build the prompt with transcript context for the current message.
    /// If this is the first message, send it raw. Otherwise, inject a
    /// bounded window of prior turns.
    ///
    /// Includes:
    /// - User/Assistant messages with provider/model labels
    /// - Handoff summaries (System messages with is_handoff)
    /// - Truncation notice when the window is bounded
    fn build_prompt(&self, current_message: &str) -> String {
        // Collect contextually relevant messages (excluding latest user + assistant placeholder)
        let relevant: Vec<&ChatMessage> = self
            .conversation
            .messages
            .iter()
            .filter(|m| match m.role {
                Role::User | Role::Assistant => m.has_text(),
                Role::System => m.is_handoff,
                _ => false,
            })
            .collect();

        // Skip the last entry which is the current user message we just added
        let history: Vec<&ChatMessage> = if relevant.len() > 1 {
            relevant[..relevant.len() - 1].to_vec()
        } else {
            Vec::new()
        };

        // If no prior history, send the message as-is
        if history.is_empty() {
            return current_message.to_string();
        }

        // Build a bounded window (last ~10 turns or ~4000 chars)
        let mut context_parts: Vec<String> = Vec::new();
        let mut total_chars = 0usize;
        let max_chars = 4000;
        let max_turns = 10;
        let mut truncated = false;

        for msg in history.iter().rev().take(max_turns) {
            let t = msg.text();
            let part = match msg.role {
                Role::User => format!("User: {}", t.trim()),
                Role::Assistant => format!("{}: {}", msg.display_name(), t.trim()),
                Role::System if msg.is_handoff => {
                    format!("[Handoff summary]: {}", t.trim())
                }
                _ => continue,
            };
            total_chars += part.len();
            if total_chars > max_chars && !context_parts.is_empty() {
                truncated = true;
                break;
            }
            context_parts.push(part);
        }

        // Check if we skipped older messages
        if history.len() > max_turns {
            truncated = true;
        }

        context_parts.reverse();

        let mut preamble = String::from("Given this conversation so far");
        if truncated {
            preamble.push_str(" (earlier messages omitted for brevity)");
        }
        preamble.push_str(":\n\n");

        format!(
            "{preamble}{}\n\nUser: {current_message}",
            context_parts.join("\n\n")
        )
    }

    /// Decide whether a target switch needs handoff or can be immediate.
    fn apply_target_switch(&mut self, new_target: ExecutionTarget) -> Option<Command> {
        let current = &self.conversation.default_target;

        // Same target — no-op
        if current.provider == new_target.provider
            && current.model == new_target.model
            && current.provider_mode == new_target.provider_mode
            && current.thinking_effort == new_target.thinking_effort
        {
            return None;
        }

        let provider_changed =
            current.provider != new_target.provider || current.model != new_target.model;
        let has_history = self
            .conversation
            .messages
            .iter()
            .any(|m| matches!(m.role, Role::User | Role::Assistant));
        self.conversation.default_target = new_target.clone();

        // Clamp effort if it's not valid for the new model
        if let Some(effort) = self.conversation.default_target.thinking_effort.as_deref() {
            let valid = Self::effort_options(
                &self.conversation.default_target.provider,
                &self.conversation.default_target.model,
            );
            if !valid.contains(&effort) {
                // Fall back to the highest valid effort
                self.conversation.default_target.thinking_effort =
                    valid.last().map(|s| s.to_string());
            }
        }

        // Reset session when provider/model changes (session is provider-specific)
        if provider_changed {
            self.server_session_id = None;
            self.last_input_tokens = None;
            self.context_window = None;
        }

        if has_history {
            let event = format!("[→ {}]", Self::target_summary(&new_target));
            self.conversation.messages.push(ChatMessage::system(event));
            if self.auto_scroll {
                self.scroll_to_bottom();
            }
        }

        Some(Command::SaveConversation(self.conversation.clone()))
    }

    /// Build the command to send a handoff prompt to the outgoing model.
    fn generate_handoff_command(&mut self) -> Option<Command> {
        let current = &self.conversation.default_target;
        let provider = current.provider.clone();
        let model = current.model.clone();

        let cwd_display = self.cwd.display();
        let handoff_prompt = format!(
            "Summarize the current state of this conversation in one paragraph. \
            The workspace is {cwd_display}. Include: what the user's goal is, \
            what has been done so far, what decisions were made, any relevant files \
            or artifacts, and what the immediate next step is."
        );

        let mut extra_options = HashMap::new();
        extra_options.insert("max_turns".to_string(), serde_json::Value::Number(1.into()));

        let request_id = self.next_request_id;
        self.next_request_id += 1;
        self.active_request = Some((ActiveRequestKind::Handoff, request_id));
        self.status = Status::StreamingHandoff;

        // Build the prompt with transcript context so the outgoing model
        // has the conversation to summarize
        let prompt = self.build_prompt(&handoff_prompt);

        Some(Command::SendHandoff {
            prompt,
            provider,
            model,
            cwd: self.cwd.to_string_lossy().to_string(),
            extra_options,
            request_id,
        })
    }

    /// Build the flat list of LLM options from known providers/models.
    pub fn build_llm_options(&mut self) {
        let mut options = Vec::new();

        // Use server-provided providers if available, otherwise defaults
        let provider_ids: Vec<String> = if self.available_providers.is_empty() {
            vec!["claude".to_string(), "codex".to_string()]
        } else {
            self.available_providers
                .iter()
                .map(|p| p.id.clone())
                .collect()
        };

        for provider_id in &provider_ids {
            let models = known_models(provider_id);
            if models.is_empty() {
                // Unknown provider — add with a placeholder model
                options.push(LlmOption {
                    provider: provider_id.clone(),
                    model: "default".to_string(),
                });
            } else {
                for &model in models {
                    options.push(LlmOption {
                        provider: provider_id.clone(),
                        model: model.to_string(),
                    });
                }
            }
        }

        self.llm_options = options;
    }

    pub fn scroll_to_bottom(&mut self) {
        self.scroll_offset = self.max_scroll();
    }

    fn max_scroll(&self) -> u16 {
        self.content_height.saturating_sub(self.viewport_height)
    }
}

fn summarize_agent_event(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        serde_json::Value::Object(map) => {
            for key in [
                "message",
                "text",
                "detail",
                "description",
                "status",
                "reason",
            ] {
                if let Some(serde_json::Value::String(text)) = map.get(key) {
                    if !text.trim().is_empty() {
                        return Some(text.clone());
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn pretty_json_or_text(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// Returns true if the tool name represents an agent/subagent invocation.
fn is_agent_tool(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "agent"
        || lower == "task"
        || lower.contains("subagent")
        || lower.contains("dispatch_agent")
        || lower.contains("spawn_agent")
        || lower.contains("launch_agent")
}

/// Extract a human-readable label from agent tool input.
fn extract_agent_label(input: &Option<serde_json::Value>) -> String {
    input
        .as_ref()
        .and_then(|v| v.get("description"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            input
                .as_ref()
                .and_then(|v| v.get("prompt"))
                .and_then(|v| v.as_str())
                .map(|s| if s.len() > 40 { &s[..40] } else { s })
        })
        .unwrap_or("Agent")
        .to_string()
}

/// Returns true if the tool name is a workgroup MCP tool that represents
/// a per-agent interaction (message). These get C-shape sections.
fn is_workgroup_agent_tool(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    // Match both direct "workgroup_message" and MCP-prefixed "mcp__0x0-workgroup__workgroup_message".
    lower.contains("workgroup_message")
}

/// Returns true if the tool name is workgroup_open.
fn is_workgroup_open_tool(name: &str) -> bool {
    name.to_ascii_lowercase().contains("workgroup_open")
}

/// Extract agent name from workgroup_message input.
fn extract_workgroup_agent_label(_name: &str, input: &Option<serde_json::Value>) -> String {
    input
        .as_ref()
        .and_then(|v| v.get("agent_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("agent")
        .to_string()
}

/// Extract all agent names from a workgroup_open input payload.
fn extract_workgroup_open_labels(input: &Option<serde_json::Value>) -> Vec<String> {
    let Some(agents) = input
        .as_ref()
        .and_then(|v| v.get("agents"))
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };

    agents
        .iter()
        .enumerate()
        .map(|(idx, agent)| {
            agent
                .get("name")
                .and_then(|v| v.as_str())
                .filter(|name| !name.trim().is_empty())
                .map(|name| name.to_string())
                .unwrap_or_else(|| format!("agent-{}", idx + 1))
        })
        .collect()
}

fn is_thinking_event(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase().replace(['_', '-', ' '], "");
    matches!(
        normalized.as_str(),
        "thinking" | "thought" | "reasoning" | "reason" | "planning" | "plan"
    )
}

fn default_provider_mode(provider: &str) -> Option<&'static str> {
    match provider {
        "codex" => Some("workspace-write"),
        "claude" => Some("plan"),
        _ => None,
    }
}

fn default_thinking_effort(provider: &str) -> Option<&'static str> {
    match provider {
        "codex" => Some("medium"),
        "claude" => Some("medium"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::AppEvent;

    fn test_app() -> App<'static> {
        App::new("http://localhost:4096".to_string())
    }

    #[test]
    fn workgroup_message_is_c_shape_broadcast_is_not() {
        assert!(is_workgroup_agent_tool("workgroup_message"));
        assert!(is_workgroup_agent_tool(
            "mcp__0x0-workgroup__workgroup_message"
        ));
        assert!(!is_workgroup_agent_tool("workgroup_broadcast"));
        assert!(!is_workgroup_agent_tool(
            "mcp__0x0-workgroup__workgroup_broadcast"
        ));
    }

    #[test]
    fn workgroup_open_extracts_all_agent_labels() {
        let input = Some(serde_json::json!({
            "agents": [
                { "name": "Agent1" },
                { "name": "Agent2" },
                { "name": "" }
            ]
        }));
        let labels = extract_workgroup_open_labels(&input);
        assert_eq!(
            labels,
            vec![
                "Agent1".to_string(),
                "Agent2".to_string(),
                "agent-3".to_string()
            ]
        );
    }

    #[test]
    fn stream_text_delta_appends_to_assistant() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hi".to_string()));
        let assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        app.conversation.messages.push(assistant);
        app.active_request = Some((ActiveRequestKind::Message, 1));
        app.status = Status::StreamingMessage;

        app.handle_event(AppEvent::StreamTextDelta {
            request_id: 1,
            text: "Hello".to_string(),
        });
        assert_eq!(app.conversation.messages.last().unwrap().text(), "Hello");

        app.handle_event(AppEvent::StreamTextDelta {
            request_id: 1,
            text: " world".to_string(),
        });
        assert_eq!(
            app.conversation.messages.last().unwrap().text(),
            "Hello world"
        );
    }

    #[test]
    fn stale_events_ignored() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hi".to_string()));
        let assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        app.conversation.messages.push(assistant);
        app.active_request = Some((ActiveRequestKind::Message, 2));

        app.handle_event(AppEvent::StreamTextDelta {
            request_id: 1,
            text: "stale".to_string(),
        });
        assert!(
            app.conversation.messages.last().unwrap().text().is_empty()
        );
    }

    #[test]
    fn stream_error_cleans_placeholder() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hi".to_string()));
        let assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        app.conversation.messages.push(assistant);
        app.active_request = Some((ActiveRequestKind::Message, 1));
        app.status = Status::StreamingMessage;

        let cmd = app.handle_event(AppEvent::StreamError {
            request_id: 1,
            error: "connection failed".to_string(),
        });

        assert!(matches!(cmd.as_slice(), [Command::SaveConversation(_)]));
        assert_eq!(app.status, Status::Idle);
        assert!(app.active_request.is_none());

        let assistant_msg = &app.conversation.messages[1];
        assert!(assistant_msg.text().is_empty());
        assert!(assistant_msg.is_error);

        let error_msg = &app.conversation.messages[2];
        assert_eq!(error_msg.text(), "connection failed");
    }

    #[test]
    fn stream_done_finalizes() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hi".to_string()));
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        assistant.push_text("response text");
        app.conversation.messages.push(assistant);
        app.active_request = Some((ActiveRequestKind::Message, 1));
        app.status = Status::StreamingMessage;

        let cmd = app.handle_event(AppEvent::StreamDone { request_id: 1 });

        assert!(matches!(cmd.as_slice(), [Command::SaveConversation(_)]));
        assert_eq!(app.status, Status::Idle);
        assert!(app.active_request.is_none());
    }

    #[test]
    fn ask_user_question_appends_activity_without_losing_assistant_target() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hi".to_string()));
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        let assistant_id = assistant.id;
        app.conversation.messages.push(assistant);
        app.active_request = Some((ActiveRequestKind::Message, 1));
        app.active_assistant_message_id = Some(assistant_id);
        app.status = Status::StreamingMessage;

        app.handle_event(AppEvent::StreamAskUserQuestion {
            request_id: 1,
            question: "Choose A or B".to_string(),
            options: Some(vec!["A".to_string(), "B".to_string()]),
        });
        app.handle_event(AppEvent::StreamTextDelta {
            request_id: 1,
            text: "answer".to_string(),
        });

        let assistant_msg = app
            .conversation
            .messages
            .iter()
            .find(|msg| msg.id == assistant_id)
            .unwrap();
        assert_eq!(assistant_msg.text(), "answer");
        assert!(
            assistant_msg
                .blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::Event { name, .. } if name == "ask_user_question"))
        );
    }

    #[test]
    fn exit_plan_mode_shows_approval_prompt() {
        let mut app = test_app();
        let assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        let assistant_id = assistant.id;
        app.conversation.messages.push(assistant);
        app.active_request = Some((ActiveRequestKind::Message, 1));
        app.active_assistant_message_id = Some(assistant_id);
        app.status = Status::StreamingMessage;
        assert_eq!(
            app.conversation.default_target.provider_mode.as_deref(),
            Some("plan")
        );

        app.handle_event(AppEvent::StreamExitPlanMode {
            request_id: 1,
            reason: Some("Need to execute".to_string()),
        });

        // Mode should NOT switch immediately — requires user approval
        assert_eq!(
            app.conversation.default_target.provider_mode.as_deref(),
            Some("plan")
        );
        // Pending question should be set
        assert!(app.pending_question.is_some());
        let pq = app.pending_question.as_ref().unwrap();
        assert_eq!(pq.entries[0].options, vec!["Approve", "Reject"]);
        // Event block should be present
        assert!(
            app.conversation
                .messages
                .iter()
                .filter(|msg| msg.role == Role::Assistant)
                .flat_map(|msg| msg.blocks.iter())
                .any(|b| matches!(b, ContentBlock::Event { name, .. } if name == "exit_plan_mode"))
        );
    }

    #[test]
    fn thinking_agent_event_updates_assistant_preview() {
        let mut app = test_app();
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        let assistant_id = assistant.id;
        app.conversation.messages.push(assistant);
        app.active_request = Some((ActiveRequestKind::Message, 1));
        app.active_assistant_message_id = Some(assistant_id);
        app.status = Status::StreamingMessage;

        app.handle_event(AppEvent::StreamAgentEvent {
            request_id: 1,
            name: "thinking".to_string(),
            data: Some(serde_json::json!({
                "text": "one two three four five six seven eight nine ten eleven twelve"
            })),
        });

        let assistant_msg = app
            .conversation
            .messages
            .iter()
            .find(|msg| msg.id == assistant_id)
            .unwrap();
        assert_eq!(
            assistant_msg.last_thinking_preview(10).as_deref(),
            Some("...three four five six seven eight nine ten eleven twelve")
        );
    }

    #[test]
    fn cancel_stream_marks_interrupted() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hi".to_string()));
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        assistant.push_text("partial");
        app.conversation.messages.push(assistant);
        app.status = Status::StreamingMessage;
        app.active_request = Some((ActiveRequestKind::Message, 1));

        let was_streaming = app.cancel_stream();
        assert!(was_streaming);
        assert_eq!(app.status, Status::Idle);
        assert!(app.active_request.is_none());

        let msg = app.conversation.messages.last().unwrap();
        assert!(msg.interrupted);
        assert!(msg.text().contains("[interrupted]"));
    }

    #[test]
    fn cancel_thinking_placeholder() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hi".to_string()));
        let assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        app.conversation.messages.push(assistant);
        app.status = Status::StreamingMessage;
        app.active_request = Some((ActiveRequestKind::Message, 1));

        app.cancel_stream();

        let msg = app.conversation.messages.last().unwrap();
        assert_eq!(msg.text(), "[interrupted]");
    }

    #[test]
    fn cancel_when_idle_is_noop() {
        let mut app = test_app();
        assert!(!app.cancel_stream());
    }

    #[test]
    fn build_prompt_first_message_raw() {
        let app = test_app();
        let prompt = app.build_prompt("hello");
        assert_eq!(prompt, "hello");
    }

    #[test]
    fn build_prompt_with_history() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("first".to_string()));
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        assistant.push_text("response");
        app.conversation.messages.push(assistant);
        // Current user message (just added before build_prompt is called)
        app.conversation
            .messages
            .push(ChatMessage::user("second".to_string()));

        let prompt = app.build_prompt("second");
        assert!(prompt.starts_with("Given this conversation so far:"));
        assert!(prompt.contains("User: first"));
        assert!(prompt.contains("claude/sonnet: response"));
        assert!(prompt.ends_with("User: second"));
    }

    // --- Phase 4: Target switching tests ---

    #[test]
    fn llm_options_built_from_defaults() {
        let mut app = test_app();
        app.build_llm_options();
        assert_eq!(app.llm_options.len(), 9);
        assert_eq!(app.llm_options[0].provider, "claude");
        assert_eq!(app.llm_options[0].model, "sonnet");
    }

    #[test]
    fn llm_options_built_from_server_providers() {
        let mut app = test_app();
        app.available_providers = vec![ProviderInfo {
            id: "claude".to_string(),
            name: "Claude".to_string(),
            default_model: None,
        }];
        app.build_llm_options();
        assert_eq!(app.llm_options.len(), 3);
        assert!(app.llm_options.iter().all(|t| t.provider == "claude"));
    }

    #[test]
    fn same_target_switch_is_noop() {
        let mut app = test_app();
        let same = app.conversation.default_target.clone();
        let cmd = app.apply_target_switch(same);
        assert!(cmd.is_none());
    }

    #[test]
    fn same_provider_different_model_immediate_switch() {
        let mut app = test_app();
        let new_target = ExecutionTarget {
            provider: "claude".to_string(),
            model: "opus".to_string(),
            provider_mode: Some("plan".to_string()),
            thinking_effort: Some("medium".to_string()),
        };
        let cmd = app.apply_target_switch(new_target);
        assert!(matches!(cmd.as_slice(), [Command::SaveConversation(_)]));
        assert_eq!(app.conversation.default_target.model, "opus");
    }

    #[test]
    fn same_provider_different_mode_immediate_switch() {
        let mut app = test_app();
        let new_target = ExecutionTarget {
            provider: "claude".to_string(),
            model: "sonnet".to_string(),
            provider_mode: Some("default".to_string()),
            thinking_effort: Some("medium".to_string()),
        };
        let cmd = app.apply_target_switch(new_target);
        assert!(matches!(cmd.as_slice(), [Command::SaveConversation(_)]));
        assert_eq!(
            app.conversation.default_target.provider_mode.as_deref(),
            Some("default")
        );
    }

    #[test]
    fn cross_provider_empty_conversation_immediate() {
        let mut app = test_app();
        // No messages — should switch immediately
        let new_target = ExecutionTarget {
            provider: "codex".to_string(),
            model: "o4-mini".to_string(),
            provider_mode: Some("workspace-write".to_string()),
            thinking_effort: Some("medium".to_string()),
        };
        let cmd = app.apply_target_switch(new_target);
        assert!(matches!(cmd.as_slice(), [Command::SaveConversation(_)]));
        assert_eq!(app.conversation.default_target.provider, "codex");
    }

    #[test]
    fn cross_provider_with_history_adds_switch_event() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hello".to_string()));
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        assistant.push_text("hi there");
        app.conversation.messages.push(assistant);

        let new_target = ExecutionTarget {
            provider: "codex".to_string(),
            model: "o4-mini".to_string(),
            provider_mode: Some("workspace-write".to_string()),
            thinking_effort: Some("medium".to_string()),
        };
        let cmd = app.apply_target_switch(new_target);

        assert!(matches!(cmd.as_slice(), [Command::SaveConversation(_)]));
        assert_eq!(app.conversation.default_target.provider, "codex");
        let system_msgs: Vec<_> = app
            .conversation
            .messages
            .iter()
            .filter(|m| m.role == Role::System && m.text().starts_with("[→"))
            .collect();
        assert_eq!(system_msgs.len(), 1);
        assert!(system_msgs[0].text().contains("codex/o4-mini"));
    }

    #[test]
    fn handoff_complete_applies_new_target() {
        let mut app = test_app();
        app.handoff = Some(HandoffState {
            selected: HandoffMode::Summary,
            new_target: ExecutionTarget {
                provider: "codex".to_string(),
                model: "o4-mini".to_string(),
                provider_mode: Some("danger-full-access".to_string()),
                thinking_effort: Some("medium".to_string()),
            },
        });
        app.active_request = Some((ActiveRequestKind::Handoff, 7));
        app.status = Status::StreamingHandoff;
        app.conversation
            .messages
            .push(ChatMessage::system("[Generating handoff...]".to_string()));

        let cmd = app.handle_event(AppEvent::HandoffComplete {
            request_id: 7,
            summary: "User wants to build X. Done Y so far.".to_string(),
        });

        assert!(matches!(cmd.as_slice(), [Command::SaveConversation(_)]));
        assert_eq!(app.conversation.default_target.provider, "codex");
        assert_eq!(app.conversation.default_target.model, "o4-mini");
        assert_eq!(app.status, Status::Idle);
        assert!(app.active_request.is_none());
        let handoff_msgs: Vec<_> = app
            .conversation
            .messages
            .iter()
            .filter(|m| m.is_handoff)
            .collect();
        assert_eq!(handoff_msgs.len(), 1);
        assert!(handoff_msgs[0].text().contains("User wants to build X"));
    }

    #[test]
    fn handoff_error_falls_back_to_fresh() {
        let mut app = test_app();
        app.handoff = Some(HandoffState {
            selected: HandoffMode::Summary,
            new_target: ExecutionTarget {
                provider: "codex".to_string(),
                model: "o4-mini".to_string(),
                provider_mode: Some("workspace-write".to_string()),
                thinking_effort: Some("medium".to_string()),
            },
        });
        app.active_request = Some((ActiveRequestKind::Handoff, 8));
        app.status = Status::StreamingHandoff;

        let cmd = app.handle_event(AppEvent::HandoffError {
            request_id: 8,
            error: "timeout".to_string(),
        });

        assert!(matches!(cmd.as_slice(), [Command::SaveConversation(_)]));
        assert_eq!(app.conversation.default_target.provider, "codex");
        assert_eq!(app.status, Status::Idle);
        assert!(app.active_request.is_none());
    }

    #[test]
    fn providers_list_event_builds_options() {
        let mut app = test_app();
        app.handle_event(AppEvent::ProvidersList(vec![
            ProviderInfo {
                id: "claude".to_string(),
                name: "Claude".to_string(),
                default_model: None,
            },
            ProviderInfo {
                id: "codex".to_string(),
                name: "Codex".to_string(),
                default_model: None,
            },
        ]));
        assert_eq!(app.available_providers.len(), 2);
        assert!(!app.llm_options.is_empty());
    }

    #[test]
    fn find_pending_handoff_found() {
        let mut app = test_app();
        // Simulate: handoff happened, then user sends a message
        app.conversation
            .messages
            .push(ChatMessage::handoff("summary text".to_string()));
        app.conversation
            .messages
            .push(ChatMessage::system("[Handoff complete]".to_string()));
        // The current send adds user + assistant placeholder
        app.conversation
            .messages
            .push(ChatMessage::user("next question".to_string()));
        let asst = ChatMessage::assistant("codex".to_string(), "o4-mini".to_string());
        app.conversation.messages.push(asst);

        let result = app.find_pending_handoff();
        assert_eq!(result, Some("summary text".to_string()));
    }

    #[test]
    fn find_pending_handoff_already_consumed() {
        let mut app = test_app();
        // Simulate: handoff happened, one turn completed, then another send
        app.conversation
            .messages
            .push(ChatMessage::handoff("summary text".to_string()));
        app.conversation
            .messages
            .push(ChatMessage::system("[Handoff complete]".to_string()));
        app.conversation
            .messages
            .push(ChatMessage::user("first after handoff".to_string()));
        let mut asst = ChatMessage::assistant("codex".to_string(), "o4-mini".to_string());
        asst.push_text("response");
        app.conversation.messages.push(asst);
        // Now current send
        app.conversation
            .messages
            .push(ChatMessage::user("second question".to_string()));
        let asst2 = ChatMessage::assistant("codex".to_string(), "o4-mini".to_string());
        app.conversation.messages.push(asst2);

        let result = app.find_pending_handoff();
        assert!(result.is_none());
    }

    #[test]
    fn find_pending_handoff_none() {
        let app = test_app();
        assert!(app.find_pending_handoff().is_none());
    }

    // --- Phase 5: Conversation management tests ---

    fn make_conv(cwd: &str, title: &str) -> Conversation {
        let target = ExecutionTarget {
            provider: "claude".to_string(),
            model: "sonnet".to_string(),
            provider_mode: Some("plan".to_string()),
            thinking_effort: Some("medium".to_string()),
        };
        let mut conv = Conversation::new(cwd.into(), target);
        conv.title = title.to_string();
        conv.messages.push(ChatMessage::user(title.to_string()));
        conv
    }

    #[test]
    fn new_conversation_saves_if_has_messages() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hi".to_string()));
        let cmd = app.new_conversation();
        match cmd {
            Some(Command::SaveConversation(saved)) => {
                assert_eq!(saved.messages.len(), 1);
                assert_eq!(saved.messages[0].text(), "hi");
            }
            other => panic!("expected saved conversation, got {other:?}"),
        }
        assert!(app.conversation.messages.is_empty());
    }

    #[test]
    fn new_conversation_skips_save_if_empty() {
        let mut app = test_app();
        let cmd = app.new_conversation();
        assert!(cmd.is_none());
    }

    #[test]
    fn conversations_loaded_populates_list() {
        let mut app = test_app();
        let convs = vec![make_conv("/tmp", "test conv")];
        app.handle_event(AppEvent::ConversationsLoaded(convs));
        assert_eq!(app.conversations.len(), 1);
    }

    #[test]
    fn confirm_delete_yes_emits_command() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hello".to_string()));
        app.conversation.title = "test".to_string();
        app.pending_delete = Some(DeleteTarget::CurrentConversation);
        app.overlay = Some(Overlay::ConfirmDelete);

        let key = KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE);
        let cmd = app.handle_event(AppEvent::Key(key));

        assert!(matches!(
            cmd.as_slice(),
            [Command::DeleteConversation { .. }]
        ));
        assert!(app.overlay.is_none());
        // Should have reset to a fresh conversation
        assert!(app.conversation.messages.is_empty());
    }

    #[test]
    fn confirm_delete_esc_cancels() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hello".to_string()));
        app.pending_delete = Some(DeleteTarget::CurrentConversation);
        app.overlay = Some(Overlay::ConfirmDelete);

        let key = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
        let cmd = app.handle_event(AppEvent::Key(key));

        assert!(cmd.is_empty());
        assert!(app.overlay.is_none());
        // Conversation should still have messages
        assert!(!app.conversation.messages.is_empty());
    }

    #[test]
    fn conversation_switcher_open_selects() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();
        let conv = make_conv(&app.cwd.to_string_lossy(), "target conv");
        let conv_id = conv.id;
        app.conversations = vec![conv];
        app.switcher_index = 0;
        app.overlay = Some(Overlay::ConversationSwitcher);

        let key = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
        app.handle_event(AppEvent::Key(key));

        assert!(app.overlay.is_none());
        assert_eq!(app.conversation.id, conv_id);
    }

    #[test]
    fn conversation_switcher_cwd_mismatch_warns() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();
        let conv = make_conv("/other/path", "other conv");
        app.conversations = vec![conv];
        app.switcher_index = 0;
        app.overlay = Some(Overlay::ConversationSwitcher);

        let key = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
        app.handle_event(AppEvent::Key(key));

        // Should have a warning message
        let warnings: Vec<_> = app
            .conversation
            .messages
            .iter()
            .filter(|m| m.role == Role::System && m.text().contains("Warning"))
            .collect();
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn ctrl_d_blocked_during_streaming() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();
        app.status = Status::StreamingMessage;
        app.active_request = Some((ActiveRequestKind::Message, 1));
        app.conversation
            .messages
            .push(ChatMessage::user("hi".to_string()));

        let key = KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL);
        app.handle_event(AppEvent::Key(key));

        assert!(app.overlay.is_none());
    }

    // --- Phase 6: Context strategy polish tests ---

    #[test]
    fn build_prompt_includes_handoff_summary() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("first".to_string()));
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        assistant.push_text("response");
        app.conversation.messages.push(assistant);
        // Handoff summary
        app.conversation
            .messages
            .push(ChatMessage::handoff("User is building a TUI.".to_string()));
        // Current user message
        app.conversation
            .messages
            .push(ChatMessage::user("continue".to_string()));

        let prompt = app.build_prompt("continue");
        assert!(prompt.contains("[Handoff summary]: User is building a TUI."));
        assert!(prompt.contains("User: first"));
    }

    #[test]
    fn build_prompt_truncation_notice() {
        let mut app = test_app();
        // Add more than 10 turns to trigger truncation
        for i in 0..12 {
            app.conversation
                .messages
                .push(ChatMessage::user(format!("msg {i}")));
            let mut asst = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
            asst.push_text(&format!("reply {i}"));
            app.conversation.messages.push(asst);
        }
        // Current message
        app.conversation
            .messages
            .push(ChatMessage::user("latest".to_string()));

        let prompt = app.build_prompt("latest");
        assert!(prompt.contains("earlier messages omitted"));
    }

    #[test]
    fn same_provider_switch_with_history_adds_switch_event() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hello".to_string()));
        let mut asst = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        asst.push_text("hi");
        app.conversation.messages.push(asst);

        let new_target = ExecutionTarget {
            provider: "claude".to_string(),
            model: "opus".to_string(),
            provider_mode: Some("plan".to_string()),
            thinking_effort: Some("medium".to_string()),
        };
        app.apply_target_switch(new_target);

        let system_msgs: Vec<_> = app
            .conversation
            .messages
            .iter()
            .filter(|m| m.role == Role::System && m.text().starts_with("[→"))
            .collect();
        assert_eq!(system_msgs.len(), 1);
        assert!(system_msgs[0].text().contains("claude/opus"));
    }

    #[test]
    fn mode_switch_with_history_adds_mode_event() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hello".to_string()));
        let mut asst = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        asst.push_text("hi");
        app.conversation.messages.push(asst);

        let new_target = ExecutionTarget {
            provider: "claude".to_string(),
            model: "sonnet".to_string(),
            provider_mode: Some("default".to_string()),
            thinking_effort: Some("medium".to_string()),
        };
        app.apply_target_switch(new_target);

        let system_msgs: Vec<_> = app
            .conversation
            .messages
            .iter()
            .filter(|m| m.role == Role::System && m.text().starts_with("[→"))
            .collect();
        assert_eq!(system_msgs.len(), 1);
        assert!(system_msgs[0].text().contains("Mode: default"));
    }

    #[test]
    fn send_during_streaming_queues_message() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("first".to_string()));
        let asst = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        app.conversation.messages.push(asst);
        app.status = Status::StreamingMessage;
        app.active_request = Some((ActiveRequestKind::Message, 1));

        app.input.insert_str("queued msg");
        let key = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
        let cmd = app.handle_event(AppEvent::Key(key));

        assert!(cmd.is_empty());
        assert_eq!(app.pending_messages.len(), 1);
        let user_msgs: Vec<_> = app
            .conversation
            .messages
            .iter()
            .filter(|m| m.role == Role::User)
            .collect();
        assert_eq!(user_msgs.len(), 2);
        assert!(user_msgs[1].is_queued);
        assert_eq!(app.pending_messages[0], user_msgs[1].id);
    }

    #[test]
    fn ctrl_p_opens_command_palette() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();

        let key = KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL);
        let cmd = app.handle_event(AppEvent::Key(key));

        assert!(cmd.is_empty());
        assert_eq!(app.overlay, Some(Overlay::CommandPalette));
    }

    #[test]
    fn ctrl_p_opens_command_palette_while_streaming() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();
        app.status = Status::StreamingMessage;
        app.active_request = Some((ActiveRequestKind::Message, 1));

        let key = KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL);
        let cmd = app.handle_event(AppEvent::Key(key));

        assert!(cmd.is_empty());
        assert_eq!(app.overlay, Some(Overlay::CommandPalette));
    }

    #[test]
    fn ctrl_l_opens_llm_picker() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();

        let key = KeyEvent::new(KeyCode::Char('l'), KeyModifiers::CONTROL);
        let cmd = app.handle_event(AppEvent::Key(key));

        assert!(matches!(cmd.as_slice(), [Command::FetchProviders]));
        assert_eq!(app.overlay, Some(Overlay::LlmPicker));
    }

    #[test]
    fn ctrl_m_opens_mode_picker() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();

        let key = KeyEvent::new(KeyCode::Char('m'), KeyModifiers::CONTROL);
        let cmd = app.handle_event(AppEvent::Key(key));

        assert!(cmd.is_empty());
        assert_eq!(app.overlay, Some(Overlay::ModePicker));
    }

    #[test]
    fn shift_enter_inserts_newline_in_composer() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();
        app.input.insert_str("hello");

        let key = KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT);
        let cmd = app.handle_event(AppEvent::Key(key));

        assert!(cmd.is_empty());
        assert_eq!(app.input.lines().len(), 2);
        assert_eq!(app.input.lines()[0], "hello");
    }

    #[test]
    fn enter_sends_message() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();
        app.input.insert_str("send me");

        let key = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
        let cmd = app.handle_event(AppEvent::Key(key));

        assert!(cmd.iter().any(|c| matches!(c, Command::SendMessage { .. })));
        assert_eq!(app.status, Status::StreamingMessage);
        assert!(app.active_request.is_some());
    }

    #[test]
    fn queued_message_dispatched_on_stream_done() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("first".to_string()));
        let mut asst = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        asst.push_text("response");
        app.conversation.messages.push(asst);
        let queued = ChatMessage::queued("queued".to_string());
        let queued_id = queued.id;
        app.conversation.messages.push(queued);
        app.pending_messages.push(queued_id);
        app.pending_message_targets.insert(queued_id, None);
        app.status = Status::StreamingMessage;
        app.active_request = Some((ActiveRequestKind::Message, 1));

        let cmd = app.handle_event(AppEvent::StreamDone { request_id: 1 });

        assert!(cmd.iter().any(|c| matches!(c, Command::SendMessage { .. })));
        assert!(app.pending_messages.is_empty());
        assert_eq!(app.status, Status::StreamingMessage);

        let queued_msg = app
            .conversation
            .messages
            .iter()
            .find(|m| m.role == Role::User && m.text() == "queued")
            .unwrap();
        assert!(!queued_msg.is_queued);
        assert!(app.pending_message_targets.is_empty());
    }

    #[test]
    fn stale_handoff_events_are_ignored() {
        let mut app = test_app();
        app.handoff = Some(HandoffState {
            selected: HandoffMode::Summary,
            new_target: ExecutionTarget {
                provider: "codex".to_string(),
                model: "o4-mini".to_string(),
                provider_mode: Some("workspace-write".to_string()),
                thinking_effort: Some("medium".to_string()),
            },
        });
        app.active_request = Some((ActiveRequestKind::Handoff, 42));
        app.status = Status::StreamingHandoff;

        let cmd = app.handle_event(AppEvent::HandoffComplete {
            request_id: 41,
            summary: "stale".to_string(),
        });

        assert!(cmd.is_empty());
        assert_eq!(app.status, Status::StreamingHandoff);
        assert_eq!(app.conversation.default_target.provider, "claude");
    }

    #[test]
    fn send_during_handoff_generation_is_queued() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();
        app.status = Status::StreamingHandoff;
        app.active_request = Some((ActiveRequestKind::Handoff, 3));
        app.input.insert_str("queued during handoff");

        let key = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
        let cmd = app.handle_event(AppEvent::Key(key));

        assert!(cmd.is_empty());
        assert_eq!(app.pending_messages.len(), 1);
        assert!(app.conversation.messages.iter().any(|m| m.is_queued));
    }

    #[test]
    fn confirm_delete_current_conversation_ignores_cached_switcher_list() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();
        let other = make_conv("/tmp", "other");
        let other_id = other.id;
        app.conversations = vec![other];
        app.switcher_index = 0;
        app.conversation
            .messages
            .push(ChatMessage::user("current".to_string()));
        let current_id = app.conversation.id;
        app.pending_delete = Some(DeleteTarget::CurrentConversation);
        app.overlay = Some(Overlay::ConfirmDelete);

        let key = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
        let cmd = app.handle_event(AppEvent::Key(key));

        match cmd.as_slice() {
            [Command::DeleteConversation { id }] => assert_eq!(*id, current_id),
            other => panic!("expected delete command, got {other:?}"),
        }
        assert_eq!(app.conversations[0].id, other_id);
    }

    #[test]
    fn duplicate_queued_messages_preserve_order() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("first".to_string()));
        let mut asst = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        asst.push_text("response");
        app.conversation.messages.push(asst);

        let first = ChatMessage::queued("same".to_string());
        let first_id = first.id;
        let second = ChatMessage::queued("same".to_string());
        let second_id = second.id;
        app.conversation.messages.push(first);
        app.conversation.messages.push(second);
        app.pending_messages.push(first_id);
        app.pending_messages.push(second_id);
        app.pending_message_targets.insert(first_id, None);
        app.pending_message_targets.insert(second_id, None);
        app.status = Status::StreamingMessage;
        app.active_request = Some((ActiveRequestKind::Message, 1));

        let cmd = app.handle_event(AppEvent::StreamDone { request_id: 1 });

        assert!(cmd.iter().any(|c| matches!(c, Command::SendMessage { .. })));
        let first_msg = app
            .conversation
            .messages
            .iter()
            .find(|m| m.id == first_id)
            .unwrap();
        let second_msg = app
            .conversation
            .messages
            .iter()
            .find(|m| m.id == second_id)
            .unwrap();
        assert!(!first_msg.is_queued);
        assert!(second_msg.is_queued);
        assert_eq!(app.pending_messages, vec![second_id]);
    }

    #[test]
    fn same_provider_switch_no_history_no_boundary() {
        let mut app = test_app();
        let new_target = ExecutionTarget {
            provider: "claude".to_string(),
            model: "opus".to_string(),
            provider_mode: Some("default".to_string()),
            thinking_effort: Some("medium".to_string()),
        };
        app.apply_target_switch(new_target);

        let system_msgs: Vec<_> = app
            .conversation
            .messages
            .iter()
            .filter(|m| m.role == Role::System)
            .collect();
        assert!(system_msgs.is_empty());
    }

    #[test]
    fn stream_result_updates_agent_context_usage() {
        let mut app = test_app();
        let mut registry = AgentRegistry::new();
        let target = ExecutionTarget {
            provider: "codex".to_string(),
            model: "gpt-5.4".to_string(),
            provider_mode: Some("workspace-write".to_string()),
            thinking_effort: Some("medium".to_string()),
        };
        registry.add(Agent::new("Agent1".to_string(), target));
        app.conversation.agents = Some(registry);
        app.active_requests
            .insert("Agent1".to_string(), (ActiveRequestKind::Message, 7));
        app.request_agent_map.insert(7, "Agent1".to_string());
        app.status = Status::StreamingMessage;

        app.handle_event(AppEvent::StreamResult {
            request_id: 7,
            session_id: None,
            result: None,
            duration_ms: None,
            is_error: Some(false),
            input_tokens: Some(98_000),
            context_window: Some(128_000),
        });

        let reg = app.conversation.agents.as_ref().unwrap();
        let agent = reg.by_name("Agent1").unwrap();
        assert_eq!(agent.last_input_tokens, Some(98_000));
        assert_eq!(agent.context_window, Some(128_000));
        assert_eq!(app.last_input_tokens, None);
        assert_eq!(app.context_window, None);
    }

    #[test]
    fn dispatch_agent_request_compacts_agent_session_when_threshold_crossed() {
        let mut app = test_app();
        let mut registry = AgentRegistry::new();
        let target = ExecutionTarget {
            provider: "codex".to_string(),
            model: "gpt-5.4".to_string(),
            provider_mode: Some("workspace-write".to_string()),
            thinking_effort: Some("medium".to_string()),
        };
        let mut agent = Agent::new("Agent1".to_string(), target);
        agent.server_session_id = Some("session-1".to_string());
        agent.last_input_tokens = Some(100_000);
        agent.context_window = Some(128_000);
        registry.add(agent);
        app.conversation.agents = Some(registry);
        app.conversation
            .messages
            .push(ChatMessage::user("hello".to_string()));

        let cmd = app
            .dispatch_agent_request("Agent1", "follow up", "follow up")
            .expect("agent dispatch should produce command");

        let reg = app.conversation.agents.as_ref().unwrap();
        let updated = reg.by_name("Agent1").unwrap();
        assert_eq!(updated.server_session_id, None);
        assert_eq!(updated.last_input_tokens, None);
        assert_eq!(updated.context_window, None);
        assert!(app
            .conversation
            .messages
            .iter()
            .any(|m| m.role == Role::System && m.text().contains("Context compacted for Agent1")));

        match cmd {
            Command::SendMessage { session_id, .. } => assert_eq!(session_id, None),
            other => panic!("expected send command, got {other:?}"),
        }
    }
}
