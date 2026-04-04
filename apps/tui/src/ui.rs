use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use unicode_width::UnicodeWidthStr;

use crate::app::{App, BlockRef, DeleteTarget, HandoffMode, InspectableLine, Overlay};
use crate::message::{ChatMessage, ContentBlock, Role};

pub fn render(frame: &mut Frame, app: &mut App) {
    let show_question = app.pending_question.is_some();

    let bottom_height = if show_question {
        compute_question_height(app)
    } else {
        compute_input_height(app)
    };

    let [messages_area, bottom_area] =
        Layout::vertical([Constraint::Fill(1), Constraint::Length(bottom_height)])
            .areas(frame.area());

    app.messages_area_y = messages_area.y;
    render_messages(frame, app, messages_area);

    if show_question {
        render_question_input(frame, app, bottom_area);
    } else {
        render_input(frame, app, bottom_area);
    }

    // Render overlay on top if active
    if let Some(overlay) = app.overlay {
        match overlay {
            Overlay::Help => render_help_overlay(frame),
            Overlay::CommandPalette => render_command_palette(frame, app),
            Overlay::AgentManager => render_agent_manager(frame, app),
            Overlay::LlmPicker => render_llm_picker(frame, app),
            Overlay::ModePicker => render_mode_picker(frame, app),
            Overlay::EffortPicker => render_effort_picker(frame, app),
            Overlay::ActivityInspector => render_activity_inspector(frame, app),
            Overlay::HandoffPrompt => render_handoff_prompt(frame, app),
            Overlay::ConversationSwitcher => render_conversation_switcher(frame, app),
            Overlay::ConfirmDelete => render_confirm_delete(frame, app),
        }
    }
}

fn render_messages(frame: &mut Frame, app: &mut App, area: Rect) {
    app.viewport_height = area.height;

    if app.conversation.messages.is_empty() {
        render_empty_state(frame, app, area);
        return;
    }

    let mut lines: Vec<Line> = Vec::new();
    let mut inspectable = Vec::new();

    for msg in &app.conversation.messages {
        if !lines.is_empty() {
            lines.push(Line::from(""));
        }
        let is_active_turn =
            app.status == crate::app::Status::StreamingMessage && app.is_active_assistant(msg.id);
        render_message_block(msg, &mut lines, &mut inspectable, app.animation_tick, is_active_turn, app);
    }
    app.inspectable_lines = inspectable;

    app.content_height = lines.len() as u16;

    let max_scroll = app.content_height.saturating_sub(app.viewport_height);
    if app.scroll_offset > max_scroll {
        app.scroll_offset = max_scroll;
    }

    let text = Text::from(lines);
    let paragraph = Paragraph::new(text)
        .wrap(Wrap { trim: false })
        .scroll((app.scroll_offset, 0));

    frame.render_widget(paragraph, area);
}

fn render_message_block(
    msg: &ChatMessage,
    lines: &mut Vec<Line<'static>>,
    inspectable: &mut Vec<InspectableLine>,
    tick: u64,
    is_active_turn: bool,
    app: &App,
) {
    if msg.is_queued {
        let style = Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC);
        lines.push(Line::from(Span::styled("You (queued)", style)));
        for line in msg.text().lines().map(|l| l.to_string()).collect::<Vec<_>>() {
            lines.push(Line::from(Span::styled(line, Style::default().fg(Color::DarkGray))));
        }
        return;
    }

    // Role label
    let label_style = match msg.role {
        Role::User => Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        Role::Assistant => {
            let color = msg.agent_name.as_deref()
                .map(|name| app.color_for_agent(name))
                .unwrap_or(Color::Rgb(150, 120, 255));
            Style::default().fg(color).add_modifier(Modifier::BOLD)
        }
        Role::System => Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
        Role::Error => Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
    };
    lines.push(Line::from(Span::styled(msg.display_name(), label_style)));

    let content_style = match msg.role {
        Role::Error => Style::default().fg(Color::Red),
        Role::System => Style::default().fg(Color::DarkGray),
        _ => Style::default(),
    };

    if msg.role == Role::Assistant {
        render_blocks(msg, lines, inspectable, tick, is_active_turn);
    } else {
        let t = msg.text();
        for line in t.lines() {
            lines.push(Line::from(Span::styled(line.to_string(), content_style)));
        }
    }

    if msg.interrupted && !msg.text().contains("[interrupted]") {
        lines.push(Line::from(Span::styled(
            "[interrupted]",
            Style::default().fg(Color::Yellow).add_modifier(Modifier::ITALIC),
        )));
    }
}

