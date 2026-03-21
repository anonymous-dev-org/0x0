import { cmd } from "./cmd"
import { installHook, uninstallHook } from "@/git/hook"

export const HookCommand = cmd({
  command: "hook <action>",
  describe: "manage git prepare-commit-msg hook",
  builder: (yargs) =>
    yargs.positional("action", {
      type: "string",
      describe: "install or uninstall",
      choices: ["install", "uninstall"],
      demandOption: true,
    }),
  handler: async (args) => {
    const action = args.action as string
    if (action === "install") {
      const result = await installHook()
      console.log(result)
    } else if (action === "uninstall") {
      const result = await uninstallHook()
      console.log(result)
    } else {
      console.error("Usage: 0x0 hook [install|uninstall]")
      process.exit(1)
    }
  },
})
