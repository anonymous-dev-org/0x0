import { SyntaxStyle, RGBA, type TerminalColors } from "@opentui/core"
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { sync } from "@tui/state/sync"
import { kv } from "@tui/state/kv"
import { useRenderer } from "@opentui/solid"
import { createStore } from "solid-js/store"
import { getSyntaxRules } from "../context/syntax-rules"

type ThemeColors = {
  primary: RGBA
  secondary: RGBA
  accent: RGBA
  error: RGBA
  warning: RGBA
  success: RGBA
  info: RGBA
  text: RGBA
  textMuted: RGBA
  selectedListItemText: RGBA
  background: RGBA
  backgroundPanel: RGBA
  backgroundElement: RGBA
  backgroundMenu: RGBA
  border: RGBA
  borderActive: RGBA
  borderSubtle: RGBA
  diffAdded: RGBA
  diffRemoved: RGBA
  diffContext: RGBA
  diffHunkHeader: RGBA
  diffHighlightAdded: RGBA
  diffHighlightRemoved: RGBA
  diffAddedBg: RGBA
  diffRemovedBg: RGBA
  diffContextBg: RGBA
  diffLineNumber: RGBA
  diffAddedLineNumberBg: RGBA
  diffRemovedLineNumberBg: RGBA
  markdownText: RGBA
  markdownHeading: RGBA
  markdownLink: RGBA
  markdownLinkText: RGBA
  markdownCode: RGBA
  markdownBlockQuote: RGBA
  markdownEmph: RGBA
  markdownStrong: RGBA
  markdownHorizontalRule: RGBA
  markdownListItem: RGBA
  markdownListEnumeration: RGBA
  markdownImage: RGBA
  markdownImageText: RGBA
  markdownCodeBlock: RGBA
  syntaxComment: RGBA
  syntaxKeyword: RGBA
  syntaxFunction: RGBA
  syntaxVariable: RGBA
  syntaxString: RGBA
  syntaxNumber: RGBA
  syntaxType: RGBA
  syntaxOperator: RGBA
  syntaxPunctuation: RGBA
}

type Theme = ThemeColors & {
  _hasSelectedListItemText: boolean
  thinkingOpacity: number
}

export function selectedForeground(theme: Theme, bg?: RGBA): RGBA {
  // If theme explicitly defines selectedListItemText, use it
  if (theme._hasSelectedListItemText) {
    return theme.selectedListItemText
  }

  // For transparent backgrounds, calculate contrast based on the actual bg (or fallback to primary)
  if (theme.background.a === 0) {
    const targetColor = bg ?? theme.primary
    const { r, g, b } = targetColor
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b
    return luminance > 0.5 ? RGBA.fromInts(0, 0, 0) : RGBA.fromInts(255, 255, 255)
  }

  // Fall back to background color
  return theme.background
}

type HexColor = `#${string}`
type RefName = string
type Variant = {
  dark: HexColor | RefName
  light: HexColor | RefName
}
type ColorValue = HexColor | RefName | Variant | RGBA
type ThemeJson = {
  $schema?: string
  defs?: Record<string, HexColor | RefName>
  theme: Omit<Record<keyof ThemeColors, ColorValue>, "selectedListItemText" | "backgroundMenu"> & {
    selectedListItemText?: ColorValue
    backgroundMenu?: ColorValue
    thinkingOpacity?: number
  }
}

function resolveTheme(theme: ThemeJson, mode: "dark" | "light") {
  const defs = theme.defs ?? {}
  function resolveColor(c: ColorValue): RGBA {
    if (c instanceof RGBA) return c
    if (typeof c === "string") {
      if (c === "transparent" || c === "none") return RGBA.fromInts(0, 0, 0, 0)

      if (c.startsWith("#")) return RGBA.fromHex(c)

      if (defs[c] != null) {
        return resolveColor(defs[c])
      } else if (theme.theme[c as keyof ThemeColors] !== undefined) {
        return resolveColor(theme.theme[c as keyof ThemeColors]!)
      } else {
        throw new Error(`Color reference "${c}" not found in defs or theme`)
      }
    }
    if (typeof c === "number") {
      return ansiToRgba(c)
    }
    return resolveColor(c[mode])
  }

  const resolved = Object.fromEntries(
    Object.entries(theme.theme)
      .filter(([key]) => key !== "selectedListItemText" && key !== "backgroundMenu" && key !== "thinkingOpacity")
      .map(([key, value]) => {
        return [key, resolveColor(value as ColorValue)]
      }),
  ) as Partial<ThemeColors>

  resolved.background = RGBA.fromInts(0, 0, 0, 0)

  // Handle selectedListItemText separately since it's optional
  const hasSelectedListItemText = theme.theme.selectedListItemText !== undefined
  if (hasSelectedListItemText) {
    resolved.selectedListItemText = resolveColor(theme.theme.selectedListItemText!)
  } else {
    // Backward compatibility: if selectedListItemText is not defined, use background color
    // This preserves the current behavior for all existing themes
    resolved.selectedListItemText = resolved.background
  }

  // Handle backgroundMenu - optional with fallback to backgroundElement
  if (theme.theme.backgroundMenu !== undefined) {
    resolved.backgroundMenu = resolveColor(theme.theme.backgroundMenu)
  } else {
    resolved.backgroundMenu = resolved.backgroundElement
  }

  // Handle thinkingOpacity - optional with default of 0.6
  const thinkingOpacity = theme.theme.thinkingOpacity ?? 0.6

  return {
    ...resolved,
    _hasSelectedListItemText: hasSelectedListItemText,
    thinkingOpacity,
  } as Theme
}

