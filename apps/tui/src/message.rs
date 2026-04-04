use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    System,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text { text: String },
    Thinking { text: String },
    ToolUse { name: String, id: Option<String>, input: Option<String> },
    ToolResult { tool_use_id: Option<String>, content: Option<String> },
    AgentStart { id: String, label: String },
    AgentEnd { id: String },
    Event { name: String, detail: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: Uuid,
    pub role: Role,
    #[serde(default)]
    pub blocks: Vec<ContentBlock>,
    pub provider: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub interrupted: bool,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default)]
    pub is_handoff: bool,
    #[serde(default)]
    pub is_queued: bool,
    #[serde(default)]
    pub agent_name: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl ChatMessage {
    fn new(role: Role) -> Self {
        Self {
            id: Uuid::new_v4(),
            role,
            blocks: Vec::new(),
            provider: None,
            model: None,
            interrupted: false,
            is_error: false,
            is_handoff: false,
            is_queued: false,
            agent_name: None,
            created_at: Utc::now(),
        }
    }

    pub fn user(content: String) -> Self {
        let mut msg = Self::new(Role::User);
        if !content.is_empty() {
            msg.blocks.push(ContentBlock::Text { text: content });
        }
        msg
    }

    pub fn queued(content: String) -> Self {
        let mut msg = Self::user(content);
        msg.is_queued = true;
        msg
    }

    pub fn assistant(provider: String, model: String) -> Self {
        let mut msg = Self::new(Role::Assistant);
        msg.provider = Some(provider);
        msg.model = Some(model);
        msg
    }

    pub fn agent_assistant(agent_name: String, provider: String, model: String) -> Self {
        let mut msg = Self::assistant(provider, model);
        msg.agent_name = Some(agent_name);
        msg
    }

    pub fn system(content: String) -> Self {
        let mut msg = Self::new(Role::System);
        if !content.is_empty() {
            msg.blocks.push(ContentBlock::Text { text: content });
        }
        msg
    }

    pub fn error(content: String) -> Self {
        let mut msg = Self::new(Role::Error);
        msg.is_error = true;
        if !content.is_empty() {
            msg.blocks.push(ContentBlock::Text { text: content });
        }
        msg
    }

    pub fn handoff(content: String) -> Self {
        let mut msg = Self::system(content);
        msg.is_handoff = true;
        msg
    }

    /// Concatenate all Text blocks into a single string.
    pub fn text(&self) -> String {
        let mut out = String::new();
        for block in &self.blocks {
            if let ContentBlock::Text { text } = block {
                out.push_str(text);
            }
        }
        out
    }

    /// Append text: extends the last Text block or creates a new one.
    pub fn push_text(&mut self, s: &str) {
        if let Some(ContentBlock::Text { text }) = self.blocks.last_mut() {
            text.push_str(s);
        } else {
            self.blocks.push(ContentBlock::Text { text: s.to_string() });
        }
    }

    /// Append thinking: extends the last Thinking block or creates a new one.
    pub fn push_thinking(&mut self, s: &str) {
        if let Some(ContentBlock::Thinking { text }) = self.blocks.last_mut() {
            text.push_str(s);
        } else {
            self.blocks.push(ContentBlock::Thinking { text: s.to_string() });
        }
    }

    /// Get the last few words of thinking for the pulse preview.
    pub fn last_thinking_preview(&self, word_count: usize) -> Option<String> {
        for block in self.blocks.iter().rev() {
            if let ContentBlock::Thinking { text } = block {
                let words: Vec<&str> = text.split_whitespace().collect();
                if words.is_empty() {
                    return None;
                }
                if words.len() <= word_count {
                    return Some(words.join(" "));
                }
                return Some(format!("...{}", words[words.len() - word_count..].join(" ")));
            }
        }
        None
    }

    /// Find the ToolResult content for a given tool_use_id.
    pub fn tool_result_for(&self, tool_use_id: &str) -> Option<&str> {
        for block in &self.blocks {
            if let ContentBlock::ToolResult { tool_use_id: Some(tid), content } = block {
                if tid == tool_use_id {
                    return content.as_deref();
                }
            }
        }
        None
    }

    /// Check if a tool_use_id belongs to an AgentStart block.
    pub fn is_agent_start(&self, tool_use_id: &str) -> bool {
        self.blocks.iter().any(|b| matches!(b, ContentBlock::AgentStart { id, .. } if id == tool_use_id))
    }

    /// Check if we have any text content (not just [thinking...] placeholder).
    pub fn has_text(&self) -> bool {
        self.blocks.iter().any(|b| matches!(b, ContentBlock::Text { text } if !text.is_empty()))
    }

    pub fn display_name(&self) -> String {
        match self.role {
            Role::User => "You".to_string(),
            Role::Assistant => {
                let base = match (&self.provider, &self.model) {
                    (Some(p), Some(m)) => format!("{p}/{m}"),
                    (Some(p), None) => p.clone(),
                    _ => "Assistant".to_string(),
                };
                match &self.agent_name {
                    Some(name) => format!("{name} ({base})"),
                    None => base,
                }
            }
            Role::System => "System".to_string(),
            Role::Error => "Error".to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderModeKind {
    PermissionMode,
    Sandbox,
}

impl std::fmt::Display for ProviderModeKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderModeKind::PermissionMode => write!(f, "Mode"),
            ProviderModeKind::Sandbox => write!(f, "Sandbox"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionTarget {
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub provider_mode: Option<String>,
    #[serde(default)]
    pub thinking_effort: Option<String>,
}

impl std::fmt::Display for ExecutionTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.provider, self.model)?;

        let mut parts = Vec::new();
        if let Some(mode) = self.provider_mode.as_deref() {
            parts.push(format!("mode: {mode}"));
        }
        if let Some(effort) = self.thinking_effort.as_deref() {
            parts.push(format!("effort: {effort}"));
        }

        if !parts.is_empty() {
            write!(f, " ({})", parts.join(", "))?;
        }

        Ok(())
    }
}
