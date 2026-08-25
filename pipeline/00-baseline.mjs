/**
 * Build the DSH baseline component taxonomy — the fixed set of "known modules"
 * third-party contributions are mapped onto. Every table is derived from the
 * dsh checkout itself (generated catalogs + shipped bundle patch files), never
 * hand-written, so the taxonomy tracks the product instead of drifting from it.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import yaml from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const DSH = process.argv[2] ?? process.env.DSH_ROOT ?? ''
const OUT = join(here, 'data/baseline.json')
mkdirSync(dirname(OUT), { recursive: true })

/** Import a generated, import-free TS data module by transpiling it in memory. */
async function importDataModule(relPath) {
  const source = readFileSync(join(DSH, relPath), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`)
}

/** The `!!js` expression tag the entry-list dialect carries (kept as an opaque marker). */
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: data => ({ __jsExpr: data }),
})
const ENTRY_SCHEMA = yaml.JSON_SCHEMA.extend(JsExpr)

/**
 * Faithful mirror of `vendor/include/src/index.ts:applyEntryPatches`, extended
 * to record WHICH action each patch performed against WHICH row — the
 * classification ("insert" / "override" / "disable") the shipped algorithm
 * applies but discards.
 */
function applyEntryPatches(data, patches, layerLabel, journal) {
  data = structuredClone(data)
  if (!patches?.length) return data
  const entryMap = new Map()
  const buildMap = (entries) => {
    for (const entry of entries) {
      if (entry?.id) entryMap.set(entry.id, entry)
      if (entry?.group && Array.isArray(entry.config)) buildMap(entry.config)
    }
  }
  buildMap(data)

  for (const patch of patches) {
    if (patch === null || typeof patch !== 'object') continue
    const { id, insert, name, ...overrides } = patch
    if (insert) {
      if (id) {
        const target = entryMap.get(id)
        if (!target) { journal.push({ layer: layerLabel, action: 'orphan-insert', target: id }); continue }
        if (!target.group) { journal.push({ layer: layerLabel, action: 'insert-into-non-group', target: id }); continue }
        if (!Array.isArray(target.config)) target.config = []
        target.config.push(...insert)
      } else {
        data.push(...insert)
      }
      for (const row of insert) {
        journal.push({
          layer: layerLabel, action: 'insert', target: row?.id ?? null,
          plugin: row?.name ?? null, into: id ?? '<root>',
          configKeys: configKeysOf(row?.config),
        })
      }
      buildMap(insert)
      continue
    }
    if (!id) { journal.push({ layer: layerLabel, action: 'missing-id' }); continue }
    const target = entryMap.get(id)
    if (!target) { journal.push({ layer: layerLabel, action: 'orphan-override', target: id }); continue }
    if (name && name !== target.name) {
      journal.push({ layer: layerLabel, action: 'name-mismatch', target: id, expected: target.name, got: name })
      continue
    }
    const beforeKeys = configKeysOf(target.config)
    for (const [key, value] of Object.entries(overrides)) {
      if (key === 'id') continue
      target[key] = value
    }
    const afterKeys = configKeysOf(overrides.config)
    journal.push({
      layer: layerLabel,
      action: overrides.disabled === true ? 'disable' : 'override',
      target: id,
      plugin: target.name ?? null,
      touchedFields: Object.keys(overrides),
      // A patch replaces the whole `config`, so any baseline key it does not
      // restate is silently dropped. This is the highest-value conflict signal.
      droppedConfigKeys: afterKeys.length > 0 ? beforeKeys.filter(k => !afterKeys.includes(k)) : [],
    })
  }
  return data
}

/** Object-valued config key names; a group's array config and scalars have none. */
function configKeysOf(config) {
  return config !== null && typeof config === 'object' && !Array.isArray(config) ? Object.keys(config) : []
}

const readPatchFile = rel => yaml.load(readFileSync(join(DSH, rel), 'utf8'), { schema: ENTRY_SCHEMA }) ?? []

/** Compose one profile's shipped bundle layers, keeping the per-layer journal. */
function composeProfile(bundleRels) {
  const journal = []
  let rows = []
  for (const rel of bundleRels) rows = applyEntryPatches(rows, readPatchFile(rel), rel, journal)
  return { rows, journal }
}

const PROFILES = {
  web: ['packages/bundle/base/cordis.patch.yml', 'packages/bundle/web-app/cordis.patch.yml'],
  headless: ['packages/bundle/base/cordis.patch.yml', 'packages/bundle/headless/cordis.patch.yml'],
}

const flatten = (rows, out = []) => {
  for (const r of rows) {
    out.push({
      id: r.id ?? null,
      name: r.name ?? null,
      disabled: r.disabled === true,
      group: r.group === true,
      inject: r.inject ?? null,
      configKeys: configKeysOf(r.config),
    })
    if (r.group && Array.isArray(r.config)) flatten(r.config, out)
  }
  return out
}

const slotMod = await importDataModule('packages/extensions/cordis-client-runner/src/client/slot-catalog.ts')
const apiMod = await importDataModule('packages/extensions/tool-cordis/src/api-catalog.ts')

// Two columns carry a name a deployment can actually see: the registered names,
// and the shipped aliases a package takes when a composition loads it more than
// once under different `toolName` config. Reading only the first misses
// `subagent_fork`, which is real, and a missing name reads as a free seat.
const toolMd = readFileSync(join(DSH, 'docs/tool-catalog.md'), 'utf8')
const TOOL_NAME_COLUMNS = [0, 3]
const tools = []
const seenTool = new Set()
for (const line of toolMd.split('\n')) {
  const head = /^\|\s*`(@deepseek-ai\/[^`]+)`\s*\|(.*)$/.exec(line)
  if (head === null) continue
  const columns = head[2].split('|')
  for (const column of TOOL_NAME_COLUMNS) {
    for (const hit of (columns[column] ?? '').matchAll(/`([a-z0-9_]+)`/g)) {
      const key = `${head[1]} ${hit[1]}`
      if (seenTool.has(key)) continue
      seenTool.add(key)
      tools.push({ name: hit[1], package: head[1] })
    }
  }
}

/**
 * Every workspace manifest, so a bundle row can be expanded to what it mounts.
 *
 * A profile's row list names bundles, not their constituents:
 * `@deepseek-ai/dsh-agent-spine-demo` mounts `tool-bash`, `tool-jobs`, and
 * `tool-skill` from inside its own `apply`, and none of those names appear in
 * the composed config. Deriving the shipped tool set from the row list alone
 * therefore reports free seats that are taken — measured against a real boot of
 * `examples/headless-agent`, 12 of the 15 shipped names, missing six.
 */
function workspaceManifests(root) {
  const found = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (entry.name !== 'package.json') continue
      try {
        const manifest = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof manifest.name === 'string') found.set(manifest.name, manifest)
      } catch {
        // A malformed manifest in the checkout is not this generator's to
        // report; the packages it can read still produce a usable catalog.
      }
    }
  }
  walk(join(root, 'packages'))
  return found
}