function ansiToRgba(code: number): RGBA {
  // Standard ANSI colors (0-15)
  if (code < 16) {
    const ansiColors = [
      "#000000", // Black
      "#800000", // Red
      "#008000", // Green
      "#808000", // Yellow
      "#000080", // Blue
      "#800080", // Magenta
      "#008080", // Cyan
      "#c0c0c0", // White
      "#808080", // Bright Black
      "#ff0000", // Bright Red
      "#00ff00", // Bright Green
      "#ffff00", // Bright Yellow
      "#0000ff", // Bright Blue
      "#ff00ff", // Bright Magenta
      "#00ffff", // Bright Cyan
      "#ffffff", // Bright White
    ]
    return RGBA.fromHex(ansiColors[code] ?? "#000000")
  }

  // 6x6x6 Color Cube (16-231)
  if (code < 232) {
    const index = code - 16
    const b = index % 6
    const g = Math.floor(index / 6) % 6
    const r = Math.floor(index / 36)

    const val = (x: number) => (x === 0 ? 0 : x * 40 + 55)
    return RGBA.fromInts(val(r), val(g), val(b))
  }

  // Grayscale Ramp (232-255)
  if (code < 256) {
    const gray = (code - 232) * 10 + 8
    return RGBA.fromInts(gray, gray, gray)
  }

  // Fallback for invalid codes
  return RGBA.fromInts(0, 0, 0)
}

const DEFAULT_TINT_STRENGTH = 1
const MIN_TINT_STRENGTH = 0
const MAX_TINT_STRENGTH = 1
const [tintStrength, setTintStrength] = createSignal(DEFAULT_TINT_STRENGTH)

function clampTintStrength(value: number) {
  return Math.max(MIN_TINT_STRENGTH, Math.min(MAX_TINT_STRENGTH, value))
}

function parseTintStrength(value: unknown) {
  if (typeof value !== "number") return undefined
  if (!Number.isFinite(value)) return undefined
  return clampTintStrength(value)
}

function defaultTintStrength(config: unknown) {
  const value = parseTintStrength((config as { tint_strength?: number } | undefined)?.tint_strength)
  return value ?? DEFAULT_TINT_STRENGTH
}

const FALLBACK_PALETTE = [
  "#000000",
  "#800000",
  "#008000",
  "#808000",
  "#000080",
  "#800080",
  "#008080",
  "#c0c0c0",
  "#808080",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#0000ff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
]

function fallback(mode: "dark" | "light"): ThemeJson {
  return generateSystem(
    {
      palette: FALLBACK_PALETTE,
      defaultBackground: mode === "dark" ? "#000000" : "#ffffff",
      defaultForeground: mode === "dark" ? "#c0c0c0" : "#000000",
    } as TerminalColors,
    mode,
  )
}

type ThemeState = {
  theme: Theme
  syntax: () => SyntaxStyle
  subtleSyntax: () => SyntaxStyle
  mode: () => "dark" | "light"
  setMode(m: "dark" | "light"): void
  tintStrength(): number
  defaultTintStrength(): number
  setTintStrength(value: number | null): void
  readonly ready: boolean
}

let _state: ThemeState

