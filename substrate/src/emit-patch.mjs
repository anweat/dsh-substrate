/**
 * L3 — the patch emitter.
 *
 * Turns arbitration decisions into entry-list patch rows: the artifact the
 * harness's own `applyEntryPatches` consumes. This is the volatile layer by
 * design — it encodes what the patch dialect accepts today, and nothing above
 * it knows that dialect exists.
 *
 * Three things it emits, and why each is expressible without an upstream change:
 *
 *   the sandbox group   a `cordis:group` row carrying `isolate` realms, which
 *                       is a first-class entry option (`vendor/loader`).
 *   re-homing           the patch algorithm has no move operation, so a row is
 *                       re-homed by disabling it at the root and inserting it
 *                       into the group. `insert` with an `id` targets a group.
 *   withholding         a client half only reaches the boot manifest while its
 *                       HOST row is active and not disabled, so `disabled:
 *                       true` is the whole client-plane lever.
 *
 * @module dsh-conflict-substrate/emit-patch
 */

/** Entry id of the group third-party rows are re-homed into. */
export const SANDBOX_ID = 'dsh-substrate-sandbox'

/**
 * Service names the sandbox gives its own realm.
 *
 * A realm is what lets a shim sit between these plugins and the real registry.
 * `tools` is deliberately absent: tool contention is remedied by scope
 * layering, which needs the REAL registry, and isolating it would cut the
 * plugins off from the catalog the model actually sees.
 */
export const SANDBOX_REALMS = Object.freeze(['webServer'])

/**
 * @typedef {object} EmitInput
 * @property {readonly object[]} decisions - arbitration output.
 * @property {ReadonlyMap<string, {id: string, name: string, config?: unknown}>} rows -
 *   the composed tree by entry id, as `ctx.loader.entries()` reports it.
 * @property {string} [groupId] - sandbox entry id.
 * @property {readonly string[]} [realms] - services the sandbox isolates.
 */

/**
 * Emit the patch layer that applies a set of decisions.
 *
 * **Precondition — the emitter owns its file wholesale.** The output is a
 * complete layer to be applied to a composition that does not already contain
 * it, which is how the layer stack works: `applyEntryPatches` runs the whole
 * patch list against the base tree on every compose and hot-reload. The rows
 * are not individually guard-conditioned, because the dialect has no
 * conditional — appending this output to a file that already holds a previous
 * generation duplicates the group and its inserts. Regenerate the file, never
 * append to it.
 *
 * @param input - decisions plus the composed rows they refer to.
 * @returns patch rows in application order, and what could not be emitted.
 */
export function emitPatch({ decisions, rows, groupId = SANDBOX_ID, realms = SANDBOX_REALMS }) {
  const patch = []
  const unresolved = []

  /** Rows to re-home, keyed by their current id, with the id they should take. */
  const rehome = new Map()
  /** Host rows to switch off so their client half never reaches the manifest. */
  const withhold = new Set()

  for (const d of decisions) {
    for (const a of d.actions ?? []) {
      if (a.action === 'rename' && d.kind === 'entry-id') {
        const row = rows.get(a.from)
        if (row === undefined) {
          unresolved.push({ action: a.action, id: a.from, why: 'row-not-in-composed-tree' })
          continue
        }
        rehome.set(a.from, { row, newId: a.to })
      } else if (a.action === 'drop-client') {
        // The decision names the slot; the row to switch off is the owner's.
        const owned = [...rows.values()].filter(r => r.owner === a.owner)
        if (owned.length === 0) {
          unresolved.push({ action: a.action, owner: a.owner, why: 'owner-has-no-row' })
          continue
        }
        for (const r of owned) withhold.add(r.id)
      }
      // `layer` and `isolate` are not patch-layer artifacts: the first is a
      // scope binding made at agent setup, the second is served by the realm
      // the sandbox group already declares.
    }
  }

  // 1. The sandbox group must exist before anything is inserted into it.
  patch.push({
    insert: [{
      id: groupId,
      name: 'cordis:group',
      group: true,
      isolate: Object.fromEntries(realms.map(r => [r, true])),
      config: [],
    }],
  })

  // 2. Switch off the rows being re-homed or withheld, at their original seat.
  for (const id of [...rehome.keys()].sort()) patch.push({ id, disabled: true })
  for (const id of [...withhold].sort()) {
    if (rehome.has(id)) continue // already disabled above
    patch.push({ id, disabled: true })
  }

  // 3. Re-insert the re-homed rows under the group, under their arbitrated id.
  const inserts = [...rehome.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, { row, newId }]) => ({
      id: newId,
      name: row.name,
      ...(row.config === undefined ? {} : { config: row.config }),
    }))
  if (inserts.length > 0) patch.push({ id: groupId, insert: inserts })

  return { patch, unresolved, summary: { rehomed: rehome.size, withheld: withhold.size, realms: [...realms] } }
}

/**
 * Render a patch list as the YAML dialect the harness reads.
 *
 * Deliberately minimal rather than a general serializer: the emitted shapes are
 * a closed set (ids, names, booleans, nested inserts), and a general YAML
 * dependency here would be a dependency on the whole layer being replaceable.
 * A value it cannot represent fails loud instead of emitting something wrong.
 *
 * @param patch - rows from {@link emitPatch}.
 * @returns YAML text.
 */
export function renderPatchYaml(patch) {
  const scalar = (v) => {
    if (typeof v === 'boolean' || typeof v === 'number') return String(v)
    if (typeof v === 'string') return /^[\w./@:-]+$/.test(v) ? v : JSON.stringify(v)
    throw new Error(`emit-patch: cannot render ${typeof v} as a patch scalar`)
  }
  const lines = []
  for (const row of patch) {
    const keys = Object.keys(row)
    let first = true
    const put = (text) => { lines.push(`${first ? '- ' : '  '}${text}`); first = false }
    for (const k of keys) {
      const v = row[k]
      if (k === 'insert') {
        put('insert:')
        for (const entry of v) {
          let entryFirst = true
          for (const [ek, ev] of Object.entries(entry)) {
            const prefix = entryFirst ? '    - ' : '      '
            entryFirst = false
            if (ek === 'config' && Array.isArray(ev) && ev.length === 0) lines.push(`${prefix}config: []`)
            else if (ek === 'isolate') {
              lines.push(`${prefix}isolate:`)
              for (const [rk, rv] of Object.entries(ev)) lines.push(`        ${rk}: ${scalar(rv)}`)
            } else if (ev !== null && typeof ev === 'object') {
              lines.push(`${prefix}${ek}:`)
              for (const [ck, cv] of Object.entries(ev)) lines.push(`        ${ck}: ${scalar(cv)}`)
            } else lines.push(`${prefix}${ek}: ${scalar(ev)}`)
          }
        }
      } else if (v !== null && typeof v === 'object') {
        put(`${k}:`)
        for (const [ck, cv] of Object.entries(v)) lines.push(`    ${ck}: ${scalar(cv)}`)
      } else put(`${k}: ${scalar(v)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
