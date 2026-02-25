import { describe, expect, test } from "bun:test"
import { submitPrompt } from "../../../src/cli/cmd/tui/component/prompt/submit-prompt"
import type { PromptInfo } from "../../../src/cli/cmd/tui/component/prompt/history"

type SubmitProps = Parameters<typeof submitPrompt>[0]

function props(input = "hello") {
  const calls = {
    setPrompt: 0,
    setExtmarkToPartIndex: 0,
    restorePromptParts: 0,
    clearExtmarks: 0,
    clearInput: 0,
    setText: 0,
    gotoBufferEnd: 0,
    historyAppend: 0,
    onSubmit: 0,
    onSubmitError: [] as string[],
    navigate: 0,
    setMode: 0,
    exit: 0,
  }

  const prompt: PromptInfo = {
    input,
    parts: [],
  }

  const value: SubmitProps = {
    autocompleteVisible: false,
    prompt,
    mode: "normal",
    extmarkToPartIndex: new Map(),
    sessionID: "ses_test",
    local: {
      model: {
        current: () => ({ providerID: "anthropic", modelID: "claude" }),
        variant: {
          current: () => "default",
        },
      },
      agent: {
        current: () => ({ name: "build" }),
      },
    },
    sdk: {
      client: {
        session: {
          $post: async () => new Response(JSON.stringify({ id: "ses_created" })),
          ":sessionID": {
            shell: { $post: async () => ({}) },
            command: { $post: async () => ({}) },
            prompt_async: { $post: async () => ({}) },
          },
        },
      },
    },
    sync: {
      data: {
        command: [],
      },
    },
    route: {
      navigate: () => {
        calls.navigate++
      },
    },
    history: {
      append: () => {
        calls.historyAppend++
      },
    },
    input: {
      extmarks: {
        getAllForTypeId: () => [],
        clear: () => {
          calls.clearExtmarks++
        },
      },
      clear: () => {
        calls.clearInput++
      },
      setText: () => {
        calls.setText++
      },
      gotoBufferEnd: () => {
        calls.gotoBufferEnd++
      },
    },
    promptPartTypeId: 1,
    setMode: () => {
      calls.setMode++
    },
    setPrompt: () => {
      calls.setPrompt++
    },
    setExtmarkToPartIndex: () => {
      calls.setExtmarkToPartIndex++
    },
    restorePromptParts: () => {
      calls.restorePromptParts++
    },
    onPromptModelWarning: () => {},
    onSubmit: () => {
      calls.onSubmit++
    },
    onSubmitError: (message) => {
      calls.onSubmitError.push(message)
    },
    exit: () => {
      calls.exit++
    },
  }

  return { value, calls }
}

describe("submitPrompt", () => {
  test("rolls back on prompt failure with error toast", async () => {
    const setup = props("hello")
    setup.value.sdk.client.session[":sessionID"].prompt_async.$post = async () => {
      throw new Error("network down")
    }

    await submitPrompt(setup.value)

    expect(setup.calls.onSubmitError.length).toBe(1)
    expect(setup.calls.onSubmitError[0]).toBe("network down")
    expect(setup.calls.setText).toBe(1)
    expect(setup.calls.restorePromptParts).toBe(1)
    expect(setup.calls.gotoBufferEnd).toBe(1)
  })

  test("rolls back on command failure with error toast", async () => {
    const setup = props("/hello world")
    setup.value.sync.data.command = [{ name: "hello" }]
    setup.value.sdk.client.session[":sessionID"].command.$post = async () => {
      throw new Error("command failed")
    }

    await submitPrompt(setup.value)

    expect(setup.calls.onSubmitError.length).toBe(1)
    expect(setup.calls.onSubmitError[0]).toBe("command failed")
    expect(setup.calls.setText).toBe(1)
    expect(setup.calls.restorePromptParts).toBe(1)
    expect(setup.calls.gotoBufferEnd).toBe(1)
  })

  test("rolls back on shell failure with error toast", async () => {
    const setup = props("ls -la")
    setup.value.mode = "shell"
    setup.value.sdk.client.session[":sessionID"].shell.$post = async () => {
      throw new Error("shell failed")
    }

    await submitPrompt(setup.value)

    expect(setup.calls.onSubmitError.length).toBe(1)
    expect(setup.calls.onSubmitError[0]).toBe("shell failed")
    expect(setup.calls.setText).toBe(1)
    expect(setup.calls.restorePromptParts).toBe(1)
    expect(setup.calls.gotoBufferEnd).toBe(1)
  })

  test("clears input on success", async () => {
    const setup = props("hello")

    await submitPrompt(setup.value)

    expect(setup.calls.onSubmitError.length).toBe(0)
    expect(setup.calls.historyAppend).toBe(1)
    expect(setup.calls.setPrompt).toBe(1)
    expect(setup.calls.setExtmarkToPartIndex).toBe(1)
    expect(setup.calls.clearExtmarks).toBe(1)
    expect(setup.calls.clearInput).toBe(1)
    expect(setup.calls.onSubmit).toBe(1)
  })

  test("preserves input when session create fails", async () => {
    const setup = props("hello")
    setup.value.sessionID = undefined
    setup.value.sdk.client.session.$post = async () => new Response(JSON.stringify(null), { status: 500 })

    await submitPrompt(setup.value)

    expect(setup.calls.onSubmitError.length).toBe(1)
    expect(setup.calls.navigate).toBe(0)
    expect(setup.calls.setPrompt).toBe(2)
    expect(setup.calls.clearExtmarks).toBe(1)
    expect(setup.calls.clearInput).toBe(1)
    expect(setup.calls.historyAppend).toBe(0)
    expect(setup.calls.setText).toBe(1)
    expect(setup.calls.restorePromptParts).toBe(1)
    expect(setup.calls.gotoBufferEnd).toBe(1)
  })
})
