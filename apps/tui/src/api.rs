use serde::Deserialize;
use tokio::sync::mpsc;

use crate::event::AppEvent;

/// Server event types matching the Zod schema in apps/server/src/provider/types.ts
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
pub enum ServerEvent {
    Init {
        session_id: Option<String>,
    },
    TextDelta {
        text: String,
    },
    ToolUse {
        name: String,
        id: Option<String>,
        input: Option<serde_json::Value>,
    },
    ToolResult {
        tool_use_id: Option<String>,
        content: Option<serde_json::Value>,
    },
    AskUserQuestion {
        question: String,
        options: Option<Vec<String>>,
    },
    ExitPlanMode {
        reason: Option<String>,
    },
    AgentEvent {
        name: String,
        data: Option<serde_json::Value>,
    },
    Result {
        session_id: Option<String>,
        result: Option<String>,
        duration_ms: Option<f64>,
        is_error: Option<bool>,
        input_tokens: Option<u64>,
        context_window: Option<u64>,
    },
    Error {
        error: String,
    },
    Done,
    Raw {
        #[allow(dead_code)]
        data: Option<serde_json::Value>,
    },
}

impl ServerEvent {
    /// Convert a ServerEvent into an AppEvent tagged with a request_id.
    pub fn into_app_event(self, request_id: u64) -> Option<AppEvent> {
        match self {
            ServerEvent::Init { session_id } => Some(AppEvent::StreamInit {
                request_id,
                session_id,
            }),
            ServerEvent::TextDelta { text } => Some(AppEvent::StreamTextDelta { request_id, text }),
            ServerEvent::ToolUse { name, id, input } => Some(AppEvent::StreamToolUse {
                request_id,
                name,
                id,
                input,
            }),
            ServerEvent::ToolResult {
                tool_use_id,
                content,
            } => Some(AppEvent::StreamToolResult {
                request_id,
                tool_use_id,
                content,
            }),
            ServerEvent::AskUserQuestion { question, options } => {
                Some(AppEvent::StreamAskUserQuestion {
                    request_id,
                    question,
                    options,
                })
            }
            ServerEvent::ExitPlanMode { reason } => {
                Some(AppEvent::StreamExitPlanMode { request_id, reason })
            }
            ServerEvent::AgentEvent { name, data } => Some(AppEvent::StreamAgentEvent {
                request_id,
                name,
                data,
            }),
            ServerEvent::Result {
                session_id,
                result,
                duration_ms,
                is_error,
                input_tokens,
                context_window,
            } => Some(AppEvent::StreamResult {
                request_id,
                session_id,
                result,
                duration_ms,
                is_error,
                input_tokens,
                context_window,
            }),
            ServerEvent::Error { error } => Some(AppEvent::StreamError { request_id, error }),
            ServerEvent::Done => Some(AppEvent::StreamDone { request_id }),
            ServerEvent::Raw { .. } => None,
        }
    }
}

/// Send a message to the server and stream SSE events back through the channel.
pub async fn send_message(
    base_url: &str,
    prompt: &str,
    provider: &str,
    model: &str,
    cwd: &str,
    session_id: Option<&str>,
    extra_options: &std::collections::HashMap<String, serde_json::Value>,
    tx: mpsc::Sender<AppEvent>,
    cancel: tokio_util::sync::CancellationToken,
    request_id: u64,
) {
    let result = send_message_inner(
        base_url,
        prompt,
        provider,
        model,
        cwd,
        session_id,
        extra_options,
        &tx,
        &cancel,
        request_id,
    )
    .await;

    if cancel.is_cancelled() {
        return;
    }

    match result {
        Ok(server_sent_done) => {
            // If the server stream ended without a `done` event, send one ourselves
            if !server_sent_done {
                let _ = tx.send(AppEvent::StreamDone { request_id }).await;
            }
        }
        Err(e) => {
            let _ = tx
                .send(AppEvent::StreamError {
                    request_id,
                    error: e.to_string(),
                })
                .await;
            let _ = tx.send(AppEvent::StreamDone { request_id }).await;
        }
    }
}