/// Build a set of tool_use IDs that have a matching ToolResult in the blocks.
fn completed_tool_ids(blocks: &[ContentBlock]) -> std::collections::HashSet<String> {
    blocks.iter().filter_map(|b| match b {
        ContentBlock::ToolResult { tool_use_id: Some(id), .. } => Some(id.clone()),
        _ => None,
    }).collect()
}

/// Render assistant blocks in order.
fn render_blocks(
    msg: &ChatMessage,
    lines: &mut Vec<Line<'static>>,
    inspectable: &mut Vec<InspectableLine>,
    tick: u64,
    is_active_turn: bool,
) {
    let dim = Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC);
    let completed = completed_tool_ids(&msg.blocks);
    // Collect AgentEnd ids for determining completed agents
    let ended_agents: std::collections::HashSet<&str> = msg.blocks.iter()
        .filter_map(|b| match b { ContentBlock::AgentEnd { id } => Some(id.as_str()), _ => None })
        .collect();

    let mut index = 0;
    while index < msg.blocks.len() {
        match &msg.blocks[index] {
            ContentBlock::Text { text } => {
                for line in text.lines() {
                    lines.push(Line::from(Span::raw(line.to_string())));
                }
            }
            ContentBlock::Thinking { .. } => {
                let is_last = index == msg.blocks.len() - 1;
                let style = if is_active_turn && is_last {
                    Style::default().fg(pending_pulse_color(tick)).add_modifier(Modifier::ITALIC)
                } else { dim };
                let label = if is_active_turn && is_last { "▸ Thinking..." } else { "▸ Thinking" };
                let li = lines.len();
                lines.push(Line::from(Span::styled(label.to_string(), style)));
                inspectable.push(InspectableLine { line_index: li, block_ref: BlockRef { message_id: msg.id, block_index: index } });
            }
            ContentBlock::ToolUse { name, id, .. } => {
                let is_pending = is_active_turn && id.as_deref().is_some_and(|i| !completed.contains(i));
                let style = if is_pending {
                    Style::default().fg(pending_pulse_color(tick)).add_modifier(Modifier::ITALIC)
                } else { dim };
                let li = lines.len();
                lines.push(Line::from(Span::styled(format!("▸ Tool: {name}"), style)));
                inspectable.push(InspectableLine { line_index: li, block_ref: BlockRef { message_id: msg.id, block_index: index } });
            }
            ContentBlock::ToolResult { .. } => {
                // Skip — result data is accessible via inspector on the ToolUse
            }
            ContentBlock::AgentStart { id: agent_id, label } => {
                // Collect child blocks until AgentEnd
                let start = index + 1;
                let mut end = msg.blocks.len();
                for j in start..msg.blocks.len() {
                    if matches!(&msg.blocks[j], ContentBlock::AgentEnd { id } if id == agent_id) {
                        end = j;
                        break;
                    }
                }
                let is_completed = ended_agents.contains(agent_id.as_str());
                let is_pending = is_active_turn && !is_completed;

                // Count tools in this agent section
                let tool_count = msg.blocks[start..end].iter()
                    .filter(|b| matches!(b, ContentBlock::ToolUse { .. }))
                    .count();

                let header_style = if is_pending {
                    Style::default().fg(pending_pulse_color(tick)).add_modifier(Modifier::ITALIC)
                } else { dim };

                if is_completed {
                    // Collapsed: single line
                    let collapsed_text = if tool_count > 0 {
                        format!("── {} · {} tool{} ──", label, tool_count, if tool_count == 1 { "" } else { "s" })
                    } else {
                        format!("── {} ──", label)
                    };
                    lines.push(Line::from(Span::styled(collapsed_text, header_style)));
                } else {
                    // In-progress: header + children + animation + footer
                    lines.push(Line::from(Span::styled(format!("── {} ──", label), header_style)));

                    let child_tools: Vec<usize> = (start..end)
                        .filter(|&j| matches!(&msg.blocks[j], ContentBlock::ToolUse { .. } | ContentBlock::Event { .. }))
                        .collect();
                    let hidden = child_tools.len().saturating_sub(3);
                    if hidden > 0 {
                        lines.push(Line::from(Span::styled(
                            format!("│ +{hidden} more"), dim)));
                    }
                    for &ci in child_tools.iter().rev().take(3).collect::<Vec<_>>().iter().rev() {
                        let child_line = match &msg.blocks[*ci] {
                            ContentBlock::ToolUse { name, id, .. } => {
                                let pending = is_active_turn && id.as_deref().is_some_and(|i| !completed.contains(i));
                                let s = if pending {
                                    Style::default().fg(pending_pulse_color(tick)).add_modifier(Modifier::ITALIC)
                                } else { dim };
                                Line::from(Span::styled(format!("│ ▸ Tool: {name}"), s))
                            }
                            ContentBlock::Event { detail, .. } => {
                                let elabel = if detail.len() > 50 { &detail[..50] } else { detail.as_str() };
                                Line::from(Span::styled(format!("│ ▸ {elabel}"), dim))
                            }
                            _ => continue,
                        };
                        let li = lines.len();
                        lines.push(child_line);
                        inspectable.push(InspectableLine { line_index: li, block_ref: BlockRef { message_id: msg.id, block_index: *ci } });
                    }

                    lines.push(Line::from(Span::styled("──".to_string(), header_style)));
                }

                // Skip past AgentEnd
                index = if end < msg.blocks.len() { end + 1 } else { end };
                continue;
            }
            ContentBlock::AgentEnd { .. } => {
                // Orphan end — skip
            }
            ContentBlock::Event { name, detail } => {
                // Skip task lifecycle events — the C-shape section already shows this
                if is_task_lifecycle_event(name) {
                    index += 1;
                    continue;
                }
                let preview = if detail.len() > 60 {
                    format!("{}...", &detail[..60])
                } else {
                    detail.clone()
                };
                let text = if name == "exit_plan_mode" {
                    format!("▸ Mode change: {preview}")
                } else if name == "ask_user_question" {
                    format!("▸ Question: {preview}")
                } else {
                    format!("▸ Event: {preview}")
                };
                let li = lines.len();
                lines.push(Line::from(Span::styled(text, dim)));
                inspectable.push(InspectableLine { line_index: li, block_ref: BlockRef { message_id: msg.id, block_index: index } });
            }
        }
        index += 1;
    }

    if is_active_turn {
        lines.push(Line::from(thinking_animation(tick).spans));
    }
}

