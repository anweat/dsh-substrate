import { createHash } from 'node:crypto'

const PATCH_STATE = Symbol.for('dsh-substrate:tool-prefix-patch')
const STORE = Symbol.for('dsh-substrate:tool-conflict-store')

/** The modes the settings card can describe without pretending DSH exposes a search seam. */
export const TOOL_CONFLICT_MODES = Object.freeze([
  Object.freeze({
    id: 'default-prefix',
    available: true,
    label: 'Default injection',
    reason: 'Duplicates registered after the bootstrap stay model-visible under a deterministic npm/plugin prefix.',
  }),
  Object.freeze({
    id: 'search-only',
    available: false,
    label: 'Search only',
    reason: 'The audited DSH runtime has no tool-search registry or dispatcher to expose hidden tools by reference.',
  }),
  Object.freeze({
    id: 'collapsed-search',
    available: false,
    label: 'Collapsed search',
    reason: 'DSH can collapse all tools behind run_code, but it does not provide a searchable tool-reference transport.',
  }),
])

/** Turn a package or plugin identity into a model-safe tool prefix. */
export function toolPrefix(owner) {
  const text = String(owner ?? '').trim()
  const withoutVersion = text.replace(/@(\d+\.)?\d[0-9A-Za-z.+-]*$/, '')
  return withoutVersion
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'plugin'
}

/** Build a deterministic tool name within the common 64-character provider limit. */
export function prefixedToolName(owner, originalName, ordinal = 1) {
  const prefix = toolPrefix(owner)
  const suffix = ordinal > 1 ? `__${ordinal}` : ''
  const direct = `${prefix}__${originalName}${suffix}`
  if (direct.length <= 64) return direct
  const digest = createHash('sha256').update(`${owner}\0${originalName}\0${ordinal}`).digest('hex').slice(0, 8)
  const shortPrefix = prefix.slice(0, 20)
  const room = Math.max(1, 64 - shortPrefix.length - digest.length - suffix.length - 3)
  return `${shortPrefix}__${String(originalName).slice(0, room)}_${digest}${suffix}`
}

function ownerOf(ctx) {
  const fiber = ctx?.fiber
  return String(fiber?.name ?? fiber?.plugin?.name ?? 'plugin')
}

function duplicateRegistration(error, name) {
  const message = String(error instanceof Error ? error.message : error)
  return message.includes(`tool "${name}" is already registered`)
}

/** Mutable runtime ledger projected through a read-only RPC. */
export class ToolConflictStore {
  constructor() {
    this.records = new Map()
    this.sequence = 0
  }

  add(record) {
    const id = `tool-conflict-${++this.sequence}`
    this.records.set(id, Object.freeze({ id, ...record }))
    let active = true
    return () => {
      if (!active) return
      active = false
      this.records.delete(id)
    }
  }

  snapshot() {
    return {
      mode: 'default-prefix',
      modes: TOOL_CONFLICT_MODES,
      items: [...this.records.values()],
    }
  }
}

/** One ledger shared by the early bootstrap row and the later reporter row. */
export function toolConflictStore(ctx) {
  const root = ctx?.root ?? ctx
  if (root[STORE] === undefined) {
    Object.defineProperty(root, STORE, { configurable: true, value: new ToolConflictStore() })
  }
  return root[STORE]
}

/**
 * Prefix only registrations the runtime itself rejects as duplicates.
 *
 * Calling the original method first preserves explicit agent scopes and every
 * validation error. The fallback runs only for the runtime's exact duplicate
 * diagnostic; reserved run_code and malformed definitions continue to fail.
 */
export function installToolConflictPrefixing(runtime, store) {
  if (!runtime || typeof runtime.register !== 'function') {
    throw new TypeError('dsh-substrate: tools service does not expose register()')
  }
  return installToolConflictPrefixingPrototype(Object.getPrototypeOf(runtime), store)
}

/** Install before ToolRuntime construction when the Loader exposes its plugin fiber first. */
export function installToolConflictPrefixingPrototype(proto, store) {
  if (!proto || typeof proto.register !== 'function') {
    throw new TypeError('dsh-substrate: tool runtime prototype does not expose register()')
  }
  let state = proto[PATCH_STATE]
  if (state === undefined) {
    const original = proto.register
    state = { original, stores: new Set(), refs: 0 }
    Object.defineProperty(proto, PATCH_STATE, { configurable: true, value: state })
    proto.register = function substratePrefixedRegister(definition) {
      try {
        return state.original.call(this, definition)
      } catch (error) {
        const originalName = String(definition?.name ?? '')
        if (!duplicateRegistration(error, originalName) || originalName === 'run_code') throw error

        const owner = ownerOf(this.ctx)
        let ordinal = 1
        for (;;) {
          const exposedName = prefixedToolName(owner, originalName, ordinal)
          const alias = {
            ...definition,
            name: exposedName,
            description: `[Conflict alias for ${owner}; original name: ${originalName}] ${definition.description ?? ''}`.trim(),
          }
          try {
            const disposeTool = state.original.call(this, alias)
            const removers = [...state.stores].map(target => target.add({
              owner,
              originalName,
              exposedName,
              mode: 'default-prefix',
            }))
            let active = true
            const removeRecord = () => {
              if (!active) return
              active = false
              for (const remove of removers) remove()
            }
            const disposeRecord = typeof this.ctx?.effect === 'function'
              ? this.ctx.effect(() => removeRecord, `dsh-substrate: ${exposedName} conflict record`)
              : undefined
            return () => {
              removeRecord()
              disposeRecord?.()
              disposeTool()
            }
          } catch (retryError) {
            if (!duplicateRegistration(retryError, exposedName)) throw retryError
            ordinal += 1
          }
        }
      }
    }
  }

  state.refs += 1
  state.stores.add(store)
  let active = true
  return () => {
    if (!active) return
    active = false
    state.stores.delete(store)
    state.refs -= 1
    if (state.refs !== 0) return
    proto.register = state.original
    delete proto[PATCH_STATE]
  }
}
