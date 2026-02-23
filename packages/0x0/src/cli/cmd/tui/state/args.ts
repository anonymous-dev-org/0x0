export interface Args {
  model?: string
  agent?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
  fork?: boolean
}

let _state: Args = {}

export function setArgs(input: Args) {
  _state = input
}

export const args: Args = new Proxy({} as Args, {
  get: (_, key) => (_state as any)[key],
})
