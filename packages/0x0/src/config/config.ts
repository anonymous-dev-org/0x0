import { Log } from "../util/log"
import path from "path"
import os from "os"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { mergeDeep, unique } from "remeda"
import { Global } from "../global"
import fs from "fs/promises"
import { lazy } from "../util/lazy"
import { NamedError } from "@anonymous-dev/0x0-util/error"
import { Instance } from "../project/instance"
import { LSPServer } from "../lsp/server"
import { BunProc } from "@/bun"
import { ConfigMarkdown } from "./markdown"
import { constants, existsSync } from "fs"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Event } from "../server/event"
import { proxied } from "@/util/proxied"
import { iife } from "@/util/iife"
import PROMPT_DEFAULT from "../session/prompt/default_system_prompt.txt"
import YAML from "yaml"

export namespace Config {
  const ModelId = z.string()

  const log = Log.create({ service: "config" })
  const configSchemaURL = "https://zeroxzero.ai/config.json"
  const yamlLanguageServerSchema = `# yaml-language-server: $schema=${configSchemaURL}`
  const configFiles = ["config.yaml"] as const
  const projectConfigDirs = [".0x0"] as const
  const LEGACY_TOOL_KEYS = {
    patch: "apply_patch",
    glob: 'search (mode: "files")',
    grep: 'search (mode: "content")',
    list: 'search (mode: "files")',
    webfetch: 'search_remote (mode: "fetch")',
    websearch: 'search_remote (mode: "web")',
    codesearch: 'search_remote (mode: "code")',
  } as const

  function legacyToolIssue(tool: string) {
    const replacement = LEGACY_TOOL_KEYS[tool as keyof typeof LEGACY_TOOL_KEYS]
    return replacement
      ? `Legacy tool key \"${tool}\" is no longer supported in tools config. Use \"${replacement}\" instead.`
      : undefined
  }

  function legacyPermissionIssue(permission: string) {
    if (permission === "patch") {
      return 'Legacy permission key "patch" is no longer supported. Use "edit" instead.'
    }
    const replacement = LEGACY_TOOL_KEYS[permission as keyof typeof LEGACY_TOOL_KEYS]
    return replacement
      ? `Legacy permission key \"${permission}\" is no longer supported. Use \"${replacement}\" instead.`
      : undefined
  }

  // Managed settings directory for enterprise deployments (highest priority, admin-controlled)
  // These settings override all user and project settings
  function getManagedConfigDir(): string {
    switch (process.platform) {
      case "darwin":
        return "/Library/Application Support/zeroxzero"
      case "win32":
        return path.join(process.env.ProgramData || "C:\\ProgramData", "zeroxzero")
      default:
        return "/etc/zeroxzero"
    }
  }

  const managedConfigDir = process.env.ZEROXZERO_TEST_MANAGED_CONFIG_DIR || getManagedConfigDir()

  // Custom merge function that concatenates array fields instead of replacing them
  function mergeConfigConcatArrays(target: Info, source: Info): Info {
    const merged = mergeDeep(target, source)
    if (target.instructions && source.instructions) {
      merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
    }
    if (target.knowledge_base && source.knowledge_base) {
      merged.knowledge_base = Array.from(new Set([...target.knowledge_base, ...source.knowledge_base]))
    }
    return merged
  }

  function isYamlPath(filepath: string) {
    return filepath.endsWith(".yaml") || filepath.endsWith(".yml")
  }

  function addYamlSchemaMetadata(original: string) {
    const hasTrailingNewline = original.endsWith("\n")
    const lines = original.split("\n")

    if (!lines.some((line) => line.includes("yaml-language-server: $schema="))) {
      lines.unshift(yamlLanguageServerSchema)
    }

    if (!lines.some((line) => /^\s*\$schema\s*:/.test(line))) {
      const insertAt = lines[0]?.includes("yaml-language-server: $schema=") ? 1 : 0
      lines.splice(insertAt, 0, `$schema: ${configSchemaURL}`)
    }

    const result = lines.join("\n")
    return hasTrailingNewline ? `${result}\n` : result
  }

  function formatYamlConfig(config: Info, original?: string) {
    const normalized = {
      ...config,
      $schema: config.$schema ?? configSchemaURL,
    }

    let output = YAML.stringify(normalized, { blockQuote: "literal" })
    if (!original?.includes("yaml-language-server: $schema=")) {
      output = `${yamlLanguageServerSchema}\n${output}`
    }
    return output
  }

  const COMPACTION_PROMPT_DEFAULT =
    "Provide a detailed prompt for continuing our conversation above. Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next considering new session will not have access to our conversation."

