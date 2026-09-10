import type { Rpc } from './patch-controller.js'

const CHANNEL = '/api'
const ENDPOINT = 'dsh-substrate/conflicts'

export interface ConflictMode {
  id: 'default-prefix' | 'search-only' | 'collapsed-search'
  available: boolean
  label: string
  reason: string
}

export interface ToolConflict {
  id: string
  owner: string
  originalName: string
  exposedName: string
  mode: 'default-prefix'
}

export interface ConflictReport {
  mode: ConflictMode['id']
  modes: ConflictMode[]
  items: ToolConflict[]
}

export interface ConflictState {
  loaded: boolean
  report: ConflictReport | undefined
  error: string | undefined
}

export interface ConflictFace {
  hooks: { substrateConflicts: { getSnapshot(): ConflictState, subscribe(listener: () => void): () => void } }
}

type Reply = { ok: true, value: unknown } | { ok: false, error?: { message?: string } }

export class ConflictController {
  private listeners = new Set<() => void>()
  private snapshot: ConflictState = { loaded: false, report: undefined, error: undefined }
  private disposed = false

  constructor(private readonly rpc: Rpc) { void this.refresh() }

  inject(): ConflictFace {
    return { hooks: { substrateConflicts: {
      getSnapshot: () => this.snapshot,
      subscribe: (listener: () => void) => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
    } } }
  }

  dispose(): void { this.disposed = true }

  private async refresh(): Promise<void> {
    try {
      const reply = await this.rpc.call(CHANNEL, ENDPOINT, {}) as Reply
      if (!reply.ok) throw new Error(reply.error?.message ?? 'unknown error')
      this.publish({ loaded: true, report: reply.value as ConflictReport, error: undefined })
    } catch (error) {
      this.publish({ loaded: true, report: undefined, error: String(error instanceof Error ? error.message : error).slice(0, 300) })
    }
  }

  private publish(next: ConflictState): void {
    if (this.disposed) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