fn is_task_lifecycle_event(name: &str) -> bool {
    matches!(name, "task_started" | "task_progress" | "task_notification")
}

fn pending_pulse_color(tick: u64) -> Color {
    // Smooth pulse between white (255) and dark gray (90) for pending text.
    let phase = tick as f64 * std::f64::consts::PI * 2.0 / 90.0;
    let t = phase.sin() * 0.5 + 0.5;
    let value = (90.0 + (255.0 - 90.0) * t) as u8;
    Color::Rgb(value, value, value)
}

fn render_activity_inspector(frame: &mut Frame, app: &mut App) {
    let term = frame.area();
    let width = (term.width * 4 / 5).max(40);
    let height = (term.height * 4 / 5).max(10);
    let area = centered_rect(width, height, term);
    frame.render_widget(Clear, area);

    let (title, body) = app.inspector_content();
    let footer = "↑↓ scroll  Ctrl+Y copy  Esc close";
    let body = format!("{body}\n\n{footer}");

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(format!(" {title} "));

    let inner = block.inner(area);
    // Estimate content height for scroll clamping (lines + wrapping)
    let content_lines: usize = body
        .lines()
        .map(|l| {
            if inner.width == 0 {
                1
            } else {
                (l.len() as u16 / inner.width).max(1) as usize
            }
        })
        .sum();
    let max_scroll = (content_lines as u16).saturating_sub(inner.height);
    if app.inspector_scroll > max_scroll {
        app.inspector_scroll = max_scroll;
    }

    let paragraph = Paragraph::new(body)
        .block(block)
        .wrap(Wrap { trim: false })
        .scroll((app.inspector_scroll, 0));

    frame.render_widget(paragraph, area);
}

