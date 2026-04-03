use std::collections::HashMap;
use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use tui_textarea::{Input, Key, TextArea};

use crate::context;
use crate::conversation::Conversation;
use crate::event::{AppEvent, ProviderInfo};
use crate::message::{
    ActivityItem, ActivityKind, ChatMessage, ExecutionTarget, ProviderModeKind, Role, ToolCall,
};

/// Known models per provider. The server doesn't expose a models list,
/// so we maintain a sensible set here.
const CLAUDE_MODELS: &[&str] = &["sonnet", "opus", "haiku"];
const CODEX_MODELS: &[&str] = &["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "o4-mini", "o3"];
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
pub struct ActivityRef {
    pub message_id: uuid::Uuid,
    pub activity_index: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InspectableLine {
    pub line_index: usize,
    pub activity: ActivityRef,
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
    pub available_providers: Vec<ProviderInfo>,
    pub llm_options: Vec<LlmOption>,
    pub llm_index: usize,
    pub mode_index: usize,
    pub effort_index: usize,

    // Handoff state
    pub handoff: Option<HandoffState>,
    pub pending_delete: Option<DeleteTarget>,
    pub inspector_target: Option<ActivityRef>,
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

    // Animation state for thinking indicator
    pub animation_tick: u64,
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
                PaletteCommand::ChooseLlm,
                PaletteCommand::ChooseMode,
                PaletteCommand::ChooseEffort,
                PaletteCommand::OpenConversations,
                PaletteCommand::NewConversation,
                PaletteCommand::DeleteConversation,
                PaletteCommand::ShowHelp,
            ],
            palette_index: 0,
            available_providers: Vec::new(),
            llm_options: Vec::new(),
            llm_index: 0,
            mode_index: 0,
            effort_index: 0,
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
            animation_tick: 0,
        }
    }

    /// Returns the current execution target.
    pub fn target(&self) -> &ExecutionTarget {
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
        self.active_request.is_some()
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
        self.active_request == Some((kind, request_id))
    }

    fn active_assistant_message_mut(&mut self) -> Option<&mut ChatMessage> {
        if let Some(id) = self.active_assistant_message_id {
            return self.conversation.messages.iter_mut().find(|msg| msg.id == id);
        }
        self.conversation
            .messages
            .iter_mut()
            .rev()
            .find(|msg| msg.role == Role::Assistant)
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

        let Some(activity) = message.activities.get(target.activity_index) else {
            return ("Activity".to_string(), "No activity selected.".to_string());
        };

        match activity.kind {
            ActivityKind::ToolUse => {
                if let Some(tool_call) = activity.related_id.as_deref().and_then(|id| {
                    message
                        .tool_calls
                        .iter()
                        .find(|tool| tool.id.as_deref() == Some(id))
                }) {
                    return (
                        activity.title.clone(),
                        format_full_tool_call(tool_call),
                    );
                }
            }
            ActivityKind::ToolResult => {
                if let Some(tool_call) = activity.related_id.as_deref().and_then(|id| {
                    message
                        .tool_calls
                        .iter()
                        .find(|tool| tool.id.as_deref() == Some(id))
                }) {
                    return (
                        activity.title.clone(),
                        format_full_tool_result(tool_call),
                    );
                }
            }
            _ => {}
        }

        (activity.title.clone(), activity.detail.clone())
    }

    /// Process an event and return an optional command.
    pub fn handle_event(&mut self, event: AppEvent) -> Option<Command> {
        match event {
            AppEvent::Key(key) => self.handle_key(key),
            AppEvent::Mouse(mouse) => self.handle_mouse(mouse),
            AppEvent::Resize(_, _) => Some(Command::Redraw),
            AppEvent::Tick => {
                self.animation_tick = self.animation_tick.wrapping_add(1);
                // Only redraw if there's an active animation
                if self.is_busy() || self.show_quit_hint() {
                    Some(Command::Redraw)
                } else {
                    None
                }
            }

            AppEvent::StreamTextDelta { request_id, text } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    if let Some(msg) = self.active_assistant_message_mut() {
                        if msg.content == "[thinking...]" {
                            msg.content.clear();
                        }
                        msg.content.push_str(&text);
                        append_answer_activity(msg, &text);
                    }
                    if self.auto_scroll {
                        self.scroll_to_bottom();
                    }
                }
                None
            }

            AppEvent::StreamToolUse {
                request_id,
                name,
                id,
                input,
            } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    if let Some(msg) = self.active_assistant_message_mut() {
                        let input_text = input.as_ref().map(pretty_json_or_text);
                        msg.tool_calls.push(ToolCall {
                            name: name.clone(),
                            id: id.clone(),
                            input: input_text.clone(),
                            result: None,
                            collapsed: true,
                        });
                        push_activity(
                            msg,
                            ActivityKind::ToolUse,
                            format!("Tool: {name}"),
                            input_text
                                .as_deref()
                                .map(|value| compact_preview_words(value, 14))
                                .unwrap_or_default(),
                            format_tool_use_detail(&name, id.as_deref(), input_text.as_deref()),
                            id,
                        );
                    }
                }
                None
            }

            AppEvent::StreamToolResult {
                request_id,
                tool_use_id,
                content,
            } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    if let Some(msg) = self.active_assistant_message_mut() {
                        let detail = content
                            .as_ref()
                            .map(pretty_json_or_text)
                            .unwrap_or_default();
                        // Look up tool name from matching tool call
                        let tool_name = tool_use_id.as_deref().and_then(|id| {
                            msg.tool_calls
                                .iter()
                                .find(|t| t.id.as_deref() == Some(id))
                                .map(|t| t.name.clone())
                        });
                        if let Some(tc) = tool_use_id.as_deref().and_then(|id| {
                            msg.tool_calls
                                .iter_mut()
                                .find(|t| t.id.as_deref() == Some(id))
                        }) {
                            tc.result = Some(detail.clone());
                        }
                        let title = match tool_name {
                            Some(name) => format!("Tool: {name}"),
                            None => "Tool result".to_string(),
                        };
                        push_activity(
                            msg,
                            ActivityKind::ToolResult,
                            title,
                            compact_preview_words(&detail, 14),
                            format_tool_result_detail(tool_use_id.as_deref(), &detail),
                            tool_use_id,
                        );
                    }
                }
                None
            }

            AppEvent::StreamResult {
                request_id,
                is_error,
                input_tokens,
                context_window,
                ..
            } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    if let Some(msg) = self.active_assistant_message_mut() {
                        if is_error == Some(true) {
                            msg.is_error = true;
                        }
                    }
                    // Track context usage for compaction decisions
                    if let Some(tokens) = input_tokens {
                        self.last_input_tokens = Some(tokens);
                    }
                    if let Some(window) = context_window {
                        self.context_window = Some(window);
                    }
                }
                None
            }

            AppEvent::StreamAskUserQuestion {
                request_id,
                question,
                options,
            } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    let opts = options.clone();
                    if let Some(msg) = self.active_assistant_message_mut() {
                        let mut detail = question.clone();
                        let preview = if let Some(options) = options.filter(|items| !items.is_empty()) {
                            detail.push_str(&format!("\n\nOptions:\n- {}", options.join("\n- ")));
                            options.join(", ")
                        } else {
                            question.clone()
                        };
                        push_activity(
                            msg,
                            ActivityKind::AskUserQuestion,
                            "Question".to_string(),
                            preview,
                            format_question_detail(&detail),
                            None,
                        );
                        if self.auto_scroll {
                            self.scroll_to_bottom();
                        }
                    }
                    // Set up inline question buttons (append to support multiple questions)
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
                None
            }

            AppEvent::StreamExitPlanMode { request_id, reason } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    // Switch away from plan mode to default/execute mode
                    match self.conversation.default_target.provider.as_str() {
                        "claude" => {
                            self.conversation.default_target.provider_mode =
                                Some("default".to_string());
                        }
                        // Codex doesn't have plan mode, but handle generically
                        _ => {
                            self.conversation.default_target.provider_mode =
                                Some("default".to_string());
                        }
                    }
                    if let Some(msg) = self.active_assistant_message_mut() {
                        let detail = reason
                            .clone()
                            .filter(|r| !r.trim().is_empty())
                            .unwrap_or_else(|| "Switched to execute mode.".to_string());
                        push_activity(
                            msg,
                            ActivityKind::ExitPlanMode,
                            "Mode change".to_string(),
                            compact_preview_words(&detail, 14),
                            format!("Exit plan mode\n\n{detail}"),
                            None,
                        );
                        if self.auto_scroll {
                            self.scroll_to_bottom();
                        }
                    }
                }
                None
            }

            AppEvent::StreamAgentEvent {
                request_id,
                name,
                data,
            } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    if is_thinking_event(&name) {
                        if let Some(msg) = self.active_assistant_message_mut() {
                            let text = data
                                .as_ref()
                                .and_then(|d| d.get("text"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            if !text.is_empty() {
                                append_thinking_activity(msg, &text);
                            }
                            // Update the transient thinking preview
                            if let Some(last) = msg.activities.last() {
                                if last.kind == ActivityKind::Thinking {
                                    msg.thinking = Some(tail_words(&last.detail, 10));
                                }
                            }
                        }
                    } else {
                        if let Some(msg) = self.active_assistant_message_mut() {
                            let detail = data
                                .as_ref()
                                .and_then(summarize_agent_event)
                                .unwrap_or_else(|| name.clone());
                            push_activity(
                                msg,
                                ActivityKind::AgentEvent,
                                "Event".to_string(),
                                compact_preview_words(&detail, 14),
                                format_agent_event_detail(&name, data.as_ref(), &detail),
                                None,
                            );
                            if self.auto_scroll {
                                self.scroll_to_bottom();
                            }
                        }
                    }
                }
                None
            }

            AppEvent::StreamError { request_id, error } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    // Fix the assistant placeholder if it's still [thinking...]
                    if let Some(msg) = self.active_assistant_message_mut() {
                        if msg.role == Role::Assistant && msg.content == "[thinking...]" {
                            msg.content.clear();
                            msg.is_error = true;
                        }
                        msg.thinking = None;
                    }
                    self.status = Status::Idle;
                    self.active_request = None;
                    self.active_assistant_message_id = None;
                    self.conversation.messages.push(ChatMessage::error(error));
                    self.conversation.touch();
                    self.conversation.update_title();
                    if self.auto_scroll {
                        self.scroll_to_bottom();
                    }

                    // Dispatch next queued message if any
                    if let Some(cmd) = self.dispatch_next_queued() {
                        return Some(cmd);
                    }
                    return Some(Command::SaveConversation(self.conversation.clone()));
                }
                None
            }

            AppEvent::StreamDone { request_id } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    // Fix the assistant placeholder if stream ended without content
                    if let Some(msg) = self.active_assistant_message_mut() {
                        if msg.role == Role::Assistant && msg.content == "[thinking...]" {
                            msg.content = "[no response]".to_string();
                        }
                        msg.thinking = None;
                    }
                    self.status = Status::Idle;
                    self.active_request = None;
                    self.active_assistant_message_id = None;
                    self.conversation.touch();
                    self.conversation.update_title();

                    // Dispatch next queued message if any
                    if let Some(cmd) = self.dispatch_next_queued() {
                        return Some(cmd);
                    }
                    return Some(Command::SaveConversation(self.conversation.clone()));
                }
                None
            }

            AppEvent::StreamInit {
                request_id,
                session_id,
            } => {
                if self.active_request_matches(ActiveRequestKind::Message, request_id) {
                    if let Some(id) = session_id {
                        self.server_session_id = Some(id);
                    }
                }
                None
            }

            AppEvent::ProvidersList(providers) => {
                self.available_providers = providers;
                self.build_llm_options();
                None
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
                        if msg.role == Role::System && msg.content.contains("Compacting") {
                            self.conversation.messages.pop();
                        }
                    }
                    // Keep only recent messages + add summary
                    let keep_count = 4; // Keep last N user/assistant pairs
                    let mut kept: Vec<ChatMessage> = Vec::new();
                    let recent: Vec<ChatMessage> = self.conversation.messages.iter().rev()
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
                    return Some(Command::SaveConversation(self.conversation.clone()));
                }

                if !self.active_request_matches(ActiveRequestKind::Handoff, request_id) {
                    return None;
                }
                self.status = Status::Idle;
                self.active_request = None;
                // Store the handoff summary as a system message
                if let Some(msg) = self.conversation.messages.last() {
                    if msg.role == Role::System && msg.content.contains("Generating handoff") {
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
                Some(Command::SaveConversation(self.conversation.clone()))
            }

            AppEvent::HandoffError { request_id, error } => {
                // Handle compaction error — just clean up
                if self.active_request_matches(ActiveRequestKind::Compaction, request_id) {
                    self.status = Status::Idle;
                    self.active_request = None;
                    if let Some(msg) = self.conversation.messages.last() {
                        if msg.role == Role::System && msg.content.contains("Compacting") {
                            self.conversation.messages.pop();
                        }
                    }
                    self.conversation.messages.push(ChatMessage::system(format!(
                        "[Compaction failed: {error}]"
                    )));
                    if self.auto_scroll {
                        self.scroll_to_bottom();
                    }
                    return None;
                }

                if !self.active_request_matches(ActiveRequestKind::Handoff, request_id) {
                    return None;
                }
                self.status = Status::Idle;
                self.active_request = None;
                // Remove the [Generating handoff...] message
                if let Some(msg) = self.conversation.messages.last() {
                    if msg.role == Role::System && msg.content.contains("Generating handoff") {
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
                Some(Command::SaveConversation(self.conversation.clone()))
            }

            AppEvent::ConversationsLoaded(convs) => {
                self.conversations = convs;
                None
            }

            AppEvent::ConversationDeleted(_id) => {
                // Deletion confirmed — start fresh
                None
            }

            AppEvent::ApiError(err) => {
                self.conversation.messages.push(ChatMessage::error(err));
                if self.auto_scroll {
                    self.scroll_to_bottom();
                }
                None
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
                if msg.role == Role::System && msg.content.contains("Generating handoff") {
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
                    if self.is_busy() {
                        return None;
                    }
                    self.palette_index = 0;
                    self.overlay = Some(Overlay::CommandPalette);
                    return None;
                }
                KeyCode::Char('l') => {
                    if self.is_busy() {
                        return None;
                    }
                    return self.open_llm_picker();
                }
                KeyCode::Char('m') => {
                    if self.is_busy() {
                        return None;
                    }
                    self.open_mode_picker();
                    return None;
                }
                KeyCode::Char('e') => {
                    if self.is_busy() {
                        return None;
                    }
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
        if self.pending_question.is_some() && !self.is_busy() {
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
                            entry.selected = (entry.selected + 1)
                                .min(entry.options.len().saturating_sub(1));
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
                        pq.current = (pq.current + 1)
                            .min(pq.entries.len().saturating_sub(1));
                    }
                    return None;
                }
                _ => {}
            }
        }

        // Enter sends unless Shift is held.
        if key.code == KeyCode::Enter && !key.modifiers.contains(KeyModifiers::SHIFT) {
            // If pending question and input is empty, send the selected option
            if self.pending_question.is_some() && !self.is_busy() {
                let input_text: String = self.input.lines().join("\n").trim().to_string();
                if input_text.is_empty() {
                    if let Some(pq) = self.pending_question.take() {
                        // Collect selected answer from the current question
                        if let Some(entry) = pq.entries.get(pq.current) {
                            let answer = entry.options.get(entry.selected).cloned().unwrap_or_default();
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

        if mouse.kind != MouseEventKind::Down(MouseButton::Left) {
            return None;
        }

        if mouse.row < self.messages_area_y || mouse.row >= self.messages_area_y + self.viewport_height {
            return None;
        }

        let relative = mouse.row.saturating_sub(self.messages_area_y) as usize;
        let line_index = self.scroll_offset as usize + relative;
        if let Some(target) = self
            .inspectable_lines
            .iter()
            .find(|entry| entry.line_index == line_index)
            .map(|entry| entry.activity)
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
                    Some(PaletteCommand::ChooseLlm) => self.open_llm_picker(),
                    Some(PaletteCommand::ChooseMode) => {
                        self.open_mode_picker();
                        None
                    }
                    Some(PaletteCommand::ChooseEffort) => {
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

    fn open_llm_picker(&mut self) -> Option<Command> {
        if self.llm_options.is_empty() {
            self.build_llm_options();
        }
        self.llm_index = self
            .llm_options
            .iter()
            .position(|t| {
                t.provider == self.conversation.default_target.provider
                    && t.model == self.conversation.default_target.model
            })
            .unwrap_or(0);
        self.overlay = Some(Overlay::LlmPicker);
        if self.available_providers.is_empty() {
            Some(Command::FetchProviders)
        } else {
            None
        }
    }

    fn open_mode_picker(&mut self) {
        let options = Self::provider_mode_options(&self.conversation.default_target.provider);
        self.mode_index = self
            .conversation
            .default_target
            .provider_mode
            .as_deref()
            .and_then(|mode| options.iter().position(|candidate| *candidate == mode))
            .unwrap_or(0);
        self.overlay = Some(Overlay::ModePicker);
    }

    fn open_effort_picker(&mut self) {
        let options = Self::effort_options(
            &self.conversation.default_target.provider,
            &self.conversation.default_target.model,
        );
        self.effort_index = self
            .conversation
            .default_target
            .thinking_effort
            .as_deref()
            .and_then(|effort| options.iter().position(|candidate| *candidate == effort))
            .unwrap_or(0);
        self.overlay = Some(Overlay::EffortPicker);
    }

    fn handle_llm_picker_key(&mut self, key: KeyEvent) -> Option<Command> {
        match key.code {
            KeyCode::Esc => {
                self.overlay = None;
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
                    self.overlay = None;
                    return None;
                }
                let selected = &self.llm_options[self.llm_index];
                let new_target = ExecutionTarget {
                    provider: selected.provider.clone(),
                    model: selected.model.clone(),
                    provider_mode: default_provider_mode(&selected.provider)
                        .map(str::to_string),
                    thinking_effort: default_thinking_effort(&selected.provider)
                        .map(str::to_string),
                };
                self.overlay = None;
                self.apply_target_switch(new_target)
            }
            _ => None,
        }
    }

    fn handle_mode_picker_key(&mut self, key: KeyEvent) -> Option<Command> {
        match key.code {
            KeyCode::Esc => {
                self.overlay = None;
                None
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if self.mode_index > 0 {
                    self.mode_index -= 1;
                }
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.mode_index + 1
                    < Self::provider_mode_options(&self.conversation.default_target.provider).len()
                {
                    self.mode_index += 1;
                }
                None
            }
            KeyCode::Enter => {
                let mode = Self::provider_mode_options(&self.conversation.default_target.provider)
                    .get(self.mode_index)
                    .copied();
                let new_target = ExecutionTarget {
                    provider: self.conversation.default_target.provider.clone(),
                    model: self.conversation.default_target.model.clone(),
                    provider_mode: mode.map(str::to_string),
                    thinking_effort: self.conversation.default_target.thinking_effort.clone(),
                };
                self.overlay = None;
                self.apply_target_switch(new_target)
            }
            _ => None,
        }
    }

    fn handle_effort_picker_key(&mut self, key: KeyEvent) -> Option<Command> {
        match key.code {
            KeyCode::Esc => {
                self.overlay = None;
                None
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if self.effort_index > 0 {
                    self.effort_index -= 1;
                }
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.effort_index + 1
                    < Self::effort_options(
                        &self.conversation.default_target.provider,
                        &self.conversation.default_target.model,
                    ).len()
                {
                    self.effort_index += 1;
                }
                None
            }
            KeyCode::Enter => {
                let effort = Self::effort_options(
                    &self.conversation.default_target.provider,
                    &self.conversation.default_target.model,
                )
                    .get(self.effort_index)
                    .copied();
                let new_target = ExecutionTarget {
                    provider: self.conversation.default_target.provider.clone(),
                    model: self.conversation.default_target.model.clone(),
                    provider_mode: self.conversation.default_target.provider_mode.clone(),
                    thinking_effort: effort.map(str::to_string),
                };
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
        let queued_id = *self.pending_messages.first()?;
        self.pending_messages.remove(0);

        // Promote the queued message by stable identity.
        let text = if let Some(msg) = self
            .conversation
            .messages
            .iter_mut()
            .find(|m| m.id == queued_id && m.is_queued)
        {
            msg.is_queued = false;
            msg.content.clone()
        } else {
            return self.dispatch_next_queued();
        };

        // Add assistant placeholder
        let target = self.conversation.default_target.clone();
        let mut assistant_msg =
            ChatMessage::assistant(target.provider.clone(), target.model.clone());
        assistant_msg.content = "[thinking...]".to_string();
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
            .map(|m| m.content.len())
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
            match msg.role {
                Role::User => {
                    history_text.push_str(&format!("User: {}\n\n", msg.content.trim()));
                }
                Role::Assistant => {
                    history_text.push_str(&format!(
                        "{}: {}\n\n",
                        msg.display_name(),
                        msg.content.trim()
                    ));
                }
                Role::System if msg.is_handoff => {
                    history_text.push_str(&format!(
                        "[Context summary]: {}\n\n",
                        msg.content.trim()
                    ));
                }
                _ => {}
            }
        }

        let prompt = format!(
            "Summarize the following conversation concisely. Preserve key decisions, \
             code changes, file paths, current task state, and any important context \
             needed to continue the work. Be thorough but compact.\n\n{history_text}"
        );

        self.conversation.messages.push(ChatMessage::system(
            "[Compacting context...]".to_string(),
        ));
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
        self.input.set_placeholder_text("Type a message...");
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
            let queued = ChatMessage::queued(text);
            self.pending_messages.push(queued.id);
            self.conversation.messages.push(queued);
            if self.auto_scroll {
                self.scroll_to_bottom();
            }
            return None;
        }

        // Add user message
        self.conversation
            .messages
            .push(ChatMessage::user(text.clone()));

        // Add assistant placeholder
        let target = self.conversation.default_target.clone();
        let mut assistant_msg =
            ChatMessage::assistant(target.provider.clone(), target.model.clone());
        assistant_msg.content = "[thinking...]".to_string();
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
                    Some(msg.content.clone())
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
            // Mark last assistant message as interrupted
            if let Some(msg) = self.active_assistant_message_mut() {
                if msg.role == Role::Assistant {
                    msg.interrupted = true;
                    msg.thinking = None;
                    if msg.content == "[thinking...]" {
                        msg.content = "[interrupted]".to_string();
                    } else {
                        msg.content.push_str("\n[interrupted]");
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
                Role::User | Role::Assistant => {
                    !m.content.is_empty() && m.content != "[thinking...]"
                }
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
            let part = match msg.role {
                Role::User => format!("User: {}", msg.content.trim()),
                Role::Assistant => format!("{}: {}", msg.display_name(), msg.content.trim()),
                Role::System if msg.is_handoff => {
                    format!("[Handoff summary]: {}", msg.content.trim())
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

        let provider_changed = current.provider != new_target.provider
            || current.model != new_target.model;
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
            let event = format!(
                "[→ {}]",
                Self::target_summary(&new_target)
            );
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
            for key in ["message", "text", "detail", "status", "reason"] {
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

fn is_thinking_event(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase().replace(['_', '-', ' '], "");
    matches!(
        normalized.as_str(),
        "thinking" | "thought" | "reasoning" | "reason" | "planning" | "plan"
    )
}

fn tail_words(text: &str, count: usize) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() <= count {
        words.join(" ")
    } else {
        format!("...{}", words[words.len() - count..].join(" "))
    }
}

fn compact_preview_words(text: &str, count: usize) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        String::new()
    } else if words.len() <= count {
        words.join(" ")
    } else {
        format!("{}...", words[..count].join(" "))
    }
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

fn append_answer_activity(msg: &mut ChatMessage, text: &str) {
    if let Some(last) = msg.activities.last_mut() {
        if last.kind == ActivityKind::Answer {
            last.detail.push_str(text);
            last.preview = compact_preview_words(&last.detail, 14);
            return;
        }
    }

    msg.activities.push(ActivityItem {
        kind: ActivityKind::Answer,
        title: "Answer".to_string(),
        preview: compact_preview_words(text, 14),
        detail: text.to_string(),
        related_id: None,
    });
}

fn format_tool_use_detail(name: &str, id: Option<&str>, input: Option<&str>) -> String {
    let mut detail = format!("Tool: {name}");
    if let Some(id) = id {
        detail.push_str(&format!("\nId: {id}"));
    }
    if let Some(input) = input.filter(|value| !value.trim().is_empty()) {
        detail.push_str(&format!("\n\nInput:\n{input}"));
    }
    detail
}

fn format_tool_result_detail(tool_use_id: Option<&str>, content: &str) -> String {
    let mut detail = String::from("Tool result");
    if let Some(id) = tool_use_id {
        detail.push_str(&format!("\nTool id: {id}"));
    }
    if !content.trim().is_empty() {
        detail.push_str(&format!("\n\nOutput:\n{content}"));
    }
    detail
}

fn format_question_detail(detail: &str) -> String {
    format!("Ask user question\n\n{detail}")
}

fn format_agent_event_detail(
    name: &str,
    data: Option<&serde_json::Value>,
    summary: &str,
) -> String {
    let mut detail = format!("Event: {name}\n\nSummary:\n{summary}");
    if let Some(data) = data {
        detail.push_str(&format!("\n\nPayload:\n{}", pretty_json_or_text(data)));
    }
    detail
}

fn format_full_tool_call(tool_call: &ToolCall) -> String {
    let mut detail = format!("Tool: {}", tool_call.name);
    if let Some(id) = tool_call.id.as_deref() {
        detail.push_str(&format!("\nId: {id}"));
    }
    if let Some(input) = tool_call.input.as_deref().filter(|value| !value.trim().is_empty()) {
        detail.push_str(&format!("\n\nInput:\n{input}"));
    }
    if let Some(result) = tool_call.result.as_deref().filter(|value| !value.trim().is_empty()) {
        detail.push_str(&format!("\n\nLatest result:\n{result}"));
    }
    detail
}

fn format_full_tool_result(tool_call: &ToolCall) -> String {
    let mut detail = format!("Tool result: {}", tool_call.name);
    if let Some(id) = tool_call.id.as_deref() {
        detail.push_str(&format!("\nId: {id}"));
    }
    if let Some(input) = tool_call.input.as_deref().filter(|value| !value.trim().is_empty()) {
        detail.push_str(&format!("\n\nInput:\n{input}"));
    }
    if let Some(result) = tool_call.result.as_deref().filter(|value| !value.trim().is_empty()) {
        detail.push_str(&format!("\n\nOutput:\n{result}"));
    }
    detail
}

fn push_activity(
    msg: &mut ChatMessage,
    kind: ActivityKind,
    title: String,
    preview: String,
    detail: String,
    related_id: Option<String>,
) {
    msg.activities.push(ActivityItem {
        kind,
        title,
        preview,
        detail,
        related_id,
    });
}

/// Append thinking text to the current thinking activity, or create a new one.
/// A thinking block is "open" if the last activity is Thinking.
/// Once a non-thinking activity is pushed, the block is sealed.
fn append_thinking_activity(msg: &mut ChatMessage, text: &str) {
    if let Some(last) = msg.activities.last_mut() {
        if last.kind == ActivityKind::Thinking {
            // Append to the open thinking block
            last.detail.push_str(text);
            last.preview = tail_words(&last.detail, 10);
            return;
        }
    }

    // Start a new thinking block
    msg.activities.push(ActivityItem {
        kind: ActivityKind::Thinking,
        title: "Thinking".to_string(),
        preview: tail_words(text, 10),
        detail: text.to_string(),
        related_id: None,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::AppEvent;

    fn test_app() -> App<'static> {
        App::new("http://localhost:4096".to_string())
    }

    #[test]
    fn stream_text_delta_appends_to_assistant() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hi".to_string()));
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        assistant.content = "[thinking...]".to_string();
        app.conversation.messages.push(assistant);
        app.active_request = Some((ActiveRequestKind::Message, 1));
        app.status = Status::StreamingMessage;

        app.handle_event(AppEvent::StreamTextDelta {
            request_id: 1,
            text: "Hello".to_string(),
        });
        assert_eq!(app.conversation.messages.last().unwrap().content, "Hello");

        app.handle_event(AppEvent::StreamTextDelta {
            request_id: 1,
            text: " world".to_string(),
        });
        assert_eq!(
            app.conversation.messages.last().unwrap().content,
            "Hello world"
        );
    }

    #[test]
    fn stale_events_ignored() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hi".to_string()));
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        assistant.content = "[thinking...]".to_string();
        app.conversation.messages.push(assistant);
        app.active_request = Some((ActiveRequestKind::Message, 2));

        app.handle_event(AppEvent::StreamTextDelta {
            request_id: 1,
            text: "stale".to_string(),
        });
        assert_eq!(
            app.conversation.messages.last().unwrap().content,
            "[thinking...]"
        );
    }

    #[test]
    fn stream_error_cleans_placeholder() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hi".to_string()));
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        assistant.content = "[thinking...]".to_string();
        app.conversation.messages.push(assistant);
        app.active_request = Some((ActiveRequestKind::Message, 1));
        app.status = Status::StreamingMessage;

        let cmd = app.handle_event(AppEvent::StreamError {
            request_id: 1,
            error: "connection failed".to_string(),
        });

        assert!(matches!(cmd, Some(Command::SaveConversation(_))));
        assert_eq!(app.status, Status::Idle);
        assert!(app.active_request.is_none());

        let assistant_msg = &app.conversation.messages[1];
        assert!(assistant_msg.content.is_empty());
        assert!(assistant_msg.is_error);

        let error_msg = &app.conversation.messages[2];
        assert_eq!(error_msg.content, "connection failed");
    }

    #[test]
    fn stream_done_finalizes() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hi".to_string()));
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        assistant.content = "response text".to_string();
        app.conversation.messages.push(assistant);
        app.active_request = Some((ActiveRequestKind::Message, 1));
        app.status = Status::StreamingMessage;

        let cmd = app.handle_event(AppEvent::StreamDone { request_id: 1 });

        assert!(matches!(cmd, Some(Command::SaveConversation(_))));
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
        assistant.content = "[thinking...]".to_string();
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
        assert_eq!(assistant_msg.content, "answer");
        assert!(assistant_msg
            .activities
            .iter()
            .any(|activity| activity.kind == ActivityKind::AskUserQuestion));
    }

    #[test]
    fn exit_plan_mode_switches_claude_mode_to_default() {
        let mut app = test_app();
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        let assistant_id = assistant.id;
        assistant.content = "[thinking...]".to_string();
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

        assert_eq!(
            app.conversation.default_target.provider_mode.as_deref(),
            Some("default")
        );
        assert!(app
            .conversation
            .messages
            .iter()
            .filter(|msg| msg.role == Role::Assistant)
            .flat_map(|msg| msg.activities.iter())
            .any(|activity| activity.kind == ActivityKind::ExitPlanMode));
    }

    #[test]
    fn thinking_agent_event_updates_assistant_preview() {
        let mut app = test_app();
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        let assistant_id = assistant.id;
        assistant.content = "[thinking...]".to_string();
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
            assistant_msg.thinking.as_deref(),
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
        assistant.content = "partial".to_string();
        app.conversation.messages.push(assistant);
        app.status = Status::StreamingMessage;
        app.active_request = Some((ActiveRequestKind::Message, 1));

        let was_streaming = app.cancel_stream();
        assert!(was_streaming);
        assert_eq!(app.status, Status::Idle);
        assert!(app.active_request.is_none());

        let msg = app.conversation.messages.last().unwrap();
        assert!(msg.interrupted);
        assert!(msg.content.contains("[interrupted]"));
    }

    #[test]
    fn cancel_thinking_placeholder() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hi".to_string()));
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        assistant.content = "[thinking...]".to_string();
        app.conversation.messages.push(assistant);
        app.status = Status::StreamingMessage;
        app.active_request = Some((ActiveRequestKind::Message, 1));

        app.cancel_stream();

        let msg = app.conversation.messages.last().unwrap();
        assert_eq!(msg.content, "[interrupted]");
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
        assistant.content = "response".to_string();
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
        assert_eq!(app.llm_options.len(), 8);
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
        assert!(matches!(cmd, Some(Command::SaveConversation(_))));
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
        assert!(matches!(cmd, Some(Command::SaveConversation(_))));
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
        assert!(matches!(cmd, Some(Command::SaveConversation(_))));
        assert_eq!(app.conversation.default_target.provider, "codex");
    }

    #[test]
    fn cross_provider_with_history_adds_switch_event() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hello".to_string()));
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        assistant.content = "hi there".to_string();
        app.conversation.messages.push(assistant);

        let new_target = ExecutionTarget {
            provider: "codex".to_string(),
            model: "o4-mini".to_string(),
            provider_mode: Some("workspace-write".to_string()),
            thinking_effort: Some("medium".to_string()),
        };
        let cmd = app.apply_target_switch(new_target);

        assert!(matches!(cmd, Some(Command::SaveConversation(_))));
        assert_eq!(app.conversation.default_target.provider, "codex");
        let system_msgs: Vec<_> = app
            .conversation
            .messages
            .iter()
            .filter(|m| m.role == Role::System && m.content.starts_with("[→"))
            .collect();
        assert_eq!(system_msgs.len(), 1);
        assert!(system_msgs[0].content.contains("codex/o4-mini"));
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

        assert!(matches!(cmd, Some(Command::SaveConversation(_))));
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
        assert!(handoff_msgs[0].content.contains("User wants to build X"));
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

        assert!(matches!(cmd, Some(Command::SaveConversation(_))));
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
        let mut asst = ChatMessage::assistant("codex".to_string(), "o4-mini".to_string());
        asst.content = "[thinking...]".to_string();
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
        asst.content = "response".to_string();
        app.conversation.messages.push(asst);
        // Now current send
        app.conversation
            .messages
            .push(ChatMessage::user("second question".to_string()));
        let mut asst2 = ChatMessage::assistant("codex".to_string(), "o4-mini".to_string());
        asst2.content = "[thinking...]".to_string();
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
                assert_eq!(saved.messages[0].content, "hi");
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

        assert!(matches!(cmd, Some(Command::DeleteConversation { .. })));
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

        assert!(cmd.is_none());
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
            .filter(|m| m.role == Role::System && m.content.contains("Warning"))
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
        assistant.content = "response".to_string();
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
            asst.content = format!("reply {i}");
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
        asst.content = "hi".to_string();
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
            .filter(|m| m.role == Role::System && m.content.starts_with("[→"))
            .collect();
        assert_eq!(system_msgs.len(), 1);
        assert!(system_msgs[0].content.contains("claude/opus"));
    }

    #[test]
    fn mode_switch_with_history_adds_mode_event() {
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("hello".to_string()));
        let mut asst = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        asst.content = "hi".to_string();
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
            .filter(|m| m.role == Role::System && m.content.starts_with("[→"))
            .collect();
        assert_eq!(system_msgs.len(), 1);
        assert!(system_msgs[0].content.contains("Mode: default"));
    }

    #[test]
    fn send_during_streaming_queues_message() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();
        app.conversation
            .messages
            .push(ChatMessage::user("first".to_string()));
        let mut asst = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        asst.content = "[thinking...]".to_string();
        app.conversation.messages.push(asst);
        app.status = Status::StreamingMessage;
        app.active_request = Some((ActiveRequestKind::Message, 1));

        app.input.insert_str("queued msg");
        let key = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
        let cmd = app.handle_event(AppEvent::Key(key));

        assert!(cmd.is_none());
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

        assert!(cmd.is_none());
        assert_eq!(app.overlay, Some(Overlay::CommandPalette));
    }

    #[test]
    fn ctrl_l_opens_llm_picker() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();

        let key = KeyEvent::new(KeyCode::Char('l'), KeyModifiers::CONTROL);
        let cmd = app.handle_event(AppEvent::Key(key));

        assert!(matches!(cmd, Some(Command::FetchProviders)));
        assert_eq!(app.overlay, Some(Overlay::LlmPicker));
    }

    #[test]
    fn ctrl_m_opens_mode_picker() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();

        let key = KeyEvent::new(KeyCode::Char('m'), KeyModifiers::CONTROL);
        let cmd = app.handle_event(AppEvent::Key(key));

        assert!(cmd.is_none());
        assert_eq!(app.overlay, Some(Overlay::ModePicker));
    }

    #[test]
    fn shift_enter_inserts_newline_in_composer() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = test_app();
        app.input.insert_str("hello");

        let key = KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT);
        let cmd = app.handle_event(AppEvent::Key(key));

        assert!(cmd.is_none());
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

        assert!(matches!(cmd, Some(Command::SendMessage { .. })));
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
        asst.content = "response".to_string();
        app.conversation.messages.push(asst);
        let queued = ChatMessage::queued("queued".to_string());
        let queued_id = queued.id;
        app.conversation.messages.push(queued);
        app.pending_messages.push(queued_id);
        app.status = Status::StreamingMessage;
        app.active_request = Some((ActiveRequestKind::Message, 1));

        let cmd = app.handle_event(AppEvent::StreamDone { request_id: 1 });

        assert!(matches!(cmd, Some(Command::SendMessage { .. })));
        assert!(app.pending_messages.is_empty());
        assert_eq!(app.status, Status::StreamingMessage);

        let queued_msg = app
            .conversation
            .messages
            .iter()
            .find(|m| m.role == Role::User && m.content == "queued")
            .unwrap();
        assert!(!queued_msg.is_queued);
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

        assert!(cmd.is_none());
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

        assert!(cmd.is_none());
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

        match cmd {
            Some(Command::DeleteConversation { id }) => assert_eq!(id, current_id),
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
        asst.content = "response".to_string();
        app.conversation.messages.push(asst);

        let first = ChatMessage::queued("same".to_string());
        let first_id = first.id;
        let second = ChatMessage::queued("same".to_string());
        let second_id = second.id;
        app.conversation.messages.push(first);
        app.conversation.messages.push(second);
        app.pending_messages.push(first_id);
        app.pending_messages.push(second_id);
        app.status = Status::StreamingMessage;
        app.active_request = Some((ActiveRequestKind::Message, 1));

        let cmd = app.handle_event(AppEvent::StreamDone { request_id: 1 });

        assert!(matches!(cmd, Some(Command::SendMessage { .. })));
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
}
