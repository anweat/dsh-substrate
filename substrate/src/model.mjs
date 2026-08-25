/**
 * L1 — the contribution vocabulary.
 *
 * The most stable layer: it names what a plugin contributes without referring
 * to any harness API. Everything above it (arbitration) is a pure function of
 * these records, and everything below (the scanner, the emitters) only has to
 * produce or consume them. A harness change should reach the emitters, not
 * this file.
 *
 * @module dsh-conflict-substrate/model
 */

/**
 * The kinds a contribution can be, and how the runtime treats a second claim
 * on the same target. `exclusive` means the runtime refuses or shadows;
 * `additive` means two claims compose and are never a conflict.
 */
export const KIND_ARITY = Object.freeze({
  tool: 'exclusive', // tools.register throws on a duplicate in one layer
  'entry-id': 'exclusive', // the loader's id map keeps one row per id
  'config-row': 'exclusive', // a patch replaces the whole config; last layer wins
  route: 'exclusive', // webServer.register throws on a duplicate path
  'slot-single': 'exclusive', // one cell; lowest priority renders, rest invisible
  'slot-keyed': 'exclusive', // one cell per key
  'slot-list': 'additive', // additive by construction
  'slot-chain': 'additive', // election consumes every entry
  event: 'additive', // many listeners; ordering is a separate hazard
  service: 'exclusive', // provide() throws on a second registration in a realm
})

/** Every kind the model knows, for validation and exhaustive reporting. */
export const KINDS = Object.freeze(Object.keys(KIND_ARITY))

/**
 * One thing a package contributes.
 * @typedef {object} Contribution
 * @property {'host'|'client'} plane - which half registers it.
 * @property {keyof KIND_ARITY} kind - what sort of contribution it is.
 * @property {string} target - the contended name: tool name, entry id, route path, slot key.
 * @property {string} owner - the contributing package.
 * @property {string|null} source - `file:line` of the registration, when known.
 * @property {string|null} [entryKey] - for keyed slots, the cell within the slot.
 * @property {boolean} [shipped] - true when the harness itself contributes it.
 */

/**
 * Normalize one scanner record into contributions.
 *
 * The scanner's vocabulary is verb-shaped (`tool-register`, `slot-register`);
 * arbitration wants arity-shaped kinds, and a slot's arity depends on the
 * baseline's declaration rather than on the call site. Unresolved targets are
 * dropped here rather than downstream: a registration whose name is not a
 * literal cannot be arbitrated, and counting it as a conflict would be a
 * guess presented as a finding.
 *
 * @param record - one scanner record (`records.jsonl` line, status `ok`).
 * @param slotKinds - slot key → `single`/`list`/`keyed`/`chain` from the baseline.
 * @returns the contributions it makes, and what had to be dropped.
 */
export function contributionsOf(record, slotKinds = new Map()) {
  const owner = record.pkgName ?? record.repo
  const out = []
  const dropped = []

  for (const c of record.contributions ?? []) {
    if (c.verb === 'slot-inject') continue
    if (c.target === null || c.target === undefined) {
      dropped.push({ owner, verb: c.verb, source: c.source ?? null, why: 'target-not-literal' })
      continue
    }
    if (c.verb === 'tool-register') {
      out.push({ plane: 'host', kind: 'tool', target: c.target, owner, source: c.source ?? null })
    } else if (c.verb === 'route-register' || c.verb === 'route-upgrade') {
      out.push({ plane: 'host', kind: 'route', target: c.target, owner, source: c.source ?? null })
    } else if (c.verb === 'event-listen') {
      out.push({ plane: 'host', kind: 'event', target: c.target, owner, source: c.source ?? null })
    } else if (c.verb === 'service-provide') {
      // Which services a package provides decides whether its row needs an
      // isolate realm: a service row outside one publishes into the root realm,
      // where a second preset providing the same name collides.
      out.push({ plane: 'host', kind: 'service', target: c.target, owner, source: c.source ?? null })
    } else if (c.verb === 'slot-register') {
      const arity = slotKinds.get(c.target)
      if (arity === undefined) {
        dropped.push({ owner, verb: c.verb, target: c.target, source: c.source ?? null, why: 'slot-not-in-baseline' })
        continue
      }
      out.push({
        plane: 'client',
        kind: `slot-${arity}`,
        target: c.target,
        owner,
        source: c.source ?? null,
        entryKey: c.entryKey ?? null,
      })
    }
  }

  for (const j of record.patchJournal ?? []) {
    if (j.target === null || j.target === undefined) continue
    if (j.action === 'insert') {
      // `module` rides along because re-homing a row means re-inserting it,
      // and an insert without the plugin specifier is not a row.
      out.push({
        plane: 'host',
        kind: 'entry-id',
        target: j.target,
        owner,
        source: j.layer ?? null,
        module: j.plugin ?? null,
        into: j.into ?? '<root>',
      })
    } else if (j.action === 'override' || j.action === 'disable') {
      out.push({
        plane: 'host',
        kind: 'config-row',
        target: j.target,
        owner,
        source: j.layer ?? null,
        droppedConfigKeys: j.droppedConfigKeys ?? [],
      })
    }
  }

  return { contributions: out, dropped }
}

/**
 * Field separator inside a cell id. A control character cannot appear in a
 * tool name, entry id, route path, or slot key, so a cell id round-trips
 * through {@link parseCell} without escaping.
 */
export const CELL_SEP = String.fromCharCode(31)

/**
 * Group contributions by the cell two claims would actually contend for.
 *
 * A keyed slot contends per key, not per slot, so its cell carries the key;
 * everything else contends on the target alone. Getting this wrong is the
 * difference between "three plugins share a slot" and "three plugins collide".
 *
 * @param contributions - the contributions to group.
 * @returns cell id → contributions claiming it.
 */
export function byCell(contributions) {
  const cells = new Map()
  for (const c of contributions) {
    const cell = c.kind === 'slot-keyed'
      ? `${c.kind}${CELL_SEP}${c.target}${CELL_SEP}${c.entryKey ?? '<unresolved>'}`
      : `${c.kind}${CELL_SEP}${c.target}`
    if (!cells.has(cell)) cells.set(cell, [])
    cells.get(cell).push(c)
  }
  return cells
}

/**
 * Split a cell id back into its parts. The only supported way to read one —
 * consumers that split on a literal duplicate the format and drift from it.
 * @param cell - a cell id produced by {@link byCell}.
 * @returns the kind, target, and (for keyed slots) the entry key.
 */
export function parseCell(cell) {
  const [kind, target, entryKey] = cell.split(CELL_SEP)
  return { kind, target, entryKey: entryKey ?? null }
}
