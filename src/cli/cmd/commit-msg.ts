import { cmd } from "./cmd"
import { resolveConfig } from "@/git/config"
import { getStagedContext } from "@/git/git"
import { generate } from "@/git/llm"
import { buildPrompt } from "@/git/prompt"

export const CommitMsgCommand = cmd({
  command: "commit-msg",
  describe: "generate a commit message from staged changes",
  builder: (yargs) =>
    yargs
      .option("provider", {
        type: "string",
        describe: "LLM provider (claude or codex)",
        choices: ["claude", "codex"],
      })
      .option("model", {
        type: "string",
        describe: "Model ID",
      })
      .option("verbose", {
        type: "boolean",
        describe: "Enable debug output",
        default: false,
      }),
  handler: async (args) => {
    const config = resolveConfig({
      provider: args.provider as string | undefined,
      model: args.model as string | undefined,
      verbose: args.verbose as boolean | undefined,
    })
    process.stderr.write(`Provider: ${config.provider} (${config.model})\n`)
    process.stderr.write("Reading staged changes...\n")
    const ctx = await getStagedContext()
    process.stderr.write(`${ctx.files.length} file${ctx.files.length === 1 ? "" : "s"} staged\n`)
    const prompt = buildPrompt(ctx)
    process.stderr.write("Generating commit message...\n")
    const message = await generate(config, prompt)
    process.stderr.write("Done\n")
    process.stdout.write(message + "\n")
  },
})