/// Returns Ok(true) if the server sent a `done` event, Ok(false) otherwise.
async fn send_message_inner(
    base_url: &str,
    prompt: &str,
    provider: &str,
    model: &str,
    cwd: &str,
    session_id: Option<&str>,
    extra_options: &std::collections::HashMap<String, serde_json::Value>,
    tx: &mpsc::Sender<AppEvent>,
    cancel: &tokio_util::sync::CancellationToken,
    request_id: u64,
) -> color_eyre::Result<bool> {
    let client = reqwest::Client::new();

    let mut body = serde_json::json!({
        "prompt": prompt,
        "provider": provider,
        "model": model,
        "cwd": cwd,
        "stream": true,
    });

    if let Some(sid) = session_id {
        body["session_id"] = serde_json::Value::String(sid.to_string());
    }

    if let Some(obj) = body.as_object_mut() {
        for (k, v) in extra_options {
            obj.insert(k.clone(), v.clone());
        }
    }

    let response = client
        .post(format!("{base_url}/messages"))
        .json(&body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(color_eyre::eyre::eyre!("Server error {status}: {text}"));
    }

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut saw_done = false;

    while let Some(chunk) = tokio::select! {
        chunk = stream.next() => chunk,
        _ = cancel.cancelled() => None,
    } {
        let chunk = chunk?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Normalize \r\n to \n for consistent frame detection
        if buffer.contains('\r') {
            buffer = buffer.replace("\r\n", "\n").replace('\r', "\n");
        }

        // Process complete SSE frames (separated by blank lines)
        while let Some(frame_end) = buffer.find("\n\n") {
            let frame = buffer[..frame_end].to_string();
            buffer = buffer[frame_end + 2..].to_string();

            if let Some(done) = process_sse_frame(&frame, request_id, tx).await? {
                if done {
                    saw_done = true;
                }
            }
        }
    }

    // Flush any remaining data in the buffer at EOF
    let remaining = buffer.trim().to_string();
    if !remaining.is_empty() {
        if let Some(done) = process_sse_frame(&remaining, request_id, tx).await? {
            if done {
                saw_done = true;
            }
        }
    }

    Ok(saw_done)
}

/// Process a single SSE frame. Returns Ok(Some(true)) if it was a `done` event,
/// Ok(Some(false)) for other valid events, Ok(None) if no event was extracted.
async fn process_sse_frame(
    frame: &str,
    request_id: u64,
    tx: &mpsc::Sender<AppEvent>,
) -> color_eyre::Result<Option<bool>> {
    for line in frame.lines() {
        let line = line.trim();
        if let Some(data) = line.strip_prefix("data:").map(|s| s.trim_start()) {
            if let Ok(event) = serde_json::from_str::<ServerEvent>(data) {
                let is_done = matches!(event, ServerEvent::Done);
                if let Some(app_event) = event.into_app_event(request_id) {
                    if tx.send(app_event).await.is_err() {
                        return Ok(None);
                    }
                }
                return Ok(Some(is_done));
            }
        }
    }
    Ok(None)
}

/// Check server health.
#[allow(dead_code)]
pub async fn health_check(base_url: &str) -> color_eyre::Result<bool> {
    let response = reqwest::get(format!("{base_url}/health")).await?;
    Ok(response.status().is_success())
}

/// Fetch available providers from the server.
pub async fn fetch_providers(base_url: &str, tx: mpsc::Sender<AppEvent>) {
    let result = async {
        let response = reqwest::get(format!("{base_url}/providers")).await?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(color_eyre::eyre::eyre!("Server error {status}: {text}"));
        }
        let body: serde_json::Value = response.json().await?;
        let providers = body["providers"]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .filter_map(|p| {
                Some(crate::event::ProviderInfo {
                    id: p["id"].as_str()?.to_string(),
                    name: p["name"].as_str()?.to_string(),
                    default_model: p["defaults"]["model"].as_str().map(|s| s.to_string()),
                })
            })
            .collect();
        Ok(providers)
    }
    .await;

    match result {
        Ok(providers) => {
            let _ = tx.send(AppEvent::ProvidersList(providers)).await;
        }
        Err(e) => {
            let _ = tx
                .send(AppEvent::ApiError(format!(
                    "Failed to fetch providers: {e}"
                )))
                .await;
        }
    }
}

