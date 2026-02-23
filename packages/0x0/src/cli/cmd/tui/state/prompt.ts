import type { PromptRef } from "../component/prompt"

type PromptRefState = {
  readonly current: PromptRef | undefined
  set(ref: PromptRef | undefined): void
}

let _state: PromptRefState

export function createPromptRef() {
  let current: PromptRef | undefined

  _state = {
    get current() {
      return current
    },
    set(ref: PromptRef | undefined) {
      current = ref
    },
  }
}

export const promptRef: PromptRefState = new Proxy({} as PromptRefState, {
  get: (_, key) => (_state as any)[key],
})
