/**
 * The installation-repair state, driven by the Host's read-only
 * `/dsh-substrate` channel.
 *
 * Every branch the card renders comes from the Host, not from this file: only
 * the Host can follow `$DSH_HOME/profiles/node_modules/<loader>` to the
 * installation that owns it, and only that answer says whether a declaration
 * would be read. Guessing it here would reproduce the bug this whole path
 * exists to avoid — a write that succeeds, warns about nothing, and changes
 * nothing.
 */

/** The loopback RPC face the client half is handed. */
export interface Rpc {
  call(channel: string, endpoint: string, payload: unknown): Promise<unknown>
}

/** The channel the Host mounts. */
const CHANNEL = '/dsh-substrate'

/** What the Host reports about this machine's patch target. */
export interface PatchStatus {
  /**
   * The repair transaction's current phase. Writing the declaration, relinking
   * dependencies, and loading the result in a new process are deliberately
   * separate states.
   */
  state:
    | 'available'
    | 'install-required'
    | 'restart-required'
    | 'verified'
    | 'removal-install-required'
    | 'removal-restart-required'
    | 'version-mismatch'
    | 'source'
    | 'unresolved'
  /** DSH home used to resolve the real installation. */
  home: string
  /** The workspace pnpm reads, when there is one. */
  root?: string
  /** The loader's real directory. */
  packageDir?: string
  /** The fallback link that was missing, under `unresolved`. */
  link?: string
  /** The patched package and version. */
  target: string
  /** Loader version this repair accepts. */
  expectedVersion: string
  /** Loader version found on disk, when readable. */
  actualVersion?: string
  /** The diff's file name. */
  file: string
  /** The command that applies a written declaration. */
  install: string
  /** Copyable commands executed outside the running DSH process. */
  commands: { apply: string, revert: string }
}

/** What the card renders for the patch row. */
export interface PatchState {
  /** False until the first status read answers; the row shows nothing yet. */
  loaded: boolean
  /** The Host's answer, once it has one. */
  status: PatchStatus | undefined
  /** Status read failure; the page never substitutes a stale optimistic state. */
  error: string | undefined
}

/** The read-only snapshot source the slot registration injects. */
export interface PatchFace {
  hooks: { substratePatch: { getSnapshot(): PatchState, subscribe(listener: () => void): () => void } }
}

/** A Host reply, which is an envelope rather than the value itself. */
type Reply = { ok: true, value: unknown } | { ok: false, error?: { message?: string } }

/** Reads the Host's repair status for a read-only browser projection. */
export class PatchController {
  private listeners = new Set<() => void>()
  private snapshot: PatchState = { loaded: false, status: undefined, error: undefined }
  private disposed = false

  /** @param rpc - the client connection's loopback RPC face. */
  constructor(private readonly rpc: Rpc) {
    void this.refresh()
  }

  /**
   * Build the face the slot registration injects.
   * @returns the snapshot source consumed by the repair row.
   */
  inject(): PatchFace {
    return {
      hooks: {
        substratePatch: {
          getSnapshot: () => this.snapshot,
          subscribe: (listener: () => void) => {
            this.listeners.add(listener)
            return () => { this.listeners.delete(listener) }
          },
        },
      },
    }
  }

  /** Stop publishing; in-flight replies are dropped rather than applied. */
  dispose(): void { this.disposed = true }

  private async refresh(): Promise<void> {
    const reply = await this.send('status')
    if (reply === undefined) {
      this.publish({ loaded: true, error: this.lastError })
      return
    }
    this.publish({ loaded: true, status: reply as PatchStatus, error: undefined })
  }

  private lastError = ''

  private async send(endpoint: string): Promise<unknown> {
    try {
      const reply = await this.rpc.call(CHANNEL, endpoint, {}) as Reply
      if (reply.ok) return reply.value
      this.lastError = reply.error?.message ?? 'unknown error'
      return undefined
    } catch (error) {
      // The channel itself failed — the Host half is not mounted, or the
      // connection dropped. The row says so instead of showing a button whose
      // press would do nothing.
      this.lastError = String(error instanceof Error ? error.message : error).slice(0, 300)
      return undefined
    }
  }

  private publish(patch: Partial<PatchState>): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}
