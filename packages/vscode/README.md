# 0x0 for VS Code

A VS Code extension that integrates 0x0 directly into your editor.

## Prerequisites

The [0x0 CLI](https://github.com/anomalyco/0x0) must be installed on your system.

## Commands

| Command | Keybinding (Mac) | Keybinding (Windows/Linux) | Description |
|---------|-------------------|----------------------------|-------------|
| Open 0x0 | `Cmd+Esc` | `Ctrl+Esc` | Open 0x0 in a split terminal, or focus an existing session |
| Open 0x0 in new tab | `Cmd+Shift+Esc` | `Ctrl+Shift+Esc` | Start a new 0x0 terminal session |
| Add Filepath to Terminal | `Cmd+Option+K` | `Ctrl+Alt+K` | Insert a file reference (e.g. `@File#L37-42`) into the active 0x0 terminal |

## Supported Editors

- Visual Studio Code
- VS Code Insiders
- Cursor
- Windsurf
- VSCodium

## Support

If you encounter issues or have feedback, please create an issue at https://github.com/anomalyco/0x0/issues.

## Development

1. `code packages/vscode` - Open the `packages/vscode` directory in VS Code. **Do not open from repo root.**
2. `bun install` - Run inside the `packages/vscode` directory.
3. Press `F5` to start debugging - This launches a new VS Code window with the extension loaded.

#### Making Changes

`tsc` and `esbuild` watchers run automatically during debugging (visible in the Terminal tab). Changes to the extension are automatically rebuilt in the background.

To test your changes:

1. In the debug VS Code window, press `Cmd+Shift+P`
2. Search for `Developer: Reload Window`
3. Reload to see your changes without restarting the debug session
