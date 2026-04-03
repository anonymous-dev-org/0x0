mod api;
mod app;
mod context;
mod conversation;
mod event;
mod message;
mod server;
mod ui;

use app::{App, Command};
use color_eyre::Result;
use conversation::Conversation;
use crossterm::{execute, event::{EnableMouseCapture, DisableMouseCapture}, terminal::SetTitle};
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
    let managed = server::ensure_running(&base_url).await;
    if let Err(e) = &managed {
        eprintln!("Warning: could not start server: {e}");
    }

    let mut terminal = ratatui::init();
    let _ = execute!(stdout(), EnableMouseCapture);
    let (tx, mut rx) = mpsc::channel::<AppEvent>(256);

    // Spawn terminal input reader and animation tick
    spawn_input_task(tx.clone());
    spawn_tick_task(tx.clone());

    let mut app = App::new(base_url);

    let mut cancel_token: Option<CancellationToken> = None;

    sync_terminal_title(&app);

    // Initial draw
    terminal.draw(|f| ui::render(f, &mut app))?;

    // Main event loop
    while let Some(event) = rx.recv().await {
        if let Some(cmd) = app.handle_event(event) {
            match cmd {
                Command::Quit => break,

                Command::SendMessage {
                    prompt,
                    provider,
                    model,
                    cwd,
                    session_id,
                    extra_options,
                    request_id,
                } => {
                    // Cancel any existing stream
                    if let Some(token) = cancel_token.take() {
                        token.cancel();
                    }

                    let token = CancellationToken::new();
                    cancel_token = Some(token.clone());
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
                    if let Some(token) = cancel_token.take() {
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
                    // Cancel any existing stream
                    if let Some(token) = cancel_token.take() {
                        token.cancel();
                    }

                    let token = CancellationToken::new();
                    cancel_token = Some(token.clone());
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
                    // Reuse handoff send path — compaction is essentially a self-handoff
                    if let Some(token) = cancel_token.take() {
                        token.cancel();
                    }

                    let token = CancellationToken::new();
                    cancel_token = Some(token.clone());
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

        sync_terminal_title(&app);
        terminal.draw(|f| ui::render(f, &mut app))?;
    }

    // Save conversation before exiting
    if !app.conversation.messages.is_empty() {
        let _ = conversation::save(&app.conversation);
    }

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
        let mut child = match ProcessCommand::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
        {
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
