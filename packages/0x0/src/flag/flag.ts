function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

export namespace Flag {
  export const ZEROXZERO_AUTO_SHARE = truthy("ZEROXZERO_AUTO_SHARE")
  export const ZEROXZERO_GIT_BASH_PATH = process.env["ZEROXZERO_GIT_BASH_PATH"]
  export const ZEROXZERO_CONFIG = process.env["ZEROXZERO_CONFIG"]
  export declare const ZEROXZERO_CONFIG_DIR: string | undefined
  export const ZEROXZERO_CONFIG_CONTENT = process.env["ZEROXZERO_CONFIG_CONTENT"]
  export const ZEROXZERO_DISABLE_AUTOUPDATE = truthy("ZEROXZERO_DISABLE_AUTOUPDATE")
  export const ZEROXZERO_DISABLE_TERMINAL_TITLE = truthy("ZEROXZERO_DISABLE_TERMINAL_TITLE")
  export const ZEROXZERO_PERMISSION = process.env["ZEROXZERO_PERMISSION"]
  export const ZEROXZERO_DISABLE_DEFAULT_PLUGINS = truthy("ZEROXZERO_DISABLE_DEFAULT_PLUGINS")
  export const ZEROXZERO_DISABLE_LSP_DOWNLOAD = truthy("ZEROXZERO_DISABLE_LSP_DOWNLOAD")
  export const ZEROXZERO_ENABLE_EXPERIMENTAL_MODELS = truthy("ZEROXZERO_ENABLE_EXPERIMENTAL_MODELS")
  export const ZEROXZERO_DISABLE_MODELS_FETCH = truthy("ZEROXZERO_DISABLE_MODELS_FETCH")
  export const ZEROXZERO_DISABLE_CLAUDE_CODE = truthy("ZEROXZERO_DISABLE_CLAUDE_CODE")
  export const ZEROXZERO_DISABLE_CLAUDE_CODE_PROMPT =
    ZEROXZERO_DISABLE_CLAUDE_CODE || truthy("ZEROXZERO_DISABLE_CLAUDE_CODE_PROMPT")
  export const ZEROXZERO_DISABLE_CLAUDE_CODE_SKILLS =
    ZEROXZERO_DISABLE_CLAUDE_CODE || truthy("ZEROXZERO_DISABLE_CLAUDE_CODE_SKILLS")
  export const ZEROXZERO_DISABLE_EXTERNAL_SKILLS =
    ZEROXZERO_DISABLE_CLAUDE_CODE_SKILLS || truthy("ZEROXZERO_DISABLE_EXTERNAL_SKILLS")
  export declare const ZEROXZERO_DISABLE_PROJECT_CONFIG: boolean
  export const ZEROXZERO_FAKE_VCS = process.env["ZEROXZERO_FAKE_VCS"]
  export declare const ZEROXZERO_CLIENT: string
  export const ZEROXZERO_SERVER_PASSWORD = process.env["ZEROXZERO_SERVER_PASSWORD"]
  export const ZEROXZERO_SERVER_USERNAME = process.env["ZEROXZERO_SERVER_USERNAME"]

  // Experimental
  export const ZEROXZERO_EXPERIMENTAL = truthy("ZEROXZERO_EXPERIMENTAL")
  export const ZEROXZERO_EXPERIMENTAL_FILEWATCHER = truthy("ZEROXZERO_EXPERIMENTAL_FILEWATCHER")
  export const ZEROXZERO_EXPERIMENTAL_DISABLE_FILEWATCHER = truthy("ZEROXZERO_EXPERIMENTAL_DISABLE_FILEWATCHER")
  export const ZEROXZERO_EXPERIMENTAL_ICON_DISCOVERY =
    ZEROXZERO_EXPERIMENTAL || truthy("ZEROXZERO_EXPERIMENTAL_ICON_DISCOVERY")
  export const ZEROXZERO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT = truthy("ZEROXZERO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const ZEROXZERO_ENABLE_EXA =
    truthy("ZEROXZERO_ENABLE_EXA") || ZEROXZERO_EXPERIMENTAL || truthy("ZEROXZERO_EXPERIMENTAL_EXA")
  export const ZEROXZERO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("ZEROXZERO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const ZEROXZERO_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("ZEROXZERO_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const ZEROXZERO_EXPERIMENTAL_OXFMT = ZEROXZERO_EXPERIMENTAL || truthy("ZEROXZERO_EXPERIMENTAL_OXFMT")
  export const ZEROXZERO_EXPERIMENTAL_LSP_TY = truthy("ZEROXZERO_EXPERIMENTAL_LSP_TY")
  export const ZEROXZERO_EXPERIMENTAL_LSP_TOOL = ZEROXZERO_EXPERIMENTAL || truthy("ZEROXZERO_EXPERIMENTAL_LSP_TOOL")
  export const ZEROXZERO_DISABLE_FILETIME_CHECK = truthy("ZEROXZERO_DISABLE_FILETIME_CHECK")
  export const ZEROXZERO_EXPERIMENTAL_MARKDOWN = truthy("ZEROXZERO_EXPERIMENTAL_MARKDOWN")
  export const ZEROXZERO_MODELS_URL = process.env["ZEROXZERO_MODELS_URL"]
  export const ZEROXZERO_MODELS_PATH = process.env["ZEROXZERO_MODELS_PATH"]

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for ZEROXZERO_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "ZEROXZERO_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("ZEROXZERO_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for ZEROXZERO_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "ZEROXZERO_CONFIG_DIR", {
  get() {
    return process.env["ZEROXZERO_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for ZEROXZERO_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "ZEROXZERO_CLIENT", {
  get() {
    return process.env["ZEROXZERO_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})
