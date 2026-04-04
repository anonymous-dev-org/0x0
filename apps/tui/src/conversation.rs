use chrono::{DateTime, Utc};
use color_eyre::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

use crate::agent::AgentRegistry;
use crate::message::{ChatMessage, ExecutionTarget};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: Uuid,
    pub cwd: PathBuf,
    pub title: String,
    pub messages: Vec<ChatMessage>,
    pub default_target: ExecutionTarget,
    #[serde(default)]
    pub agents: Option<AgentRegistry>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Conversation {
    pub fn new(cwd: PathBuf, default_target: ExecutionTarget) -> Self {
        Self {
            id: Uuid::new_v4(),
            cwd,
            title: String::new(),
            messages: Vec::new(),
            default_target,
            agents: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    /// Auto-generate title from first user message.
    pub fn update_title(&mut self) {
        if !self.title.is_empty() {
            return;
        }
        if let Some(msg) = self
            .messages
            .iter()
            .find(|m| m.role == crate::message::Role::User)
        {
            let raw = msg.text();
            let content = raw.trim();
            if content.len() <= 30 {
                self.title = content.to_string();
            } else {
                // Truncate at word boundary
                let truncated = &content[..30];
                if let Some(last_space) = truncated.rfind(' ') {
                    self.title = format!("{}...", &content[..last_space]);
                } else {
                    self.title = format!("{truncated}...");
                }
            }
        }
    }

    pub fn touch(&mut self) {
        self.updated_at = Utc::now();
    }
}

/// Returns the base directory for conversation storage.
fn storage_dir() -> Result<PathBuf> {
    let data_dir = dirs::data_dir()
        .ok_or_else(|| color_eyre::eyre::eyre!("Could not determine data directory"))?;
    let dir = data_dir.join("zeroxzero").join("conversations");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Save a conversation to disk.
pub fn save(conversation: &Conversation) -> Result<()> {
    let dir = storage_dir()?;
    let path = dir.join(format!("{}.json", conversation.id));
    let json = serde_json::to_string_pretty(conversation)?;
    std::fs::write(path, json)?;
    Ok(())
}

/// Load a single conversation from disk.
#[allow(dead_code)]
pub fn load(id: &Uuid) -> Result<Conversation> {
    let dir = storage_dir()?;
    let path = dir.join(format!("{id}.json"));
    let json = std::fs::read_to_string(path)?;
    let conversation: Conversation = serde_json::from_str(&json)?;
    Ok(conversation)
}

/// Load all conversations from disk.
pub fn load_all() -> Result<Vec<Conversation>> {
    let dir = match storage_dir() {
        Ok(d) => d,
        Err(_) => return Ok(Vec::new()),
    };
    let mut conversations = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            match std::fs::read_to_string(&path) {
                Ok(json) => {
                    if let Ok(conv) = serde_json::from_str::<Conversation>(&json) {
                        conversations.push(conv);
                    }
                }
                Err(_) => continue,
            }
        }
    }
    conversations.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(conversations)
}

/// Delete a conversation from disk.
pub fn delete(id: &Uuid) -> Result<()> {
    let dir = storage_dir()?;
    let path = dir.join(format!("{id}.json"));
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

/// Save a conversation to a specific directory (for testing).
#[cfg(test)]
pub fn save_to(conversation: &Conversation, dir: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("{}.json", conversation.id));
    let json = serde_json::to_string_pretty(conversation)?;
    std::fs::write(path, json)?;
    Ok(())
}

/// Load a conversation from a specific directory (for testing).
#[cfg(test)]
pub fn load_from(id: &Uuid, dir: &std::path::Path) -> Result<Conversation> {
    let path = dir.join(format!("{id}.json"));
    let json = std::fs::read_to_string(path)?;
    let conversation: Conversation = serde_json::from_str(&json)?;
    Ok(conversation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{ChatMessage, ExecutionTarget};

    fn test_target() -> ExecutionTarget {
        ExecutionTarget {
            provider: "claude".to_string(),
            model: "sonnet".to_string(),
            provider_mode: Some("plan".to_string()),
            thinking_effort: Some("medium".to_string()),
        }
    }

    #[test]
    fn round_trip_empty_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let conv = Conversation::new("/tmp/test".into(), test_target());
        let id = conv.id;

        save_to(&conv, dir.path()).unwrap();
        let loaded = load_from(&id, dir.path()).unwrap();

        assert_eq!(loaded.id, id);
        assert_eq!(loaded.cwd, std::path::PathBuf::from("/tmp/test"));
        assert!(loaded.messages.is_empty());
        assert_eq!(loaded.default_target.provider, "claude");
    }

    #[test]
    fn round_trip_with_messages() {
        let dir = tempfile::tempdir().unwrap();
        let mut conv = Conversation::new("/tmp/test".into(), test_target());

        conv.messages.push(ChatMessage::user("hello".to_string()));
        let mut assistant = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        assistant.push_text("hi there");
        conv.messages.push(assistant);

        conv.update_title();
        let id = conv.id;

        save_to(&conv, dir.path()).unwrap();
        let loaded = load_from(&id, dir.path()).unwrap();

        assert_eq!(loaded.messages.len(), 2);
        assert_eq!(loaded.messages[0].text(), "hello");
        assert_eq!(loaded.messages[1].text(), "hi there");
        assert_eq!(loaded.title, "hello");
    }

    #[test]
    fn title_generation_short() {
        let mut conv = Conversation::new("/tmp".into(), test_target());
        conv.messages
            .push(ChatMessage::user("short msg".to_string()));
        conv.update_title();
        assert_eq!(conv.title, "short msg");
    }

    #[test]
    fn title_generation_long() {
        let mut conv = Conversation::new("/tmp".into(), test_target());
        conv.messages.push(ChatMessage::user(
            "this is a really long message that should be truncated at a word boundary".to_string(),
        ));
        conv.update_title();
        assert!(conv.title.len() <= 35); // 30 + "..."
        assert!(conv.title.ends_with("..."));
    }

    #[test]
    fn title_only_set_once() {
        let mut conv = Conversation::new("/tmp".into(), test_target());
        conv.messages.push(ChatMessage::user("first".to_string()));
        conv.update_title();
        assert_eq!(conv.title, "first");

        conv.messages.push(ChatMessage::user("second".to_string()));
        conv.update_title();
        assert_eq!(conv.title, "first"); // unchanged
    }

    #[test]
    fn round_trip_interrupted_message() {
        let dir = tempfile::tempdir().unwrap();
        let mut conv = Conversation::new("/tmp".into(), test_target());

        let mut msg = ChatMessage::assistant("claude".to_string(), "sonnet".to_string());
        msg.push_text("partial response\n[interrupted]");
        msg.interrupted = true;
        conv.messages.push(msg);

        let id = conv.id;
        save_to(&conv, dir.path()).unwrap();
        let loaded = load_from(&id, dir.path()).unwrap();

        assert!(loaded.messages[0].interrupted);
        assert!(loaded.messages[0].text().contains("[interrupted]"));
    }
}
