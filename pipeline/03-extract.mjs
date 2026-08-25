/**
 * Map every cloned plugin onto the DSH baseline component taxonomy.
 *
 * Two independent planes are read, because plugins ship them differently:
 *
 *  - DECLARATIVE (authoritative): `package.json#dsh` and the `cordis.patch.yml`
 *    a bundle exports. Running that patch list through the shipped patch
 *    algorithm against the composed baseline yields exactly what the plugin
 *    does to the tree — insert / override / disable — plus the failure modes
 *    the algorithm only warns about (orphan target, name mismatch).
 *
 *  - IMPLEMENTATION (heuristic): registration call sites in whatever JS/TS the
 *    repo ships. Bundlers rename identifiers but never property names, so
 *    matching is keyed on the property chain suffix (`.slots.register`) and the
 *    string literals passed to it, never on a `ctx` variable name.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import yaml from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const REPOS_DIR = join(here, 'data/repos')
const baseline = JSON.parse(readFileSync(join(here, 'data/baseline.json'), 'utf8'))

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', resolve: d => typeof d === 'string', construct: d => ({ __jsExpr: d }),
})
const ENTRY_SCHEMA = yaml.JSON_SCHEMA.extend(JsExpr)

const SKIP_DIRS = new Set(['.git', 'node_modules', 'assets', 'screenshots', 'images', 'docs', 'dist-types', '.github', 'coverage'])
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.tsx', '.jsx'])
const MAX_FILE_BYTES = 3_000_000
const MAX_FILES_PER_REPO = 400

/** Baseline lookup tables. */
const slotByKey = new Map(baseline.slots.map(s => [s.key, s]))
const toolNames = new Set(baseline.tools.map(t => t.name))
const eventNames = new Set(baseline.events.map(e => e.name))
const serviceKeys = new Set(baseline.services.map(s => s.key))
const webRows = baseline.profiles.web.entries
const baselineRowById = new Map(webRows.filter(r => r.id).map(r => [r.id, r]))

/** Recursively list candidate code files, bounded so one pathological repo cannot stall the run. */
function listFiles(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 6 || out.length >= MAX_FILES_PER_REPO) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= MAX_FILES_PER_REPO) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1)
      } else if (CODE_EXT.has(extname(e.name)) && !e.name.endsWith('.d.ts') && !e.name.endsWith('.min.js')) {
        out.push(full)
      }
    }
  }
  walk(root, 0)
  return out
}

/** The identifier/property chain of a property-access callee, outermost last. */
function chainOf(expr) {
  const parts = []
  let node = expr
  while (ts.isPropertyAccessExpression(node)) {
    parts.unshift(node.name.text)
    node = node.expression
  }
  if (ts.isIdentifier(node)) parts.unshift(node.text)
  else if (node.kind === ts.SyntaxKind.ThisKeyword) parts.unshift('this')
  else parts.unshift('?')
  return parts
}

const literal = node =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined

/**
 * Strip the wrappers a definition object is commonly passed through before it
 * reaches a register call — `defineTool({...})`, `({...} as const)`,
 * `{...} satisfies X` — so the literal underneath stays readable.
 */
function unwrap(node, depth = 0) {
  if (node === undefined || depth > 4) return node
  if (ts.isParenthesizedExpression(node)) return unwrap(node.expression, depth + 1)
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node)) return unwrap(node.expression, depth + 1)
  if (ts.isCallExpression(node) && node.arguments.length >= 1) return unwrap(node.arguments[0], depth + 1)
  return node
}

/** A string-literal property of an object-literal argument, when present. */
function objectProp(raw, name) {
  const node = unwrap(raw)
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return undefined
  for (const p of node.properties) {
    if (ts.isPropertyAssignment(p) && p.name !== undefined
      && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) {
      return literal(p.initializer)
    }
  }
  return undefined
}