fn render_empty_state(frame: &mut Frame, app: &App, area: Rect) {
    let target = App::target_summary(app.target());
    let mut lines = vec![
        Line::from(""),
        Line::from(Span::styled(
            "0x0",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(Span::styled(
            format!("AI: {target}"),
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(Span::styled(
            format!("Server: {}", app.base_url),
            Style::default().fg(Color::DarkGray),
        )),
    ];

    if let Some(err) = &app.server_error {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!("Server error: {err}"),
            Style::default().fg(Color::Red),
        )));
    }

    lines.extend([
        Line::from(""),
        Line::from(Span::styled(
            "Type a message to begin.",
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(Span::styled(
            "Workgroup mode: use Command Palette > Create Workgroup",
            Style::default().fg(Color::DarkGray),
        )),
    ]);

    let text = Text::from(lines);
    let paragraph = Paragraph::new(text)
        .wrap(Wrap { trim: false })
        .alignment(ratatui::layout::Alignment::Center);

    frame.render_widget(paragraph, area);
}

/// Wrap a single line at character boundaries using display width, returning
/// the resulting visual lines.  Also computes the visual (row_offset, col) of
/// the cursor when `cursor_col` falls within this line.
fn wrap_line(line: &str, width: usize) -> (Vec<String>, usize) {
    if line.is_empty() {
        return (vec![String::new()], 1);
    }
    let mut visual_lines: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_w: usize = 0;
    for ch in line.chars() {
        let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if current_w + cw > width && current_w > 0 {
            visual_lines.push(std::mem::take(&mut current));
            current_w = 0;
        }
        current.push(ch);
        current_w += cw;
    }
    visual_lines.push(current);
    let count = visual_lines.len();
    (visual_lines, count)
}

fn render_input(frame: &mut Frame, app: &mut App, area: Rect) {
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(Style::default().fg(Color::DarkGray));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let lines = app.input.lines();
    let width = inner.width.max(1) as usize;
    let (cursor_row, cursor_col) = app.input.cursor();

    if lines.iter().all(|l| l.is_empty()) && lines.len() <= 1 {
        // Empty input — show placeholder
        let display = Paragraph::new(Span::styled(
            app.input_placeholder(),
            Style::default().fg(Color::DarkGray),
        ));
        frame.render_widget(display, inner);
        frame.set_cursor_position((inner.x, inner.y));
        return;
    }

    // Manually wrap each logical line at character boundaries so cursor
    // calculation and display are always in sync.
    let mut all_visual: Vec<Line> = Vec::new();
    let mut visual_y: u16 = 0;
    let mut visual_x: u16 = 0;

    for (i, line) in lines.iter().enumerate() {
        let (wrapped, _count) = wrap_line(line, width);
        if i == cursor_row {
            // Walk through wrapped segments to find the cursor's visual position.
            let mut chars_so_far: usize = 0;
            let mut found = false;
            for (vi, seg) in wrapped.iter().enumerate() {
                let seg_chars: usize = seg.chars().count();
                if !found && cursor_col <= chars_so_far + seg_chars {
                    visual_y = all_visual.len() as u16 + vi as u16;
                    // Compute display-width of characters before the cursor in this segment
                    let offset_in_seg = cursor_col - chars_so_far;
                    let prefix: String = seg.chars().take(offset_in_seg).collect();
                    visual_x = UnicodeWidthStr::width(prefix.as_str()) as u16;
                    found = true;
                }
                chars_so_far += seg_chars;
            }
            if !found {
                // Cursor past end of line — place at end of last segment
                visual_y = all_visual.len() as u16 + wrapped.len().saturating_sub(1) as u16;
                let last = wrapped.last().map(|s| s.as_str()).unwrap_or("");
                visual_x = UnicodeWidthStr::width(last) as u16;
            }
        }
        for seg in wrapped {
            all_visual.push(Line::from(seg));
        }
    }

    let max_visible = inner.height;
    let scroll_y: u16 = if visual_y >= max_visible {
        visual_y - max_visible + 1
    } else {
        0
    };

    let text = Text::from(all_visual);
    let display = Paragraph::new(text).scroll((scroll_y, 0));
    frame.render_widget(display, inner);

    // Draw cursor
    let cursor_screen_y = inner.y + visual_y.saturating_sub(scroll_y);
    let cursor_screen_x = inner.x + visual_x;
    if cursor_screen_y < inner.y + inner.height && cursor_screen_x < inner.x + inner.width {
        frame.set_cursor_position((cursor_screen_x, cursor_screen_y));
    }
}

fn compute_input_height(app: &App) -> u16 {
    // Estimate available width (terminal width minus borders). Use a sensible default
    // since we don't have the frame here; the actual render will scroll if needed.
    let approx_width = 80usize;
    let visual_lines: usize = app
        .input
        .lines()
        .iter()
        .map(|l| {
            let w = UnicodeWidthStr::width(l.as_str());
            if w == 0 { 1 } else { (w + approx_width - 1) / approx_width }
        })
        .sum();
    let line_count = visual_lines.max(1) as u16;
    // Min 3 (1 border + 2 content), max 11 (1 border + 10 content)
    (line_count + 1).clamp(3, 11)
}

fn compute_question_height(app: &App) -> u16 {
    if let Some(pq) = &app.pending_question {
        if let Some(entry) = pq.entries.get(pq.current) {
            // 1 border + 1 question + 1 blank + options + 1 blank + 1 footer = options + 5
            let option_count = entry.options.len() as u16;
            return (option_count + 5).clamp(6, 14);
        }
    }
    6
}

fn render_question_input(frame: &mut Frame, app: &App, area: Rect) {
    let pq = match &app.pending_question {
        Some(pq) => pq,
        None => return,
    };
    let entry = match pq.entries.get(pq.current) {
        Some(e) => e,
        None => return,
    };

    let mut lines: Vec<Line> = Vec::new();

    // Question text
    lines.push(Line::from(Span::styled(
        &entry.question,
        Style::default()
            .fg(Color::Yellow)
            .add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(""));

    // Vertical option list
    for (i, opt) in entry.options.iter().enumerate() {
        let is_selected = i == entry.selected;
        let marker = if is_selected { ">" } else { " " };
        let style = if is_selected {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        lines.push(Line::from(Span::styled(format!("{marker} {opt}"), style)));
    }

    // Footer
    lines.push(Line::from(""));
    let footer = if pq.entries.len() > 1 {
        format!(
            "↑↓ select  ←→ question ({}/{})  Enter send  Esc dismiss",
            pq.current + 1,
            pq.entries.len()
        )
    } else {
        "↑↓ select  Enter send  Esc dismiss".to_string()
    };
    lines.push(Line::from(Span::styled(
        footer,
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::ITALIC),
    )));

    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(Style::default().fg(Color::Yellow));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
    frame.render_widget(paragraph, inner);
}

fn render_help_overlay(frame: &mut Frame) {
    let area = centered_rect(60, 18, frame.area());

    frame.render_widget(Clear, area);

    let help_text = vec![
        Line::from(Span::styled(
            "Keybindings",
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from("Ctrl+P         Command palette"),
        Line::from("Ctrl+L         Choose LLM"),
        Line::from("Ctrl+M         Choose provider mode"),
        Line::from("Ctrl+E         Choose thinking effort"),
        Line::from("Enter          Send message"),
        Line::from("Shift+Enter    New line"),
        Line::from("Ctrl+J         New line"),
        Line::from("Ctrl+S         Conversation switcher"),
        Line::from("Ctrl+N         New conversation"),
        Line::from("Ctrl+D         Delete conversation"),
        Line::from("Ctrl+C         Cancel stream / quit (2x)"),
        Line::from("Inspector: Ctrl+Y   Copy raw inspected content"),
        Line::from("PageUp/Down    Scroll"),
        Line::from("Ctrl+Home/End  Jump top/bottom"),
        Line::from("Ctrl+P, Help    Open help"),
        Line::from(""),
        Line::from(Span::styled(
            "Press Esc to close",
            Style::default().fg(Color::DarkGray),
        )),
    ];

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(" Help ");

    let paragraph = Paragraph::new(help_text).block(block);
    frame.render_widget(paragraph, area);
}

fn render_command_palette(frame: &mut Frame, app: &App) {
    let visible_count = app.palette_commands.len().min(12);
    let height = (visible_count as u16) + 4;
    let area = centered_rect(52, height, frame.area());

    frame.render_widget(Clear, area);

    let mut lines: Vec<Line> = Vec::new();
    let max_visible = area.height.saturating_sub(4) as usize;
    let start = if app.palette_index >= max_visible {
        app.palette_index - max_visible + 1
    } else {
        0
    };

    for (i, cmd) in app
        .palette_commands
        .iter()
        .enumerate()
        .skip(start)
        .take(max_visible)
    {
        let is_selected = i == app.palette_index;
        let marker = if is_selected { ">" } else { " " };
        let text = format!("{marker} {:<24} {}", cmd.label(), cmd.shortcut());
        let style = if is_selected {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        lines.push(Line::from(Span::styled(text, style)));
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "↑↓ navigate  Enter run  Esc close",
        Style::default().fg(Color::DarkGray),
    )));

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(" Command Palette ");

    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, area);
}

fn render_agent_manager(frame: &mut Frame, app: &App) {
    let count = app
        .conversation
        .agents
        .as_ref()
        .map(|r| r.agents.len())
        .unwrap_or(0);
    let visible_count = count.min(12);
    let height = (visible_count as u16) + 5;
    let area = centered_rect(58, height.max(8), frame.area());

    frame.render_widget(Clear, area);

    let mut lines: Vec<Line> = Vec::new();
    if let Some(registry) = &app.conversation.agents {
        lines.push(Line::from(Span::styled(
            "Agents".to_string(),
            Style::default().fg(Color::DarkGray),
        )));
        lines.push(Line::from(""));
        for (i, agent) in registry.agents.iter().enumerate() {
            let is_selected = i == app.agent_manager_index;
            let marker = if is_selected { ">" } else { " " };
            let last = if i == registry.last_active { "*" } else { " " };
            let line = vec![
                Span::styled(
                    format!("{marker}{last} "),
                    if is_selected {
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default()
                    },
                ),
                Span::styled("● ", Style::default().fg(app.color_for_agent(&agent.name))),
                Span::raw(format!(
                    "{}  {}",
                    agent.name,
                    App::target_summary(&agent.target)
                )),
            ];
            lines.push(Line::from(line));
        }
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "a add agents  l model  m mode  e effort  r relay  d remove",
        Style::default().fg(Color::DarkGray),
    )));
    lines.push(Line::from(Span::styled(
        "Enter sets default agent  Esc close",
        Style::default().fg(Color::DarkGray),
    )));

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(" Manage Agents ");
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

fn render_llm_picker(frame: &mut Frame, app: &App) {
    let visible_count = app.llm_options.len().min(16);
    let height = (visible_count as u16) + 4; // border + title + footer
    let area = centered_rect(40, height, frame.area());

    frame.render_widget(Clear, area);

    let mut lines: Vec<Line> = Vec::new();

    if app.llm_options.is_empty() {
        lines.push(Line::from(Span::styled(
            "Loading providers...",
            Style::default().fg(Color::DarkGray),
        )));
    } else {
        // Compute scroll window for the list
        let max_visible = (area.height.saturating_sub(4)) as usize; // border + footer
        let start = if app.llm_index >= max_visible {
            app.llm_index - max_visible + 1
        } else {
            0
        };

        for (i, opt) in app
            .llm_options
            .iter()
            .enumerate()
            .skip(start)
            .take(max_visible)
        {
            let is_selected = i == app.llm_index;
            let marker = if is_selected { ">" } else { " " };
            let text = format!("{marker} {opt}");
            let style = if is_selected {
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            lines.push(Line::from(Span::styled(text, style)));
        }
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "↑↓ navigate  Enter select  Esc cancel",
        Style::default().fg(Color::DarkGray),
    )));

    let title = if let Some(agent_name) = app.picker_agent_name.as_deref() {
        format!(" Choose LLM ({agent_name}) ")
    } else {
        " Choose LLM ".to_string()
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(title);

    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, area);
}

fn render_mode_picker(frame: &mut Frame, app: &App) {
    let target = app.picker_target();
    let options = App::provider_mode_options(&target.provider);
    let area = centered_rect(42, (options.len() as u16) + 4, frame.area());

    frame.render_widget(Clear, area);

    let mut lines = Vec::new();
    for (i, mode) in options.iter().enumerate() {
        let is_selected = i == app.mode_index;
        let marker = if is_selected { ">" } else { " " };
        let label = App::provider_mode_label(&app.conversation.default_target.provider, mode);
        let text = format!("{marker} {label}");
        let style = if is_selected {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        lines.push(Line::from(Span::styled(text, style)));
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "↑↓ navigate  Enter select  Esc cancel",
        Style::default().fg(Color::DarkGray),
    )));

    let base_title = format!(" Choose {} ", App::provider_mode_kind(&target.provider));
    let title = if let Some(agent_name) = app.picker_agent_name.as_deref() {
        format!("{base_title}({agent_name})")
    } else {
        base_title
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(title);

    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, area);
}

fn render_effort_picker(frame: &mut Frame, app: &App) {
    let target = app.picker_target();
    let options = App::effort_options(&target.provider, &target.model);
    let area = centered_rect(32, (options.len() as u16) + 4, frame.area());

    frame.render_widget(Clear, area);

    let mut lines = Vec::new();
    for (i, effort) in options.iter().enumerate() {
        let is_selected = i == app.effort_index;
        let marker = if is_selected { ">" } else { " " };
        let text = format!("{marker} {effort}");
        let style = if is_selected {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        lines.push(Line::from(Span::styled(text, style)));
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "↑↓ navigate  Enter select  Esc cancel",
        Style::default().fg(Color::DarkGray),
    )));

    let title = if let Some(agent_name) = app.picker_agent_name.as_deref() {
        format!(" Choose Effort ({agent_name}) ")
    } else {
        " Choose Effort ".to_string()
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(title);

    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, area);
}

fn render_handoff_prompt(frame: &mut Frame, app: &App) {
    let area = centered_rect(50, 8, frame.area());

    frame.render_widget(Clear, area);

    let selected = app
        .handoff
        .as_ref()
        .map(|h| h.selected)
        .unwrap_or(HandoffMode::Summary);

    let summary_marker = if selected == HandoffMode::Summary {
        "(*)"
    } else {
        "( )"
    };
    let fresh_marker = if selected == HandoffMode::Fresh {
        "(*)"
    } else {
        "( )"
    };

    let lines = vec![
        Line::from(Span::styled(
            "How should context be handed off?",
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(Span::styled(
            format!("{summary_marker} Summary — outgoing model generates context"),
            if selected == HandoffMode::Summary {
                Style::default().fg(Color::Cyan)
            } else {
                Style::default()
            },
        )),
        Line::from(Span::styled(
            format!("{fresh_marker} Fresh — start with no prior context"),
            if selected == HandoffMode::Fresh {
                Style::default().fg(Color::Cyan)
            } else {
                Style::default()
            },
        )),
        Line::from(""),
        Line::from(Span::styled(
            "Enter confirm  Esc cancel",
            Style::default().fg(Color::DarkGray),
        )),
    ];

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow))
        .title(" Handoff ");

    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, area);
}

