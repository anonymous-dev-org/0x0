use crossterm::event::{self, Event, KeyEvent, MouseEvent};
use serde_json::Value;
use tokio::sync::mpsc;

#[derive(Debug)]
#[allow(dead_code)]
pub enum AppEvent {
    Key(KeyEvent),
    Mouse(MouseEvent),
    Resize(u16, u16),
    Tick,

    // SSE stream events
    StreamInit {
        request_id: u64,
        session_id: Option<String>,
    },
    StreamTextDelta {
        request_id: u64,
        text: String,
    },
    StreamToolUse {
        request_id: u64,
        name: String,
        id: Option<String>,
        input: Option<Value>,
    },
    StreamToolResult {
        request_id: u64,
        tool_use_id: Option<String>,
        content: Option<Value>,
    },
    StreamAskUserQuestion {
        request_id: u64,
        question: String,
        options: Option<Vec<String>>,
    },
    StreamExitPlanMode {
        request_id: u64,
        reason: Option<String>,
    },
    StreamAgentEvent {
        request_id: u64,
        name: String,
        data: Option<Value>,
    },
    StreamResult {
        request_id: u64,
        session_id: Option<String>,
        result: Option<String>,
        duration_ms: Option<f64>,
        is_error: Option<bool>,
        input_tokens: Option<u64>,
        context_window: Option<u64>,
    },
    StreamError {
        request_id: u64,
        error: String,
    },
    StreamDone {
        request_id: u64,
    },

    // API response events
    ApiError(String),
    ProvidersList(Vec<ProviderInfo>),

    // Handoff events
    HandoffComplete {
        request_id: u64,
        summary: String,
    },
    HandoffError {
        request_id: u64,
        error: String,
    },

    // Conversation management events
    ConversationsLoaded(Vec<crate::conversation::Conversation>),
    ConversationDeleted(uuid::Uuid),
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub default_model: Option<String>,
}

/// Spawns a blocking task that reads terminal events and sends them
/// through the channel. Runs until the sender is dropped.
pub fn spawn_input_task(tx: mpsc::Sender<AppEvent>) {
    tokio::task::spawn_blocking(move || {
        loop {
            match event::read() {
                Ok(Event::Key(key)) => {
                    if tx.blocking_send(AppEvent::Key(key)).is_err() {
                        break;
                    }
                }
                Ok(Event::Mouse(mouse)) => {
                    if tx.blocking_send(AppEvent::Mouse(mouse)).is_err() {
                        break;
                    }
                }
                Ok(Event::Resize(w, h)) => {
                    if tx.blocking_send(AppEvent::Resize(w, h)).is_err() {
                        break;
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });
}

/// Spawns a tick task that sends Tick events at ~60fps for animations.
pub fn spawn_tick_task(tx: mpsc::Sender<AppEvent>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(50));
        loop {
            interval.tick().await;
            if tx.send(AppEvent::Tick).await.is_err() {
                break;
            }
        }
    });
}
