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
pub struct ToolCall {
    pub name: String,
    pub id: Option<String>,
    pub input: Option<String>,
    pub result: Option<String>,
    #[serde(default)]
    pub collapsed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKind {
    Answer,
    Thinking,
    ToolUse,
    ToolResult,
    AskUserQuestion,
    ExitPlanMode,
    AgentEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityItem {
    pub kind: ActivityKind,
    pub title: String,
    pub preview: String,
    pub detail: String,
    pub related_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: Uuid,
    pub role: Role,
    pub content: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default)]
    pub activities: Vec<ActivityItem>,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub interrupted: bool,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default)]
    pub is_handoff: bool,
    #[serde(default)]
    pub is_queued: bool,
    pub created_at: DateTime<Utc>,
}

impl ChatMessage {
    pub fn user(content: String) -> Self {
        Self {
            id: Uuid::new_v4(),
            role: Role::User,
            content,
            provider: None,
            model: None,
            tool_calls: Vec::new(),
            activities: Vec::new(),
            thinking: None,
            interrupted: false,
            is_error: false,
            is_handoff: false,
            is_queued: false,
            created_at: Utc::now(),
        }
    }

    pub fn queued(content: String) -> Self {
        let mut msg = Self::user(content);
        msg.is_queued = true;
        msg
    }

    pub fn assistant(provider: String, model: String) -> Self {
        Self {
            id: Uuid::new_v4(),
            role: Role::Assistant,
            content: String::new(),
            provider: Some(provider),
            model: Some(model),
            tool_calls: Vec::new(),
            activities: Vec::new(),
            thinking: None,
            interrupted: false,
            is_error: false,
            is_handoff: false,
            is_queued: false,
            created_at: Utc::now(),
        }
    }

    pub fn system(content: String) -> Self {
        Self {
            id: Uuid::new_v4(),
            role: Role::System,
            content,
            provider: None,
            model: None,
            tool_calls: Vec::new(),
            activities: Vec::new(),
            thinking: None,
            interrupted: false,
            is_error: false,
            is_handoff: false,
            is_queued: false,
            created_at: Utc::now(),
        }
    }

    pub fn error(content: String) -> Self {
        Self {
            id: Uuid::new_v4(),
            role: Role::Error,
            content,
            provider: None,
            model: None,
            tool_calls: Vec::new(),
            activities: Vec::new(),
            thinking: None,
            interrupted: false,
            is_error: true,
            is_handoff: false,
            is_queued: false,
            created_at: Utc::now(),
        }
    }

    pub fn handoff(content: String) -> Self {
        let mut msg = Self::system(content);
        msg.is_handoff = true;
        msg
    }

    pub fn display_name(&self) -> String {
        match self.role {
            Role::User => "You".to_string(),
            Role::Assistant => match (&self.provider, &self.model) {
                (Some(p), Some(m)) => format!("{p}/{m}"),
                (Some(p), None) => p.clone(),
                _ => "Assistant".to_string(),
            },
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
