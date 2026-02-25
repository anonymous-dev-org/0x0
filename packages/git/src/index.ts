import { resolveConfig } from "./config"
import { generate } from "./llm"
import { getStagedContext } from "./git"
import { buildPrompt } from "./prompt"
import { installHook, uninstallHook } from "./hook"

const args = process.argv.slice(2)
const command = args[0]

function parseFlags(args: string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" && args[i + 1]) {
      flags.provider = args[++i]
    } else if (args[i] === "--model" && args[i + 1]) {
      flags.model = args[++i]
    }
  }
  return flags
}

async function commitMsg() {
  const flags = parseFlags(args)
  const config = resolveConfig(flags)
  process.stderr.write(`Provider: ${config.provider} (${config.model})\n`)
  process.stderr.write("Reading staged changes...\n")
  const ctx = await getStagedContext()
  process.stderr.write(`${ctx.files.length} file${ctx.files.length === 1 ? "" : "s"} staged\n`)
  const prompt = buildPrompt(ctx)
  process.stderr.write("Generating commit message...\n")
  const message = await generate(config, prompt)
  process.stderr.write("Done\n")
  process.stdout.write(message + "\n")
}

async function hookCommand() {
  const sub = args[1]
  if (sub === "install") {
    const result = await installHook()
    console.log(result)
  } else if (sub === "uninstall") {
    const result = await uninstallHook()
    console.log(result)
  } else {
    console.error("Usage: 0x0-git hook [install|uninstall]")
    process.exit(1)
  }
}

async function main() {
  try {
    switch (command) {
      case "commit-msg":
        await commitMsg()
        break
      case "hook":
        await hookCommand()
        break
      default:
        console.error(
          `Usage:
  0x0-git commit-msg [--provider claude|codex] [--model <model>]
  0x0-git hook install
  0x0-git hook uninstall`,
        )
        process.exit(1)
    }
  } catch (err: any) {
    process.stderr.write(`\nError: ${err.message}\n`)
    if (err.cause) {
      process.stderr.write(`Cause: ${err.cause.message ?? err.cause}\n`)
    }
    process.exit(1)
  }
}

main()