fn render_conversation_switcher(frame: &mut Frame, app: &App) {
    let max_visible = 12usize;
    let height = (app.conversations.len().min(max_visible) as u16).max(3) + 4;
    let area = centered_rect(60, height, frame.area());

    frame.render_widget(Clear, area);

    let mut lines: Vec<Line> = Vec::new();

    if app.conversations.is_empty() {
        lines.push(Line::from(Span::styled(
            "No conversations yet.",
            Style::default().fg(Color::DarkGray),
        )));
    } else {
        let start = if app.switcher_index >= max_visible {
            app.switcher_index - max_visible + 1
        } else {
            0
        };

        for (i, conv) in app
            .conversations
            .iter()
            .enumerate()
            .skip(start)
            .take(max_visible)
        {
            let is_selected = i == app.switcher_index;
            let is_current = conv.id == app.conversation.id;

            let marker = if is_selected { ">" } else { " " };
            let title = if conv.title.is_empty() {
                "(untitled)"
            } else {
                &conv.title
            };
            let target_label = format!(
                "{}/{}",
                conv.default_target.provider, conv.default_target.model
            );
            let age = format_relative_time(conv.updated_at);

            // Compact cwd display
            let cwd_str = compact_path(&conv.cwd);
            let cwd_mismatch = conv.cwd != app.cwd;

            let text = format!("{marker} {title:<30} {target_label:<16} {age:>6}",);

            let style = if is_selected {
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else if is_current {
                Style::default().fg(Color::Green)
            } else {
                Style::default()
            };

            lines.push(Line::from(Span::styled(text, style)));

            // Show cwd on a sub-line if it differs from current
            if cwd_mismatch {
                let cwd_line = format!("    {cwd_str}");
                lines.push(Line::from(Span::styled(
                    cwd_line,
                    Style::default()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::ITALIC),
                )));
            }
        }
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "↑↓ navigate  Enter open  ^N new  ^D delete  Esc close",
        Style::default().fg(Color::DarkGray),
    )));

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(" Conversations ");

    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, area);
}