/** Every registration-shaped call site in one source file. */
function scanSource(path, text, repoRoot) {
  const kind = /\.tsx$|\.jsx$/.test(path) ? ts.ScriptKind.TSX
    : /\.ts$|\.mts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
  const rel = relative(repoRoot, path).split('\\').join('/')
  const hits = []

  const record = (h) => { hits.push({ ...h, source: `${rel}:${sf.getLineAndCharacterOfPosition(h.pos).line + 1}` }) }

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const chain = chainOf(node.expression)
      const method = chain[chain.length - 1]
      const registry = chain.length >= 2 ? chain[chain.length - 2] : undefined
      const [a0, a1] = node.arguments
      const pos = node.getStart(sf)

      if (registry === 'slots' && method === 'register') {
        const key = objectProp(a0, 'name') ?? literal(a0)
        record({ plane: 'client', verb: 'slot-register', target: key ?? null,
          entryKey: objectProp(a0, 'key') ?? null, entryId: objectProp(a0, 'id') ?? null,
          resolved: key !== undefined, pos })
      } else if (registry === 'slots' && method === 'inject') {
        // A dependency declaration ("this seat must exist"), not a contribution.
        record({ plane: 'client', verb: 'slot-inject', target: literal(a0) ?? null,
          resolved: literal(a0) !== undefined, dependency: true, pos })
      } else if (registry === 'tools' && method === 'register') {
        const name = objectProp(a0, 'name')
        record({ plane: 'host', verb: 'tool-register', target: name ?? null, resolved: name !== undefined, pos })
      } else if (registry === 'commands' && method === 'register') {
        const name = objectProp(a0, 'name') ?? literal(a0)
        record({ plane: 'host', verb: 'command-register', target: name ?? null, resolved: name !== undefined, pos })
      } else if (method === 'on' || method === 'once') {
        const ev = literal(a0)
        if (ev !== undefined && (ev.includes('/') || eventNames.has(ev))) {
          record({ plane: 'host', verb: 'event-listen', target: ev, resolved: true, pos })
        }
      } else if (method === 'register' && registry !== undefined && serviceKeys.has(registry)) {
        record({ plane: 'host', verb: `${registry}-register`, target: objectProp(a0, 'name') ?? literal(a0) ?? null,
          resolved: true, pos })
      } else if ((method === 'provide' || method === 'set') && chain.length >= 2) {
        const key = literal(a0)
        if (key !== undefined && serviceKeys.has(key)) record({ plane: 'host', verb: 'service-provide', target: key, resolved: true, pos })
      }
      void a1
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

/** Mirror of the shipped patch algorithm, journalling the action it applies per patch. */
function applyEntryPatches(data, patches, layerLabel, journal) {
  data = structuredClone(data)
  if (!Array.isArray(patches) || patches.length === 0) return data
  const entryMap = new Map()
  const buildMap = (entries) => {
    for (const entry of entries) {
      if (entry?.id) entryMap.set(entry.id, entry)
      if (entry?.group && Array.isArray(entry.config)) buildMap(entry.config)
    }
  }
  buildMap(data)
  const keysOf = c => (c !== null && typeof c === 'object' && !Array.isArray(c) ? Object.keys(c) : [])

  for (const patch of patches) {
    if (patch === null || typeof patch !== 'object') { journal.push({ layer: layerLabel, action: 'malformed-patch' }); continue }
    const { id, insert, name, ...overrides } = patch
    if (insert) {
      if (Array.isArray(insert)) {
        if (id) {
          const target = entryMap.get(id)
          if (!target) { journal.push({ layer: layerLabel, action: 'orphan-insert', target: id }); continue }
          if (!target.group) { journal.push({ layer: layerLabel, action: 'insert-into-non-group', target: id }); continue }
          if (!Array.isArray(target.config)) target.config = []
          target.config.push(...insert)
        } else data.push(...insert)
        for (const row of insert) {
          journal.push({ layer: layerLabel, action: 'insert', target: row?.id ?? null,
            plugin: row?.name ?? null, into: id ?? '<root>', configKeys: keysOf(row?.config) })
        }
        buildMap(insert)
      }
      continue
    }
    if (!id) { journal.push({ layer: layerLabel, action: 'missing-id' }); continue }
    const target = entryMap.get(id)
    if (!target) { journal.push({ layer: layerLabel, action: 'orphan-override', target: id }); continue }
    if (name && name !== target.name) {
      journal.push({ layer: layerLabel, action: 'name-mismatch', target: id, expected: target.name, got: name }); continue
    }
    const beforeKeys = keysOf(target.config)
    for (const [key, value] of Object.entries(overrides)) { if (key !== 'id') target[key] = value }
    const afterKeys = keysOf(overrides.config)
    journal.push({
      layer: layerLabel,
      action: overrides.disabled === true ? 'disable' : 'override',
      target: id, plugin: target.name ?? null, touchedFields: Object.keys(overrides),
      droppedConfigKeys: afterKeys.length > 0 ? beforeKeys.filter(k => !afterKeys.includes(k)) : [],
    })
  }
  return data
}

/** Read a repo's root manifest plus any manifest a workspace-less plugin nests one level down. */
function findManifests(root) {
  const found = []
  const rootPkg = join(root, 'package.json')
  if (existsSync(rootPkg)) found.push(rootPkg)
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return found }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue
    const nested = join(root, e.name, 'package.json')
    if (existsSync(nested)) found.push(nested)
  }
  return found.slice(0, 8)
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

