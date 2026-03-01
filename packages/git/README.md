# @anonymous-dev/0x0-git

Git hook tool that generates commit messages using AI. Reads staged changes, sends them to a locally running 0x0 server, and writes back a commit message.

## Prerequisites

- [0x0](https://github.com/anonymous-dev-org/0x0) installed (the `0x0-git` binary is bundled with it)
- A running 0x0 server on `localhost:4096` (starts automatically if you've used `0x0` before, or run `0x0 server`)
- `ANTHROPIC_API_KEY` set (or `OPENAI_API_KEY` with Codex CLI for OpenAI)

## Installation

Install the git hook in your repo:

```bash
0x0-git hook install
```

This adds a `prepare-commit-msg` hook. Now when you run `git commit` (without `-m`), it auto-generates a commit message from your staged changes.

To remove:

```bash
0x0-git hook uninstall
```

Compatible with husky v9.

## Usage

```bash
# Generate a commit message from staged changes (used by the hook)
0x0-git commit-msg

# With explicit provider/model
0x0-git commit-msg --provider claude --model claude-haiku-4-5-20251001
0x0-git commit-msg --provider codex --model o4-mini
```

## Configuration

| Source | Variable | Description |
|--------|----------|-------------|
| CLI flag | `--provider` | `claude` or `codex` |
| CLI flag | `--model` | Model name |
| CLI flag | `--verbose` | Enable debug output |
| Env var | `GIT_AI_PROVIDER` | Provider override |
| Env var | `GIT_AI_MODEL` | Model override |
| Env var | `GIT_AI_URL` | Server URL (default: `http://localhost:4096`) |
| Env var | `GIT_AI_AUTH` | HTTP basic auth as `user:pass` |
| Env var | `GIT_AI_DEBUG` | Set to `1` for verbose output |

Resolution order: CLI flags > env vars > auto-detect (prefers Claude if available).

## How It Works

1. Reads staged files via `git diff --cached`
2. Builds a prompt from the diff context
3. Sends it to the 0x0 server's LLM endpoint
4. Writes the generated message to stdout (the hook pipes it into the commit message file)

## Development

```bash
bun run build        # Build binary
bun run typecheck    # Type check
```