  function defaultConfig(): Info {
    return {
      $schema: configSchemaURL,
      system_prompt: PROMPT_DEFAULT.trim(),
      compaction: {
        max_words_before_compact: 12_000,
        prompt: COMPACTION_PROMPT_DEFAULT,
      },
      knowledge_base: [],
      agent: {
        builder: {
          name: "Builder",
          color: "#6EE7B7",
          thinking_effort: "medium",
          description: "The default agent. Executes tools based on configured permissions.",
          actions: {
            "claude-code": {
              Bash: "allow", Read: "allow", Edit: "allow", Write: "allow",
              MultiEdit: "allow", NotebookEdit: "allow", Glob: "allow", Grep: "allow",
              WebFetch: "allow", WebSearch: "allow", Task: "allow",
              TodoWrite: "allow", AskUserQuestion: "allow",
            },
            codex: { commandExecution: "allow", fileChange: "allow" },
          },
          prompt: [
            "You are the executioner. You take the plan and ship it. No thinking in circles, no second-guessing, no over-engineering.",
            "",
            "EXECUTION PROTOCOL:",
            "1. Read the plan. Parse every to-do item.",
            "2. Use `todowrite` to create a checklist from the plan items BEFORE writing any code.",
            "3. Execute items in order. Mark each item in-progress when you start, completed when you finish.",
            "4. After completing all items, verify: run tests, check types, confirm the code actually works.",
            "5. If all checks pass, report done. If something fails, fix it or escalate.",
            "",
            "CODE STANDARDS:",
            "- Every line earns its place. Less is more.",
            "- `any` and `as` are banned. Type it properly or don't type it at all.",
            "- No nesting deeper than 3 levels. One function, one job. If it doesn't fit on a screen, split it.",
            '- Variable and function names describe exactly what they store and do. `x` for a user email is a crime. `doStuff()` is a felony.',
            "- No comments unless the logic is genuinely non-obvious. The code speaks for itself. `// increment i` gets your keyboard confiscated.",
            "- No clever code. If you're proud of how tricky it is, rewrite it to be obviously correct.",
            "- Don't DRY until you've repeated yourself three times. Bad abstractions are worse than duplication.",
            "- No over-engineering. No design pattern flexing. Simple code that works beats elegant code that confuses.",
            "",
            "WHEN THE PLAN IS UNCLEAR:",
            "Do NOT guess. Use the `question` tool to ask the user for clarification. Say exactly what's ambiguous and what you need to proceed. Stop execution on that item until you get an answer. Guessing is how bugs are born.",
            "",
            "WHEN SOMETHING BREAKS:",
            "- If a test fails: read the error, fix the root cause, re-run. Don't patch symptoms.",
            "- If the plan is wrong (conflicts with actual code/types/APIs): stop, explain what's wrong and what the fix should be, ask the user before deviating from the plan.",
            "- If a dependency is missing or a tool fails: document what happened, try an alternative approach, escalate if stuck.",
            "",
            "You don't leave TODOs for \"later.\" You don't skip tests. You don't ship without verifying.",
          ].join("\n"),
        },
        planner: {
          name: "Planner",
          color: "#A5B4FC",
          thinking_effort: "high",
          description: "Planning agent. Disallows all edit tools.",
          actions: {
            "claude-code": {
              Read: "allow", Glob: "allow", Grep: "allow",
              WebFetch: "allow", WebSearch: "allow", Task: "allow",
              AskUserQuestion: "allow",
            },
          },
          prompt: [
            "You are the architect. You don't write code. You write the battle plan that makes code inevitable.",
            "",
            "STEP 1 — INTERROGATE",
            "Before you plan anything, you extract requirements. Ask the user:",
            "- What exactly should happen? What's the expected input/output/behavior?",
            "- What are the constraints (performance, compatibility, dependencies)?",
            "- What existing code touches this? What must NOT change?",
            "- What should happen on failure/edge cases?",
            "",
            'Keep asking until you can describe the feature without any "probably" or "I think." If the user says "just do X," ask why, what if X fails, and whether they\'ve considered alternatives.',
            "",
            "EXIT CRITERIA: You stop interrogating when you can write a one-sentence summary of the goal that the user confirms is correct, AND you know every boundary condition.",
            "",
            "STEP 2 — READ THE CODE AND DOCS",
            "Once requirements are locked:",
            "- Use `search` and `read` to study every file that will be touched or is related.",
            "- Use `search_remote` to fetch official documentation for any library, API, or framework involved.",
            "- Identify existing patterns, types, schemas, naming conventions, and test patterns in the codebase.",
            "- You NEVER plan based on assumptions about what exists. You verify.",
            "",
            "STEP 3 — THE PLAN",
            "Produce a numbered to-do list. Each item MUST include:",
            "- [ ] **Action**: Create / Modify / Delete",
            "- [ ] **File**: Exact file path",
            "- [ ] **What**: Specific functions, types, exports, or config keys to add/change/remove",
            "- [ ] **How**: Implementation details — logic, signatures, return types, error handling",
            "- [ ] **Why**: One sentence connecting this item to the requirement",
            '- [ ] **Tests**: What to test for this item (or "N/A — covered by item #X")',
            "",
            'If a to-do item doesn\'t have a file path and specific implementation details, delete it and rewrite it. "Implement the feature" is not a to-do — it\'s a wish.',
            "",
            "After writing the plan, review it against the requirements from Step 1. Every requirement must map to at least one to-do item. Every to-do item must map to a requirement. If there's a gap, fix it before presenting.",
            "",
            "OUTPUT FORMAT:",
            "1. **Goal**: One-sentence summary",
            "2. **Requirements**: Numbered list of confirmed requirements",
            "3. **Plan**: Numbered to-do checklist (format above)",
            "4. **Risks**: Anything that could go wrong and how to handle it",
            "",
            "You never skip steps. You never assume requirements. You never plan without reading first.",
          ].join("\n"),
        },
      },
    }
  }

  async function ensureDefaultGlobalConfigFile() {
    const existing = await discoverGlobalConfigFiles()
    if (existing.length > 1) {
      throw new ConflictError({
        scope: "global",
        files: existing,
      })
    }
    if (existing.length === 1) return

    const defaultPath = path.join(Global.Path.config, configFiles[0])
    const defaultText = formatYamlConfig(defaultConfig())
    await Bun.write(defaultPath, defaultText)
  }

  async function discoverGlobalConfigFiles() {
    const candidates = configFiles.map((file) => path.join(Global.Path.config, file))
    const existing = await Promise.all(
      candidates.map(async (candidate) => ((await Bun.file(candidate).exists()) ? candidate : undefined)),
    )
    return existing.filter((file): file is string => Boolean(file))
  }