export function createTheme(props: { mode: "dark" | "light" }) {
  const [store, setStore] = createStore({
    ready: false,
  })
  const [themeJson, setThemeJson] = createSignal<ThemeJson>(fallback(props.mode))

  const mode = () => {
    if (!kv.ready) return props.mode
    const stored = kv.get("theme_mode")
    if (stored === "dark" || stored === "light") return stored
    return props.mode
  }

  createEffect(() => {
    const local = parseTintStrength(kv.get("tint_strength"))
    const fb = defaultTintStrength(sync.data.config.tui)
    setTintStrength(local ?? fb)
  })

  const renderer = useRenderer()

  function init() {
    renderer
      .getPalette({ size: 16 })
      .then((colors) => {
        if (colors.palette[0]) {
          setThemeJson(generateSystem(colors, mode()))
        }
        setStore("ready", true)
      })
      .catch(() => {
        setStore("ready", true)
      })
  }

  onMount(init)

  const refresh = async () => {
    renderer.clearPaletteCache()
    init()
  }
  process.on("SIGUSR2", refresh)
  onCleanup(() => process.off("SIGUSR2", refresh))

  const values = createMemo(() => resolveTheme(themeJson(), mode()))
  const syntax = createMemo(() => generateSyntax(values()))
  const subtleSyntax = createMemo(() => generateSubtleSyntax(values()))

  _state = {
    theme: new Proxy(values(), {
      get(_target, prop) {
        // @ts-expect-error
        return values()[prop]
      },
    }),
    syntax,
    subtleSyntax,
    mode,
    setMode(m: "dark" | "light") {
      kv.set("theme_mode", m)
    },
    tintStrength() {
      return tintStrength()
    },
    defaultTintStrength() {
      return defaultTintStrength(sync.data.config.tui)
    },
    setTintStrength(value: number | null) {
      if (value === null) {
        kv.set("tint_strength", null)
        return
      }
      kv.set("tint_strength", clampTintStrength(value))
    },
    get ready() {
      return store.ready
    },
  }
}

export const themeState: ThemeState = new Proxy({} as ThemeState, {
  get: (_, key) => (_state as any)[key],
})

// Convenience: the theme colors proxy (what most consumers need)
export const theme: Theme = new Proxy({} as Theme, {
  get: (_, key) => (_state as any).theme[key],
})

export function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  const mix = Math.max(0, Math.min(1, alpha)) * tintStrength()
  const r = base.r + (overlay.r - base.r) * mix
  const g = base.g + (overlay.g - base.g) * mix
  const b = base.b + (overlay.b - base.b) * mix
  return RGBA.fromInts(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255))
}

function generateSystem(colors: TerminalColors, mode: "dark" | "light"): ThemeJson {
  const bg = RGBA.fromHex(colors.defaultBackground ?? colors.palette[0]!)
  const fg = RGBA.fromHex(colors.defaultForeground ?? colors.palette[7]!)
  const transparent = RGBA.fromInts(0, 0, 0, 0)
  const isDark = mode == "dark"

  const col = (i: number) => {
    const value = colors.palette[i]
    if (value) return RGBA.fromHex(value)
    return ansiToRgba(i)
  }

  // Generate gray scale based on terminal background
  const grays = generateGrayScale(bg, isDark)
  const textMuted = generateMutedTextColor(bg, isDark)

  // ANSI color references
  const ansiColors = {
    black: col(0),
    red: col(1),
    green: col(2),
    yellow: col(3),
    blue: col(4),
    magenta: col(5),
    cyan: col(6),
    white: col(7),
    redBright: col(9),
    greenBright: col(10),
  }

  // Gray shades for monochrome theme
  const grayBright = grays[11] ?? fg
  const grayLight = grays[10] ?? fg
  const grayMedium = grays[9] ?? fg
  const grayMediumDark = grays[8] ?? fg
  const grayDark = grays[7] ?? fg
  const grayDarker = grays[6] ?? fg

  const diffAlpha = isDark ? 0.22 : 0.14
  const diffAddedBg = tint(bg, grayLight, diffAlpha * 0.7)
  const diffRemovedBg = tint(bg, grayDarker, diffAlpha)
  const diffAddedLineNumberBg = tint(grays[3] ?? bg, grayLight, diffAlpha * 0.7)
  const diffRemovedLineNumberBg = tint(grays[3] ?? bg, grayDarker, diffAlpha)

  return {
    theme: {
      // Primary colors - gray shades
      primary: grayLight,
      secondary: grayMediumDark,
      accent: grayLight,

      // Status colors - gray shades
      error: grayBright,
      warning: grayMedium,
      success: grayMediumDark,
      info: grayLight,

      // Text colors
      text: fg,
      textMuted,
      selectedListItemText: bg,

      // Background colors - use transparent to respect terminal transparency
      background: transparent,
      backgroundPanel: grays[2] ?? bg,
      backgroundElement: grays[3] ?? bg,
      backgroundMenu: grays[3] ?? bg,

      // Border colors
      borderSubtle: grayDarker,
      border: grayDark,
      borderActive: grayMediumDark,

      // Diff colors - brightness-differentiated grays
      diffAdded: grayLight,
      diffRemoved: grayDarker,
      diffContext: grayDark,
      diffHunkHeader: grayDark,
      diffHighlightAdded: grayBright,
      diffHighlightRemoved: grayMedium,
      diffAddedBg,
      diffRemovedBg,
      diffContextBg: grays[1] ?? bg,
      diffLineNumber: grayDarker,
      diffAddedLineNumberBg,
      diffRemovedLineNumberBg,

      // Markdown colors - gray shades with varying brightness
      markdownText: fg,
      markdownHeading: fg,
      markdownLink: grayBright,
      markdownLinkText: grayLight,
      markdownCode: grayLight,
      markdownBlockQuote: grayMedium,
      markdownEmph: grayMedium,
      markdownStrong: fg,
      markdownHorizontalRule: grayDark,
      markdownListItem: grayLight,
      markdownListEnumeration: grayMedium,
      markdownImage: grayLight,
      markdownImageText: grayMedium,
      markdownCodeBlock: fg,

      // Syntax colors - gray shades with varying brightness
      syntaxComment: textMuted,
      syntaxKeyword: grayBright,
      syntaxFunction: grayLight,
      syntaxVariable: fg,
      syntaxString: grayMedium,
      syntaxNumber: grayMediumDark,
      syntaxType: grayLight,
      syntaxOperator: grayMedium,
      syntaxPunctuation: fg,
    },
  }
}

