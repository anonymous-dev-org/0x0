export interface CompletionInput {
  prefix: string
  suffix: string
  language: string
  filepath: string
  maxTokens?: number
  temperature?: number
  stop?: string[]
  model?: string
  abort?: AbortSignal
}

export interface CompletionProvider {
  readonly id: string
  readonly name: string
  complete(input: CompletionInput): AsyncGenerator<string>
  isAvailable(): Promise<boolean>
}
