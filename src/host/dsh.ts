/** Only the rc.5 Host seams used here; no DSH runtime dependency is bundled. */

export interface Agent {
  readonly session: { requestHeader(): { readonly config?: { readonly provider?: string; readonly model?: string } } | undefined }
  readonly options: { readonly provider?: string; readonly model?: string }
}

export interface ToolExecution {
  readonly signal: AbortSignal
  readonly agent?: Agent
}

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: ImageAttachment }

export interface Tool<Args, Value> {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    readonly render: (args: Args, value: Value) => ContentBlock[]
  }
  readonly isConcurrencySafe: () => boolean
  /** Thrown errors become `isError` results whose text is the error message. */
  execute(args: unknown, exec: ToolExecution): Promise<Value>
}

/** An opaque, resolved file in the filesystem provider's execution world. */
export interface FsTarget {
  readonly displayPath: string
}

export interface FileSystem {
  resolve(path: string, options?: { readonly cwd?: string; readonly signal?: AbortSignal }): Promise<FsTarget>
  stat(target: FsTarget, signal?: AbortSignal): Promise<{ readonly type: 'file' | 'directory' | string } | undefined>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  processPath(target: FsTarget): string
}

export interface WorkingDirectory {
  /** The Session's existing current directory. */
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** The durable reference an image content block carries (rc.5 ImageAttachmentRef, JSON form). */
export interface ImageAttachment {
  readonly attachmentId: string
  readonly mediaType: ImageMediaType
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
  readonly originalDimensions?: { readonly width: number; readonly height: number }
}

export interface Attachments {
  readonly imageLimits: { readonly mediaTypes: readonly ImageMediaType[] }
  saveImage(input: { readonly data: Uint8Array; readonly mediaType: ImageMediaType; readonly name: string }): Promise<ImageAttachment>
}

export interface Llm {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ readonly inputModalities?: readonly string[] }>
}

export interface SkillCandidate {
  readonly name: string
  readonly description: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly provider: string
  readonly source: 'bundled'
  readonly rank: number
  readonly resourceBase: { readonly kind: 'directory'; readonly path: string }
  readonly locator: string
  readonly path: string
}

export interface HostContext {
  readonly tools: { register<Args, Value>(tool: Tool<Args, Value>): () => void }
  readonly fs: FileSystem
  readonly workingDirectory: WorkingDirectory
  get(name: 'attachments'): Attachments | undefined
  get(name: 'llm'): Llm | undefined
  readonly skills: {
    registerProvider(factory: () => {
      readonly name: string
      list(options: { readonly signal?: AbortSignal }): Promise<SkillCandidate[]>
      get(candidate: SkillCandidate, options: { readonly signal?: AbortSignal }): Promise<Omit<SkillCandidate, 'rank' | 'locator'> & { content: string }>
    }): () => void
  }
  effect(callback: () => () => void | Promise<void>, label: string): unknown
}
