/**
 * L3 — the preset emitter.
 *
 * Produces an agent-plane composition (`agent.cordis.yml`) so third-party
 * plugins register where the shipped design puts model-facing rows, instead of
 * into the global layer the product means to keep empty.
 *
 * **The constraint that shapes this emitter.** A preset is mounted ONCE under
 * one standing scope, and an agent binds to that single key — so every row in
 * one preset shares one registration layer. Two plugins that contend for a
 * name therefore cannot both live in one preset: they would collide exactly as
 * they do at the root. Layering them needs a scope per plugin, which is the
 * scope-chain path, not this one.
 *
 * So this emitter composes a CONFLICT-FREE set and reports what it had to
 * leave out, rather than emitting a preset that fails to mount.
 *
 * @module dsh-conflict-substrate/emit-preset
 */

import { byCell, parseCell, KIND_ARITY } from './model.mjs'

/**
 * Split plugins into those that can share one preset layer and those that cannot.
 *
 * @param plugins - `{ owner, module, config?, contributions }` per package.
 * @returns the admissible set, and the excluded ones with the cell that excluded them.
 */
export function partitionForPreset(plugins) {
  const admitted = []
  const excluded = []
  const claimed = new Map() // cell → the owner that took it first

  // Deterministic order so the same input always admits the same set: the
  // caller's precedence, not the order the corpus happened to be read in.
  for (const plugin of plugins) {
    const conflicts = []
    for (const [cell] of byCell(plugin.contributions ?? [])) {
      const { kind } = parseCell(cell)
      if (KIND_ARITY[kind] !== 'exclusive') continue
      const taken = claimed.get(cell)
      if (taken !== undefined && taken !== plugin.owner) conflicts.push({ cell, takenBy: taken })
    }
    if (conflicts.length > 0) {
      excluded.push({ owner: plugin.owner, conflicts })
      continue
    }
    for (const [cell] of byCell(plugin.contributions ?? [])) {
      const { kind } = parseCell(cell)
      if (KIND_ARITY[kind] === 'exclusive') claimed.set(cell, plugin.owner)
    }
    admitted.push(plugin)
  }
  return { admitted, excluded }
}

/**
 * Build the composition rows for an admitted plugin.
 *
 * A package that PROVIDES a service gets wrapped in a `cordis:group` carrying
 * an entry-local `isolate` realm. Without one it publishes into the root realm,
 * where it is process-global and a second preset providing the same name
 * collides — the shipped `standard` preset states this rule and follows it
 * three times.
 */
function rowsFor(plugin) {
  const provides = [...new Set((plugin.contributions ?? [])
    .filter(c => c.kind === 'service')
    .map(c => c.target))].sort()
  const row = {
    id: plugin.id ?? plugin.owner.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    name: plugin.module,
    ...(plugin.config === undefined ? {} : { config: plugin.config }),
  }
  if (provides.length === 0) return [row]
  return [{
    id: `${row.id}-realm`,
    name: 'cordis:group',
    group: true,
    isolate: Object.fromEntries(provides.map(s => [s, true])),
    config: [row],
  }]
}

/**
 * Emit an agent-plane preset.
 *
 * @param input - `{ plugins, meta }`; plugins in precedence order.
 * @returns the composition rows, the preset metadata, and what was excluded.
 */
export function emitPreset({ plugins, meta = {} }) {
  const { admitted, excluded } = partitionForPreset(plugins)
  const rows = admitted.flatMap(rowsFor)
  return {
    rows,
    meta: {
      name: meta.name ?? 'substrate',
      description: meta.description
        ?? `底座编排的 agent 平面组合:${admitted.length} 个插件`,
      ...(meta.order === undefined ? {} : { order: meta.order }),
    },
    excluded,
    summary: {
      admitted: admitted.length,
      excluded: excluded.length,
      realms: rows.filter(r => r.group === true).length,
    },
  }
}

/**
 * Render composition rows as the entry-list YAML a preset file holds.
 *
 * Same deliberate minimalism as the patch renderer: the emitted shapes are a
 * closed set, and a value it cannot represent fails loud rather than producing
 * a file that parses into something else.
 *
 * @param rows - rows from {@link emitPreset}.
 * @param indent - leading spaces, used when rendering nested group config.
 * @returns YAML text.
 */
export function renderPresetYaml(rows, indent = 0) {
  const pad = ' '.repeat(indent)
  const scalar = (v) => {
    if (typeof v === 'boolean' || typeof v === 'number') return String(v)
    if (typeof v === 'string') return /^[\w./@:-]+$/.test(v) ? v : JSON.stringify(v)
    throw new Error(`emit-preset: cannot render ${typeof v} as a scalar`)
  }
  const lines = []
  for (const row of rows) {
    let first = true
    const put = (text) => { lines.push(`${pad}${first ? '- ' : '  '}${text}`); first = false }
    for (const [k, v] of Object.entries(row)) {
      if (k === 'config' && Array.isArray(v)) {
        put('config:')
        lines.push(renderPresetYaml(v, indent + 4).replace(/\n$/, ''))
      } else if (v !== null && typeof v === 'object') {
        put(`${k}:`)
        for (const [ck, cv] of Object.entries(v)) lines.push(`${pad}    ${ck}: ${scalar(cv)}`)
      } else put(`${k}: ${scalar(v)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** Render the sidecar `preset.yml` the roster reads for name/description/order. */
export function renderPresetMetaYaml(meta) {
  const lines = [`name: ${JSON.stringify(meta.name)}`, `description: ${JSON.stringify(meta.description)}`]
  if (meta.order !== undefined) lines.push(`order: ${meta.order}`)
  return `${lines.join('\n')}\n`
}