function analyzeRepo(dir) {
  const full = dir.replace('__', '/')
  const manifests = findManifests(dir).map(p => ({ path: p, json: readJson(p) })).filter(m => m.json !== null)
  const dshManifest = manifests.find(m => m.json.dsh !== undefined)
  const pkg = dshManifest?.json ?? manifests[0]?.json ?? null

  // ---- declarative plane -------------------------------------------------
  const patchJournal = []
  const patchFiles = []
  const declaredPatch = pkg?.dsh?.bundle?.patch
  const candidates = new Set()
  if (declaredPatch && dshManifest) candidates.add(join(dirname(dshManifest.path), declaredPatch))
  candidates.add(join(dir, 'cordis.patch.yml'))
  candidates.add(join(dir, 'cordis.yml'))
  for (const p of candidates) {
    if (!existsSync(p)) continue
    let parsed
    try { parsed = yaml.load(readFileSync(p, 'utf8'), { schema: ENTRY_SCHEMA }) } catch (e) {
      patchJournal.push({ layer: relative(dir, p), action: 'patch-parse-error', error: String(e).slice(0, 160) })
      continue
    }
    const rel = relative(dir, p).split('\\').join('/')
    patchFiles.push(rel)
    // Compose against the shipped web baseline: what this plugin does to a real tree.
    applyEntryPatches(structuredClone(rawWebRows), Array.isArray(parsed) ? parsed : [], rel, patchJournal)
  }

  // ---- implementation plane ----------------------------------------------
  const hits = []
  const scanErrors = []
  let scanned = 0
  let skipped = 0
  for (const f of listFiles(dir)) {
    let st
    try { st = statSync(f) } catch { continue }
    if (st.size > MAX_FILE_BYTES) { skipped += 1; continue }
    let text
    try { text = readFileSync(f, 'utf8') } catch { continue }
    if (!/\.(register|inject|on|once|provide|set)\s*\(/.test(text)) { scanned += 1; continue }
    try { hits.push(...scanSource(f, text, dir)) } catch (e) {
      skipped += 1
      scanErrors.push(`${relative(dir, f)}: ${String(e).slice(0, 200)}`)
    }
    scanned += 1
  }

  // ---- map onto the baseline taxonomy -------------------------------------
  const contributions = hits.map((h) => {
    if (h.verb === 'slot-register') {
      const slot = h.target !== null ? slotByKey.get(h.target) : undefined
      return {
        ...h,
        known: slot !== undefined,
        slotKind: slot?.kind ?? null,
        // A `single` seat, or a `keyed` seat whose key the shipped UI already
        // occupies, means this registration REPLACES shipped UI rather than
        // sitting beside it.
        action: slot === undefined ? 'unknown-target'
          : slot.kind === 'single' ? 'override'
            : slot.kind === 'keyed'
              ? (slot.occupants.some(o => h.entryKey !== null && o.includes(`'${h.entryKey}'`)) ? 'override' : 'add')
              : 'add',
        replaceRisk: slot?.replaceRisk ?? null,
        occupants: slot?.occupants?.length ?? 0,
      }
    }
    if (h.verb === 'tool-register') {
      return { ...h, known: h.target !== null && toolNames.has(h.target),
        action: h.target !== null && toolNames.has(h.target) ? 'collision' : 'add' }
    }
    if (h.verb === 'event-listen') {
      return { ...h, known: eventNames.has(h.target ?? ''), action: 'observe' }
    }
    return { ...h, known: null, action: 'add' }
  })

  const rowTargets = patchJournal.filter(j => j.action === 'override' || j.action === 'disable')
  return {
    repo: full,
    pkgName: pkg?.name ?? null,
    version: pkg?.version ?? null,
    hasDshField: pkg?.dsh !== undefined,
    dsh: pkg?.dsh ?? null,
    manifestCount: manifests.length,
    peerDeps: Object.keys(pkg?.peerDependencies ?? {}).filter(d => d.startsWith('@deepseek-ai/')),
    patchFiles,
    patchJournal,
    filesScanned: scanned,
    filesSkipped: skipped,
    scanErrors,
    contributions,
    summary: {
      configInserts: patchJournal.filter(j => j.action === 'insert').length,
      configOverrides: rowTargets.filter(j => j.action === 'override').length,
      configDisables: rowTargets.filter(j => j.action === 'disable').length,
      configOrphans: patchJournal.filter(j => j.action.startsWith('orphan')).length,
      droppedKeyPatches: patchJournal.filter(j => (j.droppedConfigKeys?.length ?? 0) > 0).length,
      slotOverrides: contributions.filter(c => c.verb === 'slot-register' && c.action === 'override').length,
      slotAdds: contributions.filter(c => c.verb === 'slot-register' && c.action === 'add').length,
      slotUnknown: contributions.filter(c => c.verb === 'slot-register' && c.action === 'unknown-target').length,
      toolAdds: contributions.filter(c => c.verb === 'tool-register').length,
      toolCollisions: contributions.filter(c => c.verb === 'tool-register' && c.action === 'collision').length,
      events: contributions.filter(c => c.verb === 'event-listen').length,
    },
  }
}

// The baseline rows the plugin patch is composed against (the shipped web tree,
// reconstructed as raw entry rows so ids and configs are patchable).
const rawWebRows = webRows.filter(r => r.id !== null).map(r => ({
  id: r.id, name: r.name, ...(r.group ? { group: true, config: [] } : {}),
  ...(r.configKeys.length > 0 ? { config: Object.fromEntries(r.configKeys.map(k => [k, null])) } : {}),
}))
void baselineRowById

const dirs = readdirSync(REPOS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
process.stderr.write(`analyzing ${dirs.length} cloned repos\n`)
const results = []
for (const [i, name] of dirs.entries()) {
  try { results.push(analyzeRepo(join(REPOS_DIR, name))) } catch (e) {
    results.push({ repo: name.replace('__', '/'), error: String(e).slice(0, 200) })
  }
  if ((i + 1) % 100 === 0) process.stderr.write(`  ${i + 1}/${dirs.length}\n`)
}
writeFileSync(join(here, 'out/extract.json'), JSON.stringify(results, null, 2))
process.stderr.write(`wrote out/extract.json (${results.length} repos)\n`)
