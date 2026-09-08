/**
 * Form state for the card's one field.
 *
 * The card exists mainly to say where the loader patch has to be declared, but
 * saying it is not a settings namespace. The namespace is what makes the card
 * render at all: `ConfigurablePluginsTabController` publishes the intersection
 * of the namespaces the Host serves and the cards registered into
 * `settings.plugin.item`, so a card whose key no Host namespace matches is
 * dropped silently. `settleMs` is that namespace's real content — the quiet
 * window the boot report waits for, which tracks machine speed and profile
 * size and therefore belongs to the deployment rather than to a constant.
 */

/** Reactive owner handle over one namespace, as `settingsScope.bind` returns it. */
export interface Scope {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: { settleMs?: number } | undefined
    base: unknown
    user: unknown
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** One editable field as the card renders it. */
export interface FieldState {
  /** Staged text, or the stored value formatted, when nothing is staged. */
  text: string
  /** Whether a user layer exists for this field — presence, not value equality. */
  overridden: boolean
  /** Whether the staged text does not parse to a value the schema accepts. */
  invalid: boolean
}

/** What the card renders. */
export interface SubstrateCardState {
  /** False while the Host has not served this namespace; the card renders nothing. */
  available: boolean
  /** Whether the settings document accepts writes at all. */
  writable: boolean
  /** Whether a staged edit differs from what is stored. */
  dirty: boolean
  /** Whether the staged edit could not be saved as typed. */
  invalid: boolean
  /** Whether a save is in flight. */
  saving: boolean
  /** Whether the last save did not land. */
  failed: boolean
  /** The settle-window field. */
  settleMs: FieldState
}

/** The snapshot source the slot registration injects, plus its actions. */
export interface SubstrateCardFace {
  hooks: { substrateCard: { getSnapshot(): SubstrateCardState, subscribe(listener: () => void): () => void } }
  /** Stage text for the settle-window field. */
  edit: (text: string) => void
  /** Stage a clear, so the field re-inherits the composition layer. */
  reset: () => void
  /** Write the staged edit. */
  save: () => void
  /** Drop the staged edit. */
  discard: () => void
}

/** The field's default, matching the Host schema's. */
const DEFAULT_SETTLE_MS = 250

/** Whether the schema would accept this as `settleMs`: a natural number. */
function parse(text: string): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined
  const value = Number(text.trim())
  return Number.isSafeInteger(value) ? value : undefined
}

/** Projects the scope into card state and routes edits back through it. */
export class SubstrateCardController {
  private listeners = new Set<() => void>()
  private snapshot: SubstrateCardState
  private staged: { text: string, clear: boolean } | undefined
  private saving = false
  private failed = false
  private readonly unsubscribe: () => void

  /** @param scope - the bound namespace handle. */
  constructor(private readonly scope: Scope) {
    this.snapshot = this.project()
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  /**
   * Build the face the slot registration injects.
   * @returns the snapshot source and the card's actions.
   */
  inject(): SubstrateCardFace {
    return {
      hooks: {
        substrateCard: {
          getSnapshot: () => this.snapshot,
          subscribe: (listener: () => void) => {
            this.listeners.add(listener)
            return () => { this.listeners.delete(listener) }
          },
        },
      },
      edit: (text: string) => { this.staged = { text, clear: false }; this.failed = false; this.publish() },
      reset: () => {
        this.staged = { text: this.formatted(this.baseValue()), clear: true }
        this.failed = false
        this.publish()
      },
      save: () => { void this.write() },
      discard: () => { this.staged = undefined; this.failed = false; this.publish() },
    }
  }

  /** Stop following the scope. */
  dispose(): void { this.unsubscribe() }

  private async write(): Promise<void> {
    const staged = this.staged
    if (this.saving || staged === undefined) return
    const value = staged.clear ? undefined : parse(staged.text)
    if (!staged.clear && value === undefined) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    try {
      if (staged.clear) {
        await this.scope.unset('settleMs')
        landed = this.userLayer()?.settleMs === undefined
      } else {
        await this.scope.set('settleMs', value)
        landed = this.userLayer()?.settleMs === value
      }
    } catch {
      // Only a rejected or failed write reaches here; the controller reports it
      // through `failed` and keeps the staged text so the edit is not lost.
      landed = false
    }
    if (landed) this.staged = undefined
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private publish(): void {
    this.snapshot = this.project()
    for (const listener of this.listeners) listener()
  }

  private userLayer(): { settleMs?: number } | undefined {
    return this.scope.getSnapshot().user as { settleMs?: number } | undefined
  }

  private baseValue(): number | undefined {
    return (this.scope.getSnapshot().base as { settleMs?: number } | undefined)?.settleMs
  }

  private formatted(value: number | undefined): string {
    return String(value ?? DEFAULT_SETTLE_MS)
  }

  private project(): SubstrateCardState {
    const view = this.scope.getSnapshot()
    const stored = this.formatted(view.value?.settleMs)
    const text = this.staged?.text ?? stored
    const invalid = this.staged !== undefined && !this.staged.clear && parse(text) === undefined
    return {
      available: view.status === 'ready',
      writable: view.writable,
      dirty: this.staged !== undefined && (this.staged.clear || text !== stored),
      invalid,
      saving: this.saving,
      failed: this.failed,
      settleMs: { text, overridden: this.userLayer()?.settleMs !== undefined, invalid },
    }
  }
}