  function walkUpDirectories(start: string, stop?: string) {
    const directories = [] as string[]
    let current = start
    while (true) {
      directories.push(current)
      if (current === stop) break
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return directories
  }

  async function discoverProjectConfigFiles(start: string, stop?: string) {
    const files = [] as string[]
    for (const dir of walkUpDirectories(start, stop).toReversed()) {
      const candidates = projectConfigDirs.flatMap((prefix) =>
        configFiles.map((file) => (prefix ? path.join(dir, prefix, file) : path.join(dir, file))),
      )
      const existing = await Promise.all(
        candidates.map(async (candidate) => ((await Bun.file(candidate).exists()) ? candidate : undefined)),
      )
      const found = existing.filter((file): file is string => Boolean(file))
      if (found.length > 1) {
        throw new ConflictError({
          scope: "project",
          files: found,
        })
      }
      if (found.length === 1) {
        const f = found[0]
        if (f !== undefined) files.push(f)
      }
    }
    return files
  }

  export const state = Instance.state(async () => {
    // Config loading order (low -> high precedence): https://zeroxzero.ai/docs/config#precedence-order
    // 1) Global config (~/.config/0x0/config.yaml)
    // 2) Global provider configs (~/.config/0x0/providers/*.yaml)
    // 3) Project config (.0x0/config.yaml)
    // 4) Project provider configs (.0x0/providers/*.yaml)
    // 5) .zeroxzero directories (.zeroxzero/agents/, .zeroxzero/commands/, .zeroxzero/plugins/, .zeroxzero/config.yaml)
    // Managed config directory is enterprise-only and always overrides everything above.
    let result: Info = {}

    // Global user config.
    result = mergeConfigConcatArrays(result, await global())

    // Global provider configs (~/.config/0x0/providers/*.yaml) override global config.
    const { loadGlobalProviders, loadProjectProviders } = await import("./providers")
    for (const providerConfig of await loadGlobalProviders()) {
      result = mergeConfigConcatArrays(result, providerConfig)
    }

    // Project config overrides global and remote config.
    const projectFiles = await discoverProjectConfigFiles(Instance.directory, Instance.worktree)
    for (const resolved of projectFiles) {
      result = mergeConfigConcatArrays(result, await loadFile(resolved))
    }
    for (const providerConfig of await loadProjectProviders(Instance.worktree)) {
      result = mergeConfigConcatArrays(result, providerConfig)
    }

    result.agent = result.agent || {}

    const directories = [
      Global.Path.config,
      // Scan project .zeroxzero/ directories
      ...(await Array.fromAsync(
        Filesystem.up({
          targets: [".zeroxzero"],
          start: Instance.directory,
          stop: Instance.worktree,
        }),
      )),
      // Always scan ~/.zeroxzero/ (user home directory)
      ...(await Array.fromAsync(
        Filesystem.up({
          targets: [".zeroxzero"],
          start: Global.Path.home,
          stop: Global.Path.home,
        }),
      )),
    ]

    const deps: Promise<void>[] = []

    for (const dir of unique(directories)) {
      const stat = await fs.stat(dir).catch(() => undefined)
      if (!stat?.isDirectory()) continue

      if (dir.endsWith(".zeroxzero")) {
        for (const file of configFiles) {
          log.debug(`loading config from ${path.join(dir, file)}`)
          result = mergeConfigConcatArrays(result, await loadFile(path.join(dir, file)))
          result.agent ??= {}
        }
      }

      deps.push(
        iife(async () => {
          const shouldInstall = await needsInstall(dir)
          if (shouldInstall) await installDependencies(dir)
        }),
      )

      result.command = mergeDeep(result.command ?? {}, await loadCommand(dir))
      result.agent = mergeDeep(result.agent, await loadAgent(dir))
    }

    // Load managed config files last (highest priority) - enterprise admin-controlled
    // Kept separate from directories array to avoid write operations when installing plugins
    // which would fail on system directories requiring elevated permissions
    // This way it only loads config file and not skills/plugins/commands
    if (existsSync(managedConfigDir)) {
      for (const file of configFiles) {
        result = mergeConfigConcatArrays(result, await loadFile(path.join(managedConfigDir, file)))
      }
    }

    if (!result.username) result.username = os.userInfo().username

    // Handle migration from autoshare to share field
    if (result.autoshare === true && !result.share) {
      result.share = "auto"
    }

    if (!result.keybinds) result.keybinds = Info.shape.keybinds.parse({})

    return {
      config: result,
      directories,
      deps,
    }
  })

  export async function waitForDependencies() {
    const deps = await state().then((x) => x.deps)
    if (!deps.length) return
    const start = performance.now()
    await Promise.all(deps)
    log.debug("dependencies ready", {
      count: deps.length,
      duration_ms: Math.round(performance.now() - start),
    })
  }

  export async function installDependencies(dir: string) {
    const pkg = path.join(dir, "package.json")
    const pkgExists = await Bun.file(pkg).exists()
    if (!pkgExists) return

    const gitignore = path.join(dir, ".gitignore")
    const hasGitIgnore = await Bun.file(gitignore).exists()
    if (!hasGitIgnore) await Bun.write(gitignore, ["node_modules", "bun.lock", ".gitignore"].join("\n"))

    // Install any dependencies defined in the package.json
    // This allows custom tools to use external packages
    await BunProc.run(
      [
        "install",
        // TODO: get rid of this case (see: https://github.com/oven-sh/bun/issues/19936)
        ...(proxied() ? ["--no-cache"] : []),
      ],
      { cwd: dir },
    ).catch((e) => log.warn("bun install failed", { error: e }))
  }

  async function isWritable(dir: string) {
    try {
      await fs.access(dir, constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  async function needsInstall(dir: string) {
    // Some config dirs may be read-only.
    // Installing deps there will fail; skip installation in that case.
    const writable = await isWritable(dir)
    if (!writable) {
      log.debug("config dir is not writable, skipping dependency install", { dir })
      return false
    }

    const pkg = path.join(dir, "package.json")
    const pkgFile = Bun.file(pkg)
    const pkgExists = await pkgFile.exists()
    if (!pkgExists) return false

    const nodeModules = path.join(dir, "node_modules")
    if (!existsSync(nodeModules)) return true

    return false
  }

  function rel(item: string, patterns: string[]) {
    for (const pattern of patterns) {
      const index = item.indexOf(pattern)
      if (index === -1) continue
      return item.slice(index + pattern.length)
    }
  }

  function trim(file: string) {
    const ext = path.extname(file)
    return ext.length ? file.slice(0, -ext.length) : file
  }

  const COMMAND_GLOB = new Bun.Glob("{command,commands}/**/*.md")
  async function loadCommand(dir: string) {
    const result: Record<string, Command> = {}
    for await (const item of COMMAND_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse command ${item}`
        const { Session } = await import("@/session")
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load command", { command: item, err })
        return undefined
      })
      if (!md) continue

      const patterns = ["/.zeroxzero/command/", "/.zeroxzero/commands/", "/command/", "/commands/"]
      const file = rel(item, patterns) ?? path.basename(item)
      const name = trim(file)

      const config = {
        name,
        ...md.data,
        template: md.content.trim(),
      }
      const parsed = Command.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }

  const AGENT_GLOB = new Bun.Glob("{agent,agents}/**/*.md")
  async function loadAgent(dir: string) {
    const result: Record<string, Agent> = {}

    for await (const item of AGENT_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse agent ${item}`
        const { Session } = await import("@/session")
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load agent", { agent: item, err })
        return undefined
      })
      if (!md) continue

      const patterns = ["/.zeroxzero/agent/", "/.zeroxzero/agents/", "/agent/", "/agents/"]
      const file = rel(item, patterns) ?? path.basename(item)
      const agentName = trim(file)

      const config = {
        name: agentName,
        ...md.data,
        prompt: md.content.trim(),
      }
      const parsed = Agent.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }

  export const McpLocal = z
    .object({
      type: z.literal("local").describe("Type of MCP server connection"),
      command: z.string().array().describe("Command and arguments to run the MCP server"),
      environment: z
        .record(z.string(), z.string())
        .optional()
        .describe("Environment variables to set when running the MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    })
    .strict()
    .meta({
      ref: "McpLocalConfig",
    })

  export const McpOAuth = z
    .object({
      clientId: z
        .string()
        .optional()
        .describe("OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted."),
      clientSecret: z.string().optional().describe("OAuth client secret (if required by the authorization server)"),
      scope: z.string().optional().describe("OAuth scopes to request during authorization"),
    })
    .strict()
    .meta({
      ref: "McpOAuthConfig",
    })
  export type McpOAuth = z.infer<typeof McpOAuth>

  export const McpRemote = z
    .object({
      type: z.literal("remote").describe("Type of MCP server connection"),
      url: z.string().describe("URL of the remote MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      headers: z.record(z.string(), z.string()).optional().describe("Headers to send with the request"),
      oauth: z
        .union([McpOAuth, z.literal(false)])
        .optional()
        .describe(
          "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    })
    .strict()
    .meta({
      ref: "McpRemoteConfig",
    })

  export const Mcp = z.discriminatedUnion("type", [McpLocal, McpRemote])
  export type Mcp = z.infer<typeof Mcp>

  export const PermissionAction = z.enum(["ask", "allow", "deny"]).meta({
    ref: "PermissionActionConfig",
  })
  export type PermissionAction = z.infer<typeof PermissionAction>

  export const PermissionObject = z.record(z.string(), PermissionAction).meta({
    ref: "PermissionObjectConfig",
  })
  export type PermissionObject = z.infer<typeof PermissionObject>

  export const PermissionRule = z.union([PermissionAction, PermissionObject]).meta({
    ref: "PermissionRuleConfig",
  })
  export type PermissionRule = z.infer<typeof PermissionRule>

  // Capture original key order before zod reorders, then rebuild in original order
  const permissionPreprocess = (val: unknown) => {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      return { __originalKeys: Object.keys(val), ...val }
    }
    return val
  }

  const permissionTransform = (x: unknown): Record<string, PermissionRule> => {
    if (typeof x === "string") return { "*": x as PermissionAction }
    const obj = x as { __originalKeys?: string[] } & Record<string, unknown>
    const { __originalKeys, ...rest } = obj
    if (!__originalKeys) return rest as Record<string, PermissionRule>
    const result: Record<string, PermissionRule> = {}
    for (const key of __originalKeys) {
      if (key in rest) result[key] = rest[key] as PermissionRule
    }
    return result
  }

  export const Permission = z
    .preprocess(
      permissionPreprocess,
      z
        .object({
          __originalKeys: z.string().array().optional(),
          read: PermissionRule.optional(),
          edit: PermissionRule.optional(),
          search: PermissionRule.optional(),
          search_remote: PermissionRule.optional(),
          bash: PermissionRule.optional(),
          task: PermissionRule.optional(),
          external_directory: PermissionRule.optional(),
          todowrite: PermissionAction.optional(),
          todoread: PermissionAction.optional(),
          question: PermissionAction.optional(),
          lsp: PermissionRule.optional(),
          doom_loop: PermissionAction.optional(),
          skill: PermissionRule.optional(),
        })
        .catchall(PermissionRule)
        .or(PermissionAction),
    )
    .superRefine((value, ctx) => {
      if (typeof value === "string") return
      for (const key of Object.keys(value)) {
        if (key === "__originalKeys") continue
        const message = legacyPermissionIssue(key)
        if (!message) continue
        ctx.addIssue({
          code: "custom",
          path: [key],
          message,
        })
      }
    })
    .transform(permissionTransform)
    .meta({
      ref: "PermissionConfig",
    })
  export type Permission = z.infer<typeof Permission>

  export const Command = z.object({
    template: z.string(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: ModelId.optional(),
    subtask: z.boolean().optional(),
  })
  export type Command = z.infer<typeof Command>

  export const Skills = z.object({
    paths: z.array(z.string()).optional().describe("Additional paths to skill folders"),
    urls: z
      .array(z.string())
      .optional()
      .describe("URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)"),
  })
  export type Skills = z.infer<typeof Skills>

  export const Agent = z
    .object({
      name: z.string().optional().describe("Display name for this agent"),
      model: ModelId.optional(),
      variant: z
        .string()
        .optional()
        .describe("Default model variant for this agent (applies only when using the agent's configured model)."),
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      prompt: z.string().optional(),
      disable: z.boolean().optional(),
      description: z.string().optional().describe("Description of when to use the agent"),
      hidden: z.boolean().optional().describe("Hide this agent from the @ autocomplete menu (default: false)"),
      options: z.record(z.string(), z.unknown()).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color format")
        .optional()
        .describe("Hex color code"),
      steps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of agentic iterations before forcing text-only response"),
      tools_allowed: z.array(z.string()).min(1).optional().describe("[Deprecated: use actions] Allowlist of tool IDs"),
      thinking_effort: z
        .string()
        .optional()
        .describe("Model-native reasoning effort value to pass as providerOptions.reasoningEffort"),
      knowledge_base: z.array(z.string()).optional().describe("Agent-specific knowledge snippets"),
      mode: z.enum(["primary", "all"]).optional().describe("Agent mode"),
      permission: z.record(z.string(), z.unknown()).optional().describe("Per-agent permission overrides"),
      tools: z.record(z.string(), z.boolean()).optional().describe("Legacy tools config (use permission instead)"),
      actions: z
        .record(
          z.string(),
          z.record(z.string(), z.enum(["allow", "deny", "ask"])),
        )
        .optional()
        .describe("Per-provider tool action policies using SDK tool names (e.g. claude-code: { Bash: allow, Edit: ask })"),
      maxSteps: z.number().int().positive().optional().describe("Alias for steps"),
    })
    .passthrough()
    .meta({
      ref: "AgentConfig",
    })
  export type Agent = z.infer<typeof Agent> & Record<string, unknown>

  export const Keybinds = z
    .object({
      leader: z.string().optional().default("ctrl+x").describe("Leader key for keybind combinations"),
      app_exit: z.string().optional().default("ctrl+c,ctrl+d,<leader>q").describe("Exit the application"),
      editor_open: z.string().optional().default("<leader>e").describe("Open external editor"),
      sidebar_toggle: z.string().optional().default("<leader>b").describe("Toggle sidebar"),
      scrollbar_toggle: z.string().optional().default("none").describe("Toggle session scrollbar"),
      username_toggle: z.string().optional().default("none").describe("Toggle username visibility"),
      status_view: z.string().optional().default("<leader>s").describe("View status"),
      session_export: z.string().optional().default("<leader>x").describe("Export session to editor"),
      session_new: z.string().optional().default("<leader>n").describe("Create a new session"),
      session_list: z.string().optional().default("<leader>l").describe("List all sessions"),
      session_timeline: z.string().optional().default("<leader>g").describe("Show session timeline"),
      session_fork: z.string().optional().default("none").describe("Fork session from message"),
      session_rename: z.string().optional().default("ctrl+r").describe("Rename session"),
      session_delete: z.string().optional().default("ctrl+d").describe("Delete session"),
      stash_delete: z.string().optional().default("ctrl+d").describe("Delete stash entry"),
      model_provider_list: z.string().optional().default("ctrl+a").describe("Open provider list from model dialog"),
      model_favorite_toggle: z.string().optional().default("ctrl+f").describe("Toggle model favorite status"),
      session_share: z.string().optional().default("none").describe("Share current session"),
      session_unshare: z.string().optional().default("none").describe("Unshare current session"),
      session_interrupt: z.string().optional().default("escape").describe("Interrupt current session"),
      session_compact: z.string().optional().default("<leader>c").describe("Compact the session"),
      session_caffeinate: z.string().optional().default("none").describe("Toggle caffeinate (prevent system sleep)"),
      messages_page_up: z.string().optional().default("pageup,ctrl+alt+b").describe("Scroll messages up by one page"),
      messages_page_down: z
        .string()
        .optional()
        .default("pagedown,ctrl+alt+f")
        .describe("Scroll messages down by one page"),
      messages_line_up: z.string().optional().default("ctrl+alt+y").describe("Scroll messages up by one line"),
      messages_line_down: z.string().optional().default("ctrl+alt+e").describe("Scroll messages down by one line"),
      messages_half_page_up: z.string().optional().default("ctrl+alt+u").describe("Scroll messages up by half page"),
      messages_half_page_down: z
        .string()
        .optional()
        .default("ctrl+alt+d")
        .describe("Scroll messages down by half page"),
      messages_first: z.string().optional().default("ctrl+g,home").describe("Navigate to first message"),
      messages_last: z.string().optional().default("ctrl+alt+g,end").describe("Navigate to last message"),
      messages_next: z.string().optional().default("none").describe("Navigate to next message"),
      messages_previous: z.string().optional().default("none").describe("Navigate to previous message"),
      messages_last_user: z.string().optional().default("none").describe("Navigate to last user message"),
      messages_copy: z.string().optional().default("<leader>y").describe("Copy message"),
      messages_undo: z.string().optional().default("<leader>u").describe("Undo message"),
      messages_redo: z.string().optional().default("<leader>r").describe("Redo message"),
      messages_toggle_conceal: z
        .string()
        .optional()
        .default("<leader>h")
        .describe("Toggle code block concealment in messages"),
      tool_details: z.string().optional().default("none").describe("Toggle tool details visibility"),
      model_list: z.string().optional().default("<leader>m").describe("List available models"),
      model_cycle_recent: z.string().optional().default("f2").describe("Next recently used model"),
      model_cycle_recent_reverse: z.string().optional().default("shift+f2").describe("Previous recently used model"),
      model_cycle_favorite: z.string().optional().default("none").describe("Next favorite model"),
      model_cycle_favorite_reverse: z.string().optional().default("none").describe("Previous favorite model"),
      command_list: z.string().optional().default("ctrl+p").describe("List available commands"),
      agent_list: z.string().optional().default("<leader>a").describe("List agents"),
      agent_cycle: z.string().optional().default("tab").describe("Next agent"),
      agent_cycle_reverse: z.string().optional().default("shift+tab").describe("Previous agent"),
      variant_cycle: z.string().optional().default("ctrl+t").describe("Cycle model variants"),
      input_clear: z.string().optional().default("ctrl+c").describe("Clear input field"),
      input_paste: z.string().optional().default("ctrl+v").describe("Paste from clipboard"),
      input_submit: z.string().optional().default("return").describe("Submit input"),
      input_newline: z
        .string()
        .optional()
        .default("shift+return,ctrl+return,alt+return,ctrl+j")
        .describe("Insert newline in input"),
      input_move_left: z.string().optional().default("left,ctrl+b").describe("Move cursor left in input"),
      input_move_right: z.string().optional().default("right,ctrl+f").describe("Move cursor right in input"),
      input_move_up: z.string().optional().default("up").describe("Move cursor up in input"),
      input_move_down: z.string().optional().default("down").describe("Move cursor down in input"),
      input_select_left: z.string().optional().default("shift+left").describe("Select left in input"),
      input_select_right: z.string().optional().default("shift+right").describe("Select right in input"),
      input_select_up: z.string().optional().default("shift+up").describe("Select up in input"),
      input_select_down: z.string().optional().default("shift+down").describe("Select down in input"),
      input_line_home: z.string().optional().default("ctrl+a").describe("Move to start of line in input"),
      input_line_end: z.string().optional().default("ctrl+e").describe("Move to end of line in input"),
      input_select_line_home: z
        .string()
        .optional()
        .default("ctrl+shift+a")
        .describe("Select to start of line in input"),
      input_select_line_end: z.string().optional().default("ctrl+shift+e").describe("Select to end of line in input"),
      input_visual_line_home: z.string().optional().default("alt+a").describe("Move to start of visual line in input"),
      input_visual_line_end: z.string().optional().default("alt+e").describe("Move to end of visual line in input"),
      input_select_visual_line_home: z
        .string()
        .optional()
        .default("alt+shift+a")
        .describe("Select to start of visual line in input"),
      input_select_visual_line_end: z
        .string()
        .optional()
        .default("alt+shift+e")
        .describe("Select to end of visual line in input"),
      input_buffer_home: z.string().optional().default("home").describe("Move to start of buffer in input"),
      input_buffer_end: z.string().optional().default("end").describe("Move to end of buffer in input"),
      input_select_buffer_home: z
        .string()
        .optional()
        .default("shift+home")
        .describe("Select to start of buffer in input"),
      input_select_buffer_end: z.string().optional().default("shift+end").describe("Select to end of buffer in input"),
      input_delete_line: z.string().optional().default("ctrl+shift+d").describe("Delete line in input"),
      input_delete_to_line_end: z.string().optional().default("ctrl+k").describe("Delete to end of line in input"),
      input_delete_to_line_start: z.string().optional().default("ctrl+u").describe("Delete to start of line in input"),
      input_backspace: z.string().optional().default("backspace,shift+backspace").describe("Backspace in input"),
      input_delete: z.string().optional().default("ctrl+d,delete,shift+delete").describe("Delete character in input"),
      input_undo: z.string().optional().default("ctrl+-,super+z").describe("Undo in input"),
      input_redo: z.string().optional().default("ctrl+.,super+shift+z").describe("Redo in input"),
      input_word_forward: z
        .string()
        .optional()
        .default("alt+f,alt+right,ctrl+right")
        .describe("Move word forward in input"),
      input_word_backward: z
        .string()
        .optional()
        .default("alt+b,alt+left,ctrl+left")
        .describe("Move word backward in input"),
      input_select_word_forward: z
        .string()
        .optional()
        .default("alt+shift+f,alt+shift+right")
        .describe("Select word forward in input"),
      input_select_word_backward: z
        .string()
        .optional()
        .default("alt+shift+b,alt+shift+left")
        .describe("Select word backward in input"),
      input_delete_word_forward: z
        .string()
        .optional()
        .default("alt+d,alt+delete,ctrl+delete")
        .describe("Delete word forward in input"),
      input_delete_word_backward: z
        .string()
        .optional()
        .default("ctrl+w,ctrl+backspace,alt+backspace")
        .describe("Delete word backward in input"),
      history_previous: z.string().optional().default("up").describe("Previous history item"),
      history_next: z.string().optional().default("down").describe("Next history item"),
      terminal_suspend: z.string().optional().default("ctrl+z").describe("Suspend terminal"),
      terminal_title_toggle: z.string().optional().default("none").describe("Toggle terminal title"),
      tips_toggle: z.string().optional().default("<leader>h").describe("Toggle tips on home screen"),
      display_thinking: z.string().optional().default("none").describe("Toggle thinking blocks visibility"),
    })
    .strict()
    .meta({
      ref: "KeybindsConfig",
    })

  export const TUI = z.object({
    scroll_speed: z.number().min(0.001).optional().describe("TUI scroll speed"),
    scroll_acceleration: z
      .object({
        enabled: z.boolean().describe("Enable scroll acceleration"),
      })
      .optional()
      .describe("Scroll acceleration settings"),
    terminal_notifications: z
      .boolean()
      .optional()
      .describe("Enable terminal bell notifications for completed turns and required user actions"),
    diff_style: z
      .enum(["auto", "stacked"])
      .optional()
      .describe("Control diff rendering style: 'auto' adapts to terminal width, 'stacked' always shows single column"),
    tint_strength: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Global tint opacity scale for TUI color blending, from 0 to 1 (default: 1.0)"),
  })

  export const Prompt = z
    .object({
      reminder: z
        .object({
          queued_user: z
            .string()
            .optional()
            .describe("Override queued-user reminder. Use {{message}} placeholder for the user text."),
          max_steps: z.string().optional().describe("Override max-steps reminder when step limit is reached"),
        })
        .optional(),
    })
    .strict()
    .meta({
      ref: "PromptConfig",
    })

  export const Server = z
    .object({
      port: z.number().int().positive().optional().describe("Port to listen on"),
      hostname: z.string().optional().describe("Hostname to listen on"),
      mdns: z.boolean().optional().describe("Enable mDNS service discovery"),
      mdnsDomain: z.string().optional().describe("Custom domain name for mDNS service (default: zeroxzero.local)"),
      cors: z.array(z.string()).optional().describe("Additional domains to allow for CORS"),
      password: z.string().optional().describe("Password for server authentication"),
      username: z.string().optional().describe("Username for server authentication"),
    })
    .strict()
    .meta({
      ref: "ServerConfig",
    })

  export const Layout = z.enum(["auto", "stretch"]).meta({
    ref: "LayoutConfig",
  })
  export type Layout = z.infer<typeof Layout>

  export const Provider = z
    .object({
      name: z.string().optional(),
      models: z
        .record(
          z.string(),
          z
            .object({
              id: z.string().optional(),
              name: z.string().optional(),
              variants: z
                .record(
                  z.string(),
                  z
                    .object({
                      disabled: z.boolean().optional().describe("Disable this variant for the model"),
                    })
                    .catchall(z.unknown()),
                )
                .optional()
                .describe("Variant-specific configuration"),
            })
            .passthrough(),
        )
        .optional(),
      options: z
        .object({
          apiKey: z.string().optional(),
        })
        .passthrough()
        .optional(),
    })
    .strict()
    .meta({
      ref: "ProviderConfig",
    })
  export type Provider = z.infer<typeof Provider>

  export const Info = z
    .object({
      $schema: z.string().optional().describe("JSON schema reference for configuration validation"),
      keybinds: Keybinds.optional().describe("Custom keybind configurations"),
      logLevel: Log.Level.optional().describe("Log level"),
      tui: TUI.optional().describe("TUI specific settings"),
      system_prompt: z.string().optional().describe("Override the global base system prompt"),
      prompt: Prompt.optional().describe("Override built-in reminders"),
      server: Server.optional().describe("Server configuration for zeroxzero serve and web commands"),
      command: z
        .record(z.string(), Command)
        .optional()
        .describe("Command configuration, see https://zeroxzero.ai/docs/commands"),
      skills: Skills.optional().describe("Additional skill folder paths"),
      watcher: z
        .object({
          ignore: z.array(z.string()).optional(),
        })
        .optional(),
      snapshot: z.boolean().optional(),
      share: z
        .enum(["manual", "auto", "disabled"])
        .optional()
        .describe(
          "Control sharing behavior:'manual' allows manual sharing via commands, 'auto' enables automatic sharing, 'disabled' disables all sharing",
        ),
      autoshare: z
        .boolean()
        .optional()
        .describe("@deprecated Use 'share' field instead. Share newly created sessions automatically"),
      autoupdate: z
        .union([z.boolean(), z.literal("notify")])
        .optional()
        .describe(
          "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
        ),
      model: ModelId.describe("Model to use in the format of provider/model, eg anthropic/claude-2").optional(),
      small_model: ModelId.describe(
        "Small model to use for tasks like title generation in the format of provider/model",
      ).optional(),
      default_agent: z
        .string()
        .optional()
        .describe(
          "Default agent to use when none is specified. Falls back to 'planner' if not set or if the specified agent is invalid.",
        ),
      username: z
        .string()
        .optional()
        .describe("Custom username to display in conversations instead of system username"),
      agent: z
        .record(z.string(), Agent)
        .optional()
        .describe("Agent configuration, see https://zeroxzero.ai/docs/agents"),
      provider: z
        .record(z.string(), Provider)
        .optional()
        .describe("Custom provider configurations and model overrides"),
      mcp: z
        .record(
          z.string(),
          z.union([
            Mcp,
            z
              .object({
                enabled: z.boolean(),
              })
              .strict(),
          ]),
        )
        .optional()
        .describe("MCP (Model Context Protocol) server configurations"),
      formatter: z
        .union([
          z.literal(false),
          z.record(
            z.string(),
            z.object({
              disabled: z.boolean().optional(),
              command: z.array(z.string()).optional(),
              environment: z.record(z.string(), z.string()).optional(),
              extensions: z.array(z.string()).optional(),
            }),
          ),
        ])
        .optional(),
      lsp: z
        .union([
          z.literal(false),
          z.record(
            z.string(),
            z.union([
              z.object({
                disabled: z.literal(true),
              }),
              z.object({
                command: z.array(z.string()),
                extensions: z.array(z.string()).optional(),
                disabled: z.boolean().optional(),
                env: z.record(z.string(), z.string()).optional(),
                initialization: z.record(z.string(), z.any()).optional(),
              }),
            ]),
          ),
        ])
        .optional()
        .refine(
          (data) => {
            if (!data) return true
            if (typeof data === "boolean") return true
            const serverIds = new Set(Object.values(LSPServer).map((s) => s.id))

            return Object.entries(data).every(([id, config]) => {
              if (config.disabled) return true
              if (serverIds.has(id)) return true
              return Boolean(config.extensions)
            })
          },
          {
            error: "For custom LSP servers, 'extensions' array is required.",
          },
        ),
      disable_lsp_download: z.boolean().optional().describe("Disable automatic LSP server downloads"),
      disable_filetime_check: z.boolean().optional().describe("Disable file modification time checks"),
      git_bash_path: z.string().optional().describe("Path to git bash executable"),
      instructions: z.array(z.string()).optional().describe("Additional instruction files or patterns to include"),
      knowledge_base: z
        .array(z.string())
        .optional()
        .describe("Project-specific knowledge snippets injected into all agents"),
      layout: Layout.optional().describe("@deprecated Always uses stretch layout."),
      permission: Permission.optional(),
      enterprise: z
        .object({
          url: z.string().optional().describe("Enterprise URL"),
        })
        .optional(),
      compaction: z
        .object({
          max_words_before_compact: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Automatically compact when history word count exceeds this value"),
          provider: z.string().optional().describe("Provider used for compaction model"),
          model: z.string().optional().describe("Model used for compaction"),
          prompt: z.string().optional().describe("Prompt used for session compaction"),
        })
        .refine(
          (value) => {
            const hasProvider = value.provider !== undefined
            const hasModel = value.model !== undefined
            return hasProvider === hasModel
          },
          {
            error: "compaction.provider and compaction.model must be set together",
          },
        )
        .optional(),
      experimental: z
        .object({
          disable_paste_summary: z.boolean().optional(),
          batch_tool: z.boolean().optional().describe("Enable the batch tool"),
          openTelemetry: z
            .boolean()
            .optional()
            .describe("Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)"),
          primary_tools: z
            .array(z.string())
            .optional()
            .describe("Tools that should only be available to primary agents."),
          continue_loop_on_deny: z.boolean().optional().describe("Continue the agent loop when a tool call is denied"),
          mcp_timeout: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Timeout in milliseconds for model context protocol (MCP) requests"),
          disable_filewatcher: z.boolean().optional().describe("Disable the file watcher"),
          icon_discovery: z.boolean().optional().describe("Enable icon discovery for projects"),
          exa: z.boolean().optional().describe("Enable Exa search integration"),
          bash_default_timeout_ms: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Default timeout in milliseconds for bash tool commands"),
          output_token_max: z.number().int().positive().optional().describe("Maximum output tokens for LLM responses"),
          oxfmt: z.boolean().optional().describe("Enable oxfmt formatter"),
          lsp_ty: z.boolean().optional().describe("Enable ty LSP server"),
          lsp_tool: z.boolean().optional().describe("Enable LSP diagnostics tool"),
          markdown: z.boolean().optional().describe("Enable experimental markdown rendering"),
          enable_experimental_models: z.boolean().optional().describe("Enable experimental model variants"),
        })
        .optional(),
    })
    .strict()
    .meta({
      ref: "Config",
    })

  export type Info = z.output<typeof Info>

  export const global = lazy(async () => {
    await ensureDefaultGlobalConfigFile()

    let result: Info = defaultConfig()
    const files = await discoverGlobalConfigFiles()
    if (files.length > 1) {
      throw new ConflictError({
        scope: "global",
        files,
      })
    }
    if (files[0]) {
      result = mergeDeep(result, await loadFile(files[0]))
    }

    return result
  })

  async function loadFile(filepath: string): Promise<Info> {
    log.info("loading", { path: filepath })
    let text = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (err.code === "ENOENT") return
        throw new JsonError({ path: filepath }, { cause: err })
      })
    if (!text) return {}
    return load(text, filepath)
  }

  async function load(text: string, configFilepath: string) {
    if (!isYamlPath(configFilepath)) {
      throw new InvalidError({
        path: configFilepath,
        message: "Only YAML config is supported. Use config.yaml.",
      })
    }
    const original = text
    text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || ""
    })

    const fileMatches = text.match(/\{file:[^}]+\}/g)
    if (fileMatches) {
      const configDir = path.dirname(configFilepath)
      const lines = text.split("\n")

      for (const match of fileMatches) {
        const lineIndex = lines.findIndex((line) => line.includes(match))
        if (lineIndex !== -1 && ((lines[lineIndex] ?? "").trim().startsWith("//") || (lines[lineIndex] ?? "").trim().startsWith("#"))) {
          continue // Skip if line is commented
        }
        let filePath = match.replace(/^\{file:/, "").replace(/\}$/, "")
        if (filePath.startsWith("~/")) {
          filePath = path.join(os.homedir(), filePath.slice(2))
        }
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
        const fileContent = (
          await Bun.file(resolvedPath)
            .text()
            .catch((error) => {
              const errMsg = `bad file reference: "${match}"`
              if (error.code === "ENOENT") {
                throw new InvalidError(
                  {
                    path: configFilepath,
                    message: errMsg + ` ${resolvedPath} does not exist`,
                  },
                  { cause: error },
                )
              }
              throw new InvalidError({ path: configFilepath, message: errMsg }, { cause: error })
            })
        ).trim()
        // escape newlines/quotes, strip outer quotes
        text = text.replace(match, () => JSON.stringify(fileContent).slice(1, -1))
      }
    }

    const data = (() => {
      try {
        return YAML.parse(text) ?? {}
      } catch (error) {
        throw new JsonError({
          path: configFilepath,
          message: `YAML parse error: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    })()

    const parsed = Info.safeParse(data)
    if (parsed.success) {
      if (!parsed.data.$schema) {
        parsed.data.$schema = configSchemaURL
        const updated = addYamlSchemaMetadata(original)
        await Bun.write(configFilepath, updated).catch((e) => log.warn("failed to write schema metadata to config", { error: e }))
      }
      return parsed.data
    }

    throw new InvalidError({
      path: configFilepath,
      issues: parsed.error.issues,
    })
  }
  export const JsonError = NamedError.create(
    "ConfigJsonError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
    }),
  )

  export const ConfigDirectoryTypoError = NamedError.create(
    "ConfigDirectoryTypoError",
    z.object({
      path: z.string(),
      dir: z.string(),
      suggestion: z.string(),
    }),
  )

  export const ConflictError = NamedError.create(
    "ConfigConflictError",
    z.object({
      scope: z.enum(["global", "project"]),
      files: z.array(z.string()).min(2),
    }),
  )

  export const InvalidError = NamedError.create(
    "ConfigInvalidError",
    z.object({
      path: z.string(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
      message: z.string().optional(),
    }),
  )

  export async function get() {
    return state().then((x) => x.config)
  }

  export async function getGlobal() {
    return global()
  }

  export async function update(config: Info) {
    const dir = path.join(Instance.worktree, ".0x0")
    await fs.mkdir(dir, { recursive: true })
    const filepath = path.join(dir, configFiles[0])
    const existing = await loadFile(filepath)
    const merged = mergeDeep(existing, config)
    const current = await Bun.file(filepath)
      .text()
      .catch(() => "")
    const output = formatYamlConfig(merged, current)
    await Bun.write(filepath, output)
    await Instance.dispose()
  }

  export async function updateProject(config: Info) {
    const dir = path.join(Instance.worktree, ".0x0")
    await fs.mkdir(dir, { recursive: true })
    const filepath = path.join(dir, configFiles[0])
    const existing = await loadFile(filepath)
    const merged = mergeDeep(existing, config)
    const current = await Bun.file(filepath)
      .text()
      .catch(() => "")
    await Bun.write(filepath, formatYamlConfig(merged, current))
    await Instance.dispose()
    return merged
  }

  export async function getProject() {
    return loadFile(path.join(Instance.worktree, ".0x0", configFiles[0]))
  }

  function globalConfigFile() {
    const candidates = configFiles.map((file) => path.join(Global.Path.config, file))
    for (const file of candidates) {
      if (existsSync(file)) return file
    }
    return candidates[0] ?? ""
  }

  function parseConfig(text: string, filepath: string): Info {
    let data: unknown
    try {
      data = YAML.parse(text) ?? {}
    } catch (error) {
      throw new JsonError({
        path: filepath,
        message: `YAML parse error: ${error instanceof Error ? error.message : String(error)}`,
      })
    }

    const parsed = Info.safeParse(data)
    if (parsed.success) return parsed.data

    throw new InvalidError({
      path: filepath,
      issues: parsed.error.issues,
    })
  }

  export async function updateGlobal(config: Info) {
    const filepath = globalConfigFile()
    const before = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (err.code === "ENOENT") return ""
        throw new JsonError({ path: filepath }, { cause: err })
      })

    const existing = before.trim().length > 0 ? parseConfig(before, filepath) : ({ $schema: configSchemaURL } as Info)
    const next = mergeDeep(existing, config)
    await Bun.write(filepath, formatYamlConfig(next, before))

    global.reset()

    void Instance.disposeAll()
      .catch(() => undefined)
      .finally(() => {
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: Event.Disposed.type,
            properties: {},
          },
        })
      })

    return next
  }

  export async function directories() {
    return state().then((x) => x.directories)
  }
}