fn render_confirm_delete(frame: &mut Frame, app: &App) {
    let area = centered_rect(40, 6, frame.area());

    frame.render_widget(Clear, area);

    let title = match app.pending_delete {
        Some(DeleteTarget::Conversation(id)) => app
            .conversations
            .iter()
            .find(|conv| conv.id == id)
            .map(|conv| {
                if conv.title.is_empty() {
                    "(untitled)"
                } else {
                    conv.title.as_str()
                }
            })
            .unwrap_or("(untitled)"),
        _ => {
            if app.conversation.title.is_empty() {
                "(untitled)"
            } else {
                &app.conversation.title
            }
        }
    };

    let lines = vec![
        Line::from(Span::styled(
            "Delete this conversation?",
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            title.to_string(),
            Style::default().fg(Color::Yellow),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "y/Enter confirm  n/Esc cancel",
            Style::default().fg(Color::DarkGray),
        )),
    ];

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Red))
        .title(" Confirm Delete ");

    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, area);
}

fn format_relative_time(dt: chrono::DateTime<chrono::Utc>) -> String {
    let now = chrono::Utc::now();
    let diff = now.signed_duration_since(dt);

    if diff.num_seconds() < 60 {
        "now".to_string()
    } else if diff.num_minutes() < 60 {
        format!("{}m", diff.num_minutes())
    } else if diff.num_hours() < 24 {
        format!("{}h", diff.num_hours())
    } else if diff.num_days() < 30 {
        format!("{}d", diff.num_days())
    } else {
        format!("{}mo", diff.num_days() / 30)
    }
}