/**
 * Close a row list over `peerDependencies`, which is how a harness package
 * declares what it expects to be present — `dependencies` carries almost
 * nothing here by convention, and `devDependencies` adds only test-time
 * packages, measurably no extra tools.
 *
 * The closure over-derives on purpose. A tool registered behind config
 * (`read_image`, `list_agents`, `report` are shipped but did not appear in a
 * real boot) is not statically decidable, and the two errors are not
 * symmetric: a name wrongly believed taken costs one plugin an unnecessary
 * scope, while a name wrongly believed free costs the whole composition its
 * boot. `mayRegisterMore` marks that this set is an upper bound.
 */
function expandThroughBundles(entries, manifests) {
  const seen = new Set()
  const queue = entries.map(entry => entry.name).filter(name => typeof name === 'string')
  while (queue.length > 0) {
    const name = queue.pop()
    if (seen.has(name)) continue
    seen.add(name)
    const manifest = manifests.get(name)
    if (manifest === undefined) continue
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      if (dependency.startsWith('@deepseek-ai/dsh-') && !seen.has(dependency)) queue.push(dependency)
    }
  }
  return [...seen].sort()
}

const manifests = workspaceManifests(DSH)
const toolsByPackage = new Map()
for (const tool of tools) {
  if (!toolsByPackage.has(tool.package)) toolsByPackage.set(tool.package, [])
  toolsByPackage.get(tool.package).push(tool.name)
}

const profiles = {}
for (const [name, rels] of Object.entries(PROFILES)) {
  const { rows, journal } = composeProfile(rels)
  const entries = flatten(rows)
  const packages = expandThroughBundles(entries, manifests)
  const shippedTools = [...new Set(packages.flatMap(pkg => toolsByPackage.get(pkg) ?? []))].sort()
  profiles[name] = { entries, journal, packages, shippedTools, mayRegisterMore: true }
}

const baseline = {
  generatedAt: new Date().toISOString(),
  dshRoot: DSH,
  slots: slotMod.CLIENT_SLOT_API.map(s => ({
    key: s.key, kind: s.kind, scope: s.scope, declaredBy: s.declaredBy,
    occupants: s.occupants, replaceRisk: s.replaceRisk, summary: s.summary,
  })),
  services: apiMod.SERVICE_API.map(s => ({ key: s.key, methods: (s.methods ?? []).length })),
  events: apiMod.EVENT_API.map(e => ({ name: e.name, mode: e.mode ?? null })),
  tools,
  profiles,
}
writeFileSync(OUT, JSON.stringify(baseline, null, 2))

console.log('baseline written -> data/baseline.json')
console.log(`  slots      ${baseline.slots.length}  (shadows-shipped-ui: ${baseline.slots.filter(s => s.replaceRisk !== 'none').length})`)
console.log(`  services   ${baseline.services.length}`)
console.log(`  events     ${baseline.events.length}`)
console.log(`  tools      ${baseline.tools.length}`)
for (const [name, prof] of Object.entries(profiles)) {
  const counts = {}
  for (const item of prof.journal) counts[item.action] = (counts[item.action] ?? 0) + 1
  console.log(`  profile ${name}: ${prof.entries.length} rows | ${JSON.stringify(counts)}`)
}
const dropped = profiles.web.journal.filter(x => (x.droppedConfigKeys?.length ?? 0) > 0)
if (dropped.length > 0) {
  console.log('\n  [signal] web-profile overrides that dropped baseline config keys:')
  for (const d of dropped) console.log(`    ${d.target} (${d.layer}) dropped: ${d.droppedConfigKeys.join(', ')}`)
}