/// Send a handoff prompt to the outgoing model and collect the full text response.
/// Emits HandoffComplete or HandoffError through the channel.
pub async fn send_handoff(
    base_url: &str,
    prompt: &str,
    provider: &str,
    model: &str,
    cwd: &str,
    extra_options: &std::collections::HashMap<String, serde_json::Value>,
    tx: mpsc::Sender<AppEvent>,
    cancel: tokio_util::sync::CancellationToken,
    _request_id: u64,
) {
    let result = send_handoff_inner(
        base_url,
        prompt,
        provider,
        model,
        cwd,
        extra_options,
        &cancel,
    )
    .await;

    if cancel.is_cancelled() {
        let _ = tx
            .send(AppEvent::HandoffError {
                request_id: _request_id,
                error: "Handoff cancelled".to_string(),
            })
            .await;
        return;
    }

    match result {
        Ok(summary) => {
            let _ = tx
                .send(AppEvent::HandoffComplete {
                    request_id: _request_id,
                    summary,
                })
                .await;
        }
        Err(e) => {
            let _ = tx
                .send(AppEvent::HandoffError {
                    request_id: _request_id,
                    error: e.to_string(),
                })
                .await;
        }
    }
}

async fn send_handoff_inner(
    base_url: &str,
    prompt: &str,
    provider: &str,
    model: &str,
    cwd: &str,
    extra_options: &std::collections::HashMap<String, serde_json::Value>,
    cancel: &tokio_util::sync::CancellationToken,
) -> color_eyre::Result<String> {
    let client = reqwest::Client::new();

    let mut body = serde_json::json!({
        "prompt": prompt,
        "provider": provider,
        "model": model,
        "cwd": cwd,
        "stream": true,
    });

    if let Some(obj) = body.as_object_mut() {
        for (k, v) in extra_options {
            obj.insert(k.clone(), v.clone());
        }
    }

    let response = client
        .post(format!("{base_url}/messages"))
        .json(&body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(color_eyre::eyre::eyre!("Server error {status}: {text}"));
    }

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut summary = String::new();

    while let Some(chunk) = tokio::select! {
        chunk = stream.next() => chunk,
        _ = cancel.cancelled() => None,
    } {
        let chunk = chunk?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        if buffer.contains('\r') {
            buffer = buffer.replace("\r\n", "\n").replace('\r', "\n");
        }

        while let Some(frame_end) = buffer.find("\n\n") {
            let frame = buffer[..frame_end].to_string();
            buffer = buffer[frame_end + 2..].to_string();

            for line in frame.lines() {
                let line = line.trim();
                if let Some(data) = line.strip_prefix("data:").map(|s| s.trim_start()) {
                    if let Ok(event) = serde_json::from_str::<ServerEvent>(data) {
                        if let ServerEvent::TextDelta { text } = event {
                            summary.push_str(&text);
                        }
                    }
                }
            }
        }
    }

    // Flush remaining
    let remaining = buffer.trim().to_string();
    if !remaining.is_empty() {
        for line in remaining.lines() {
            let line = line.trim();
            if let Some(data) = line.strip_prefix("data:").map(|s| s.trim_start()) {
                if let Ok(ServerEvent::TextDelta { text }) =
                    serde_json::from_str::<ServerEvent>(data)
                {
                    summary.push_str(&text);
                }
            }
        }
    }

    if summary.trim().is_empty() {
        return Err(color_eyre::eyre::eyre!("Handoff produced no summary"));
    }

    Ok(summary.trim().to_string())
}