fn compact_path(path: &std::path::Path) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Ok(stripped) = path.strip_prefix(&home) {
            return format!("~/{}", stripped.display());
        }
    }
    path.display().to_string()
}

/// Generate a thinking animation line: 5 dots with wider color variation.
fn thinking_animation(tick: u64) -> Line<'static> {
    let dot = "•";
    let offsets: [u64; 5] = [0, 18, 36, 54, 72];

    let spans: Vec<Span> = offsets
        .iter()
        .enumerate()
        .map(|(index, offset)| {
            let phase = (tick.wrapping_add(*offset)) as f64;
            let color = phase_to_color(phase);
            let text = if index + 1 == offsets.len() {
                dot.to_string()
            } else {
                format!("{dot} ")
            };
            Span::styled(text, Style::default().fg(color))
        })
        .collect();

    Line::from(spans)
}

/// Convert an animation phase to an RGB color.
/// Cycles through a broader, brighter palette than the default TUI colors.
fn phase_to_color(phase: f64) -> Color {
    let theta = phase * std::f64::consts::PI * 2.0 / 140.0;
    let r = ((theta.sin() * 0.5 + 0.5) * 155.0 + 60.0) as u8;
    let g = (((theta + 2.1).sin() * 0.5 + 0.5) * 155.0 + 60.0) as u8;
    let b = (((theta + 4.2).sin() * 0.5 + 0.5) * 155.0 + 60.0) as u8;

    Color::Rgb(r, g, b)
}

fn centered_rect(width: u16, height: u16, area: Rect) -> Rect {
    let x = area.x + area.width.saturating_sub(width) / 2;
    let y = area.y + area.height.saturating_sub(height) / 2;
    Rect::new(x, y, width.min(area.width), height.min(area.height))
}