function generateGrayScale(bg: RGBA, isDark: boolean): Record<number, RGBA> {
  const grays: Record<number, RGBA> = {}

  // RGBA stores floats in range 0-1, convert to 0-255
  const bgR = bg.r * 255
  const bgG = bg.g * 255
  const bgB = bg.b * 255

  const luminance = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB

  for (let i = 1; i <= 12; i++) {
    const factor = i / 12.0

    let grayValue: number
    let newR: number
    let newG: number
    let newB: number

    if (isDark) {
      if (luminance < 10) {
        grayValue = Math.floor(factor * 0.4 * 255)
        newR = grayValue
        newG = grayValue
        newB = grayValue
      } else {
        const newLum = luminance + (255 - luminance) * factor * 0.4

        const ratio = newLum / luminance
        newR = Math.min(bgR * ratio, 255)
        newG = Math.min(bgG * ratio, 255)
        newB = Math.min(bgB * ratio, 255)
      }
    } else {
      if (luminance > 245) {
        grayValue = Math.floor(255 - factor * 0.4 * 255)
        newR = grayValue
        newG = grayValue
        newB = grayValue
      } else {
        const newLum = luminance * (1 - factor * 0.4)

        const ratio = newLum / luminance
        newR = Math.max(bgR * ratio, 0)
        newG = Math.max(bgG * ratio, 0)
        newB = Math.max(bgB * ratio, 0)
      }
    }

    grays[i] = RGBA.fromInts(Math.floor(newR), Math.floor(newG), Math.floor(newB))
  }

  return grays
}

function generateMutedTextColor(bg: RGBA, isDark: boolean): RGBA {
  // RGBA stores floats in range 0-1, convert to 0-255
  const bgR = bg.r * 255
  const bgG = bg.g * 255
  const bgB = bg.b * 255

  const bgLum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB

  let grayValue: number

  if (isDark) {
    if (bgLum < 10) {
      // Very dark/black background
      grayValue = 180 // #b4b4b4
    } else {
      // Scale up for lighter dark backgrounds
      grayValue = Math.min(Math.floor(160 + bgLum * 0.3), 200)
    }
  } else {
    if (bgLum > 245) {
      // Very light/white background
      grayValue = 75 // #4b4b4b
    } else {
      // Scale down for darker light backgrounds
      grayValue = Math.max(Math.floor(100 - (255 - bgLum) * 0.2), 60)
    }
  }

  return RGBA.fromInts(grayValue, grayValue, grayValue)
}

function generateSyntax(theme: Theme) {
  return SyntaxStyle.fromTheme(getSyntaxRules(theme))
}

function generateSubtleSyntax(theme: Theme) {
  const rules = getSyntaxRules(theme)
  return SyntaxStyle.fromTheme(
    rules.map((rule) => {
      if (rule.style.foreground) {
        const fg = rule.style.foreground
        return {
          ...rule,
          style: {
            ...rule.style,
            foreground: RGBA.fromInts(
              Math.round(fg.r * 255),
              Math.round(fg.g * 255),
              Math.round(fg.b * 255),
              Math.round(theme.thinkingOpacity * 255),
            ),
          },
        }
      }
      return rule
    }),
  )
}
