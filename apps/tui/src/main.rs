mod agent;
mod api;
mod app;
mod context;
mod conversation;
mod event;
mod mention;
mod message;
mod server;
mod ui;

use app::{App, Command};
use color_eyre::Result;
use conversation::Conversation;
use crossterm::{
    event::{
        DisableMouseCapture, EnableMouseCapture, KeyboardEnhancementFlags,
        PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
    },
    execute,
    terminal::SetTitle,
};
use event::{AppEvent, spawn_input_task, spawn_tick_task};
use std::io::stdout;
use std::process::{Command as ProcessCommand, Stdio};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> Result<()> {
    color_eyre::install()?;

    let base_url =
        std::env::var("ZEROXZERO_URL").unwrap_or_else(|_| "http://localhost:4096".to_string());

    // Ensure the server is running before starting the TUI
    let server_error = match server::ensure_running(&base_url).await {
        Ok(_) => None,
        Err(e) => Some(format!("{e}")),
    };

    let mut terminal = ratatui::init();
    let _ = execute!(stdout(), EnableMouseCapture);
    // Enable enhanced keyboard protocol so terminals can distinguish Shift+Enter from Enter
    let _ = execute!(
        stdout(),
        PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
    );
    let (tx, mut rx) = mpsc::channel::<AppEvent>(256);

    // Spawn terminal input reader and animation tick
    spawn_input_task(tx.clone());
    spawn_tick_task(tx.clone());

    let mut app = App::new(base_url);
    app.server_error = server_error;

    let mut cancel_tokens: std::collections::HashMap<u64, CancellationToken> =
        std::collections::HashMap::new();

    sync_terminal_title(&app);

    // Initial draw
    terminal.draw(|f| ui::render(f, &mut app))?;

    // Main event loop
    while let Some(event) = rx.recv().await {
        let mut should_quit = false;
        for cmd in app.handle_event(event) {
            match cmd {
                Command::Quit => {
                    should_quit = true;
                    break;
                }

                Command::SendMessage {
                    prompt,
                    provider,
                    model,
                    cwd,
                    session_id,
                    extra_options,
                    request_id,
                } => {
                    let token = CancellationToken::new();
                    cancel_tokens.insert(request_id, token.clone());
                    let tx = tx.clone();
                    let base_url = app.base_url.clone();

                    tokio::spawn(async move {
                        api::send_message(
                            &base_url,
                            &prompt,
                            &provider,
                            &model,
                            &cwd,
                            session_id.as_deref(),
                            &extra_options,
                            tx,
                            token,
                            request_id,
                        )
                        .await;
                    });
                }

                Command::CancelStream => {
                    for (_, token) in cancel_tokens.drain() {
                        token.cancel();
                    }
                    if app.cancel_stream() {
                        save_conversation(app.conversation.clone());
                    }
                }

                Command::SaveConversation(conversation) => {
                    save_conversation(conversation);
                }

                Command::FetchProviders => {
                    let tx = tx.clone();
                    let base_url = app.base_url.clone();
                    tokio::spawn(async move {
                        api::fetch_providers(&base_url, tx).await;
                    });
                }

                Command::SendHandoff {
                    prompt,
                    provider,
                    model,
                    cwd,
                    extra_options,
                    request_id,
                } => {
                    let token = CancellationToken::new();
                    cancel_tokens.insert(request_id, token.clone());
                    let tx = tx.clone();
                    let base_url = app.base_url.clone();

                    tokio::spawn(async move {
                        api::send_handoff(
                            &base_url,
                            &prompt,
                            &provider,
                            &model,
                            &cwd,
                            &extra_options,
                            tx,
                            token,
                            request_id,
                        )
                        .await;
                    });
                }

                Command::SendCompaction {
                    prompt,
                    provider,
                    model,
                    cwd,
                    extra_options,
                    request_id,
                } => {
                    let token = CancellationToken::new();
                    cancel_tokens.insert(request_id, token.clone());
                    let tx = tx.clone();
                    let base_url = app.base_url.clone();

                    tokio::spawn(async move {
                        api::send_handoff(
                            &base_url,
                            &prompt,
                            &provider,
                            &model,
                            &cwd,
                            &extra_options,
                            tx,
                            token,
                            request_id,
                        )
                        .await;
                    });
                }

                Command::LoadConversations => {
                    let tx = tx.clone();
                    tokio::task::spawn_blocking(move || {
                        let convs = conversation::load_all().unwrap_or_default();
                        let _ = tx.blocking_send(event::AppEvent::ConversationsLoaded(convs));
                    });
                }

                Command::DeleteConversation { id } => {
                    let tx = tx.clone();
                    tokio::task::spawn_blocking(move || {
                        if let Err(e) = conversation::delete(&id) {
                            eprintln!("Failed to delete conversation: {e}");
                        }
                        let _ = tx.blocking_send(event::AppEvent::ConversationDeleted(id));
                    });
                }

                Command::CopyToClipboard(text) => {
                    copy_to_clipboard(text);
                }

                Command::Redraw => {}
            }
        }
        if should_quit {
            break;
        }

        sync_terminal_title(&app);
        terminal.draw(|f| ui::render(f, &mut app))?;
    }

    // Save conversation before exiting
    if !app.conversation.messages.is_empty() {
        let _ = conversation::save(&app.conversation);
    }

    let _ = execute!(stdout(), PopKeyboardEnhancementFlags);
    ratatui::restore();
    let _ = execute!(stdout(), DisableMouseCapture);
    Ok(())
}

fn sync_terminal_title(app: &App) {
    let title = if app.conversation.title.is_empty() {
        "0x0"
    } else {
        &app.conversation.title
    };
    let _ = execute!(stdout(), SetTitle(title));
}

fn save_conversation(conv: Conversation) {
    tokio::task::spawn_blocking(move || {
        if let Err(e) = conversation::save(&conv) {
            eprintln!("Failed to save conversation: {e}");
        }
    });
}

fn copy_to_clipboard(text: String) {
    tokio::task::spawn_blocking(move || {
        let mut child = match ProcessCommand::new("pbcopy").stdin(Stdio::piped()).spawn() {
            Ok(child) => child,
            Err(e) => {
                eprintln!("Failed to access clipboard: {e}");
                return;
            }
        };

        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(text.as_bytes());
        }

        if let Err(e) = child.wait() {
            eprintln!("Failed to copy to clipboard: {e}");
        }
    });
}
