/**
 * Binds the settings-document section this card edits.
 *
 * Two dependencies this deliberately does without.
 *
 * The card components `ui-settings-plugins` uses for its own three cards —
 * `PluginCard`, `ValueField`, `CardForm` — are internal to that package, so a
 * third-party card starts from the platform primitives and its own controller.
 *
 * And `@deepseek-ai/dsh-client-runtime` cannot be installed from npm today: its
 * published manifest depends on `@deepseek-ai/dsh-compact`, which is not in the
 * registry — the package appears to have been renamed to `dsh-compaction`. So
 * its `createSnapshotStore` is not imported and the few types it would have
 * supplied are declared here. For one boolean the store is twenty lines, and
 * not depending on an uninstallable package is worth more than sharing one.
 */

/** The settings section this card owns; matches the host half's namespace. */
export const NS = 'dsh-substrate'

/**
 * The part of the harness `SettingsScope` this card uses.
 *
 * Declared locally for the reason above, and a subset by design: a method added
 * upstream is invisible here, and one removed upstream becomes a runtime
 * failure this cannot catch.
 */
export interface BoundSettingsScope {
  /** Current section value plus whether the document accepts writes. */
  getSnapshot(): { value?: { applyLoaderPatch?: boolean }, writable?: boolean }
  /** Observe snapshot replacements; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /** Queue one field write. */
  set(field: string, value: unknown): Promise<void>
}

/** What the card renders. */
export interface SubstrateCardState {
  /** Whether the loader patch is staged into this profile. */
  applyLoaderPatch: boolean
  /** False while the settings document rejects writes, which disables the control. */
  writable: boolean
  /** Set while a write is in flight, so the control cannot be double-fired. */
  saving: boolean
  /** Last write failure, shown inline rather than swallowed. */
  error?: string
}

/** A snapshot source `useSyncExternalStore` accepts. */
export interface CardStore {
  /** Current state; the same reference until something changes. */
  getSnapshot(): SubstrateCardState
  /** Observe state replacements; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

/** The face the slot entry injects into the component. */
export interface SubstrateCardFace {
  /** Observable card state. */
  store: CardStore
  /** Flip the switch and persist it. */
  toggle: () => void
}

/**
 * A minimal snapshot store.
 *
 * `getSnapshot` returns an identical reference until something actually
 * changes: `useSyncExternalStore` compares by identity and loops forever if
 * handed a fresh object on every call.
 */
function createStore(initial: SubstrateCardState) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: (): SubstrateCardState => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    patch: (next: Partial<SubstrateCardState>): void => {
      const merged: SubstrateCardState = { ...state, ...next }
      const keys = Object.keys(merged) as (keyof SubstrateCardState)[]
      if (!keys.some(key => merged[key] !== state[key])) return
      state = merged
      for (const listener of listeners) listener()
    },
  }
}

/** Read the section's boolean, defaulting to off. */
function readValue(scope: BoundSettingsScope): boolean {
  return scope.getSnapshot().value?.applyLoaderPatch === true
}

/**
 * Build the card's controller over a bound settings scope.
 *
 * @param scope - the scope bound to this plugin's namespace.
 * @returns the injected face plus its unsubscribe.
 */
export function createSubstrateCard(scope: BoundSettingsScope): SubstrateCardFace & { dispose: () => void } {
  const store = createStore({
    applyLoaderPatch: readValue(scope),
    writable: scope.getSnapshot().writable !== false,
    saving: false,
  })

  // The Host may change the section underneath — another window, an edit to the
  // settings file — so the card follows the document rather than its own last
  // write.
  const dispose = scope.subscribe(() => {
    store.patch({ applyLoaderPatch: readValue(scope), writable: scope.getSnapshot().writable !== false })
  })

  const toggle = (): void => {
    const current = store.getSnapshot()
    if (current.saving || !current.writable) return
    store.patch({ saving: true, error: undefined })
    void scope.set('applyLoaderPatch', !current.applyLoaderPatch)
      .catch((error: unknown) => {
        // Surfaced in the card. A failed write that only reached the console
        // would leave the switch looking like it had worked.
        store.patch({ error: String((error as Error)?.message ?? error) })
      })
      .finally(() => { store.patch({ saving: false }) })
  }

  return { store, toggle, dispose }
}