/// Extract SSE data lines from a raw buffer, splitting on blank-line boundaries.
/// Returns parsed (frames, remaining_buffer).
#[allow(dead_code)]
pub fn extract_sse_frames(raw: &str) -> (Vec<String>, String) {
    // Normalize line endings
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut frames = Vec::new();
    let mut rest = normalized;

    while let Some(pos) = rest.find("\n\n") {
        let frame = rest[..pos].to_string();
        rest = rest[pos + 2..].to_string();
        // Extract data line
        for line in frame.lines() {
            let line = line.trim();
            if let Some(data) = line.strip_prefix("data:").map(|s| s.trim_start()) {
                frames.push(data.to_string());
            }
        }
    }
    (frames, rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_text_delta() {
        let json = r#"{"type":"text_delta","text":"hello"}"#;
        let event: ServerEvent = serde_json::from_str(json).unwrap();
        match event {
            ServerEvent::TextDelta { text } => assert_eq!(text, "hello"),
            other => panic!("expected TextDelta, got {other:?}"),
        }
    }

    #[test]
    fn parse_done() {
        let json = r#"{"type":"done"}"#;
        let event: ServerEvent = serde_json::from_str(json).unwrap();
        assert!(matches!(event, ServerEvent::Done));
    }

    #[test]
    fn parse_error() {
        let json = r#"{"type":"error","error":"something broke"}"#;
        let event: ServerEvent = serde_json::from_str(json).unwrap();
        match event {
            ServerEvent::Error { error } => assert_eq!(error, "something broke"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn parse_tool_use() {
        let json = r#"{"type":"tool_use","name":"read_file","id":"t1"}"#;
        let event: ServerEvent = serde_json::from_str(json).unwrap();
        match event {
            ServerEvent::ToolUse { name, id, .. } => {
                assert_eq!(name, "read_file");
                assert_eq!(id, Some("t1".to_string()));
            }
            other => panic!("expected ToolUse, got {other:?}"),
        }
    }

    #[test]
    fn parse_ask_user_question() {
        let json = r#"{"type":"ask_user_question","question":"Continue?","options":["yes","no"]}"#;
        let event: ServerEvent = serde_json::from_str(json).unwrap();
        match event {
            ServerEvent::AskUserQuestion { question, options } => {
                assert_eq!(question, "Continue?");
                assert_eq!(options, Some(vec!["yes".to_string(), "no".to_string()]));
            }
            other => panic!("expected AskUserQuestion, got {other:?}"),
        }
    }

    #[test]
    fn parse_exit_plan_mode() {
        let json = r#"{"type":"exit_plan_mode","reason":"Need to execute"}"#;
        let event: ServerEvent = serde_json::from_str(json).unwrap();
        match event {
            ServerEvent::ExitPlanMode { reason } => {
                assert_eq!(reason, Some("Need to execute".to_string()));
            }
            other => panic!("expected ExitPlanMode, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_with_optional_fields() {
        let json = r#"{"type":"result","session_id":"abc","result":"done","duration_ms":1234.5}"#;
        let event: ServerEvent = serde_json::from_str(json).unwrap();
        match event {
            ServerEvent::Result {
                session_id,
                result,
                duration_ms,
                is_error,
                ..
            } => {
                assert_eq!(session_id, Some("abc".to_string()));
                assert_eq!(result, Some("done".to_string()));
                assert_eq!(duration_ms, Some(1234.5));
                assert_eq!(is_error, None);
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_init() {
        let json = r#"{"type":"init","session_id":"sess-1"}"#;
        let event: ServerEvent = serde_json::from_str(json).unwrap();
        match event {
            ServerEvent::Init { session_id } => assert_eq!(session_id, Some("sess-1".to_string())),
            other => panic!("expected Init, got {other:?}"),
        }
    }

    #[test]
    fn parse_raw_ignored() {
        let json = r#"{"type":"raw","data":{"foo":"bar"}}"#;
        let event: ServerEvent = serde_json::from_str(json).unwrap();
        assert!(matches!(event, ServerEvent::Raw { .. }));
        // into_app_event should return None for Raw
        assert!(event.into_app_event(1).is_none());
    }

    #[test]
    fn extract_frames_basic() {
        let raw =
            "data: {\"type\":\"text_delta\",\"text\":\"hi\"}\n\ndata: {\"type\":\"done\"}\n\n";
        let (frames, rest) = extract_sse_frames(raw);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], r#"{"type":"text_delta","text":"hi"}"#);
        assert_eq!(frames[1], r#"{"type":"done"}"#);
        assert!(rest.is_empty());
    }

    #[test]
    fn extract_frames_crlf() {
        let raw = "data: {\"type\":\"done\"}\r\n\r\n";
        let (frames, rest) = extract_sse_frames(raw);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], r#"{"type":"done"}"#);
        assert!(rest.is_empty());
    }

    #[test]
    fn extract_frames_partial() {
        let raw = "data: {\"type\":\"text_delta\",\"text\":\"hi\"}\n\ndata: {\"type\":\"do";
        let (frames, rest) = extract_sse_frames(raw);
        assert_eq!(frames.len(), 1);
        assert_eq!(rest, r#"data: {"type":"do"#);
    }

    #[test]
    fn extract_frames_empty_input() {
        let (frames, rest) = extract_sse_frames("");
        assert!(frames.is_empty());
        assert!(rest.is_empty());
    }

    #[test]
    fn into_app_event_tags_request_id() {
        let event = ServerEvent::TextDelta {
            text: "x".to_string(),
        };
        let app_event = event.into_app_event(42).unwrap();
        match app_event {
            AppEvent::StreamTextDelta { request_id, text } => {
                assert_eq!(request_id, 42);
                assert_eq!(text, "x");
            }
            other => panic!("expected StreamTextDelta, got {other:?}"),
        }
    }
}
