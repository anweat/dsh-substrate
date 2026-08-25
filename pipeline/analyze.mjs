/**
 * Extraction core: map ONE plugin checkout onto the DSH baseline taxonomy.
 *
 * Kept free of orchestration so both the batch runner (03-extract.mjs) and the
 * streaming clone-analyze-delete runner (05-stream.mjs) share exactly one
 * implementation of what a contribution is.
 *
 * Two planes are read, because plugins ship them differently:
 *  - DECLARATIVE (authoritative): `package.json#dsh` plus the `cordis.patch.yml`
 *    a bundle exports, replayed through a mirror of the shipped patch algorithm.
 *  - IMPLEMENTATION (heuristic): registration call sites in whatever JS/TS the
 *    repo ships. Bundlers rename identifiers but never property names, so the
 *    match is keyed on the property-chain suffix (`.slots.register`) and the
 *    string literals passed to it, never on a `ctx` variable name.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, extname } from 'node:path'
import ts from 'typescript'
import yaml from 'js-yaml'

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', resolve: d => typeof d === 'string', construct: d => ({ __jsExpr: d }),
})
export const ENTRY_SCHEMA = yaml.JSON_SCHEMA.extend(JsExpr)

const SKIP_DIRS = new Set(['.git', 'node_modules', 'assets', 'screenshots', 'images', 'docs', 'dist-types', '.github', 'coverage', 'test', 'tests', '__tests__'])
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.tsx', '.jsx'])
const MAX_FILE_BYTES = 3_000_000
const MAX_FILES_PER_REPO = 300

/** Lookup tables derived once from the baseline and reused across repos. */
export function indexBaseline(baseline) {
  const webRows = baseline.profiles.web.entries
  return {
    slotByKey: new Map(baseline.slots.map(s => [s.key, s])),
    toolNames: new Set(baseline.tools.map(t => t.name)),
    eventNames: new Set(baseline.events.map(e => e.name)),
    serviceKeys: new Set(baseline.services.map(s => s.key)),
    // The shipped web tree as raw patchable rows, so a plugin's patch composes
    // against a real baseline instead of an empty list.
    rawWebRows: webRows.filter(r => r.id !== null).map(r => ({
      id: r.id,
      name: r.name,
      ...(r.group ? { group: true, config: [] } : {}),
      ...(r.configKeys.length > 0 ? { config: Object.fromEntries(r.configKeys.map(k => [k, null])) } : {}),
    })),
  }
}

/**
 * Recursively list candidate code files, bounded so one pathological repo
 * cannot stall the run.
 *
 * Build output is skipped only when sources sit beside it: a package holding
 * both `src/` and `lib/` would otherwise report every registration twice, once
 * per plane. Most published plugins ship `lib/` alone, and there it IS the
 * source of record.
 */
function listFiles(root) {
  const out = []
  const hasSource = existsSync(join(root, 'src'))
  const skipBuild = new Set(hasSource ? ['lib', 'dist', 'build', 'out'] : [])
  const walk = (dir, depth) => {
    if (depth > 6 || out.length >= MAX_FILES_PER_REPO) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= MAX_FILES_PER_REPO) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !(depth === 0 && skipBuild.has(e.name))) walk(full, depth + 1)
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
function scanSource(path, text, repoRoot, idx) {
  const kind = /\.tsx$|\.jsx$/.test(path) ? ts.ScriptKind.TSX
    : /\.ts$|\.mts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
  const rel = relative(repoRoot, path).split('\\').join('/')
  const hits = []
  const record = (h) => { hits.push({ ...h, source: `${rel}:${sf.getLineAndCharacterOfPosition(h.pos).line + 1}`, pos: undefined }) }

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const chain = chainOf(node.expression)
      const method = chain[chain.length - 1]
      const registry = chain.length >= 2 ? chain[chain.length - 2] : undefined
      const a0 = node.arguments[0]
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
        if (ev !== undefined && (ev.includes('/') || idx.eventNames.has(ev))) {
          record({ plane: 'host', verb: 'event-listen', target: ev, resolved: true, pos })
        }
      } else if (registry === 'webServer' && (method === 'register' || method === 'registerUpgrade')) {
        // A route is identified by `path`, not `name`, and the registry throws
        // on a duplicate exactly like the tool registry does.
        const path = objectProp(a0, 'path')
        record({ plane: 'host', verb: method === 'register' ? 'route-register' : 'route-upgrade',
          target: path ?? null, routeKind: objectProp(a0, 'kind') ?? null,
          resolved: path !== undefined, pos })
      } else if (method === 'register' && registry !== undefined && idx.serviceKeys.has(registry)) {
        record({ plane: 'host', verb: `${registry}-register`,
          target: objectProp(a0, 'name') ?? literal(a0) ?? null, resolved: true, pos })
      } else if (method === 'provide' || method === 'set') {
        const key = literal(a0)
        if (key !== undefined && idx.serviceKeys.has(key)) {
          record({ plane: 'host', verb: 'service-provide', target: key, resolved: true, pos })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

/** Object-valued config key names; a group's array config and scalars have none. */
const keysOf = c => (c !== null && typeof c === 'object' && !Array.isArray(c) ? Object.keys(c) : [])

/**
 * Mirror of `vendor/include/src/index.ts:applyEntryPatches`, journalling the
 * action each patch applies — the insert/override/disable classification the
 * shipped algorithm performs and then discards.
 */
export function applyEntryPatches(data, patches, layerLabel, journal) {
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
      // A patch replaces the whole `config`, so any baseline key it does not
      // restate is silently dropped — the highest-value conflict signal.
      droppedConfigKeys: afterKeys.length > 0 ? beforeKeys.filter(k => !afterKeys.includes(k)) : [],
    })
  }
  return data
}

/** Root manifest plus any manifest a workspace-less plugin nests one level down. */
function findManifests(root) {
  const found = []
  if (existsSync(join(root, 'package.json'))) found.push(join(root, 'package.json'))
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

/**
 * Analyze one checked-out repo.
 * @param dir - the checkout root.
 * @param fullName - `owner/name`, carried through to the result.
 * @param idx - the {@link indexBaseline} tables.
 * @returns one plugin record: manifest facts, patch journal, mapped contributions, summary.
 */
export function analyzeRepo(dir, fullName, idx) {
  const manifests = findManifests(dir).map(p => ({ path: p, json: readJson(p) })).filter(m => m.json !== null)
  const dshManifest = manifests.find(m => m.json.dsh !== undefined)
  const pkg = dshManifest?.json ?? manifests[0]?.json ?? null

  const patchJournal = []
  const patchFiles = []
  const candidates = new Set()
  const declaredPatch = pkg?.dsh?.bundle?.patch
  if (declaredPatch && dshManifest) candidates.add(join(dirname(dshManifest.path), declaredPatch))
  candidates.add(join(dir, 'cordis.patch.yml'))
  candidates.add(join(dir, 'cordis.yml'))
  for (const p of candidates) {
    if (!existsSync(p)) continue
    const rel = relative(dir, p).split('\\').join('/')
    let parsed
    try { parsed = yaml.load(readFileSync(p, 'utf8'), { schema: ENTRY_SCHEMA }) } catch (e) {
      patchJournal.push({ layer: rel, action: 'patch-parse-error', error: String(e).slice(0, 160) })
      continue
    }
    patchFiles.push(rel)
    applyEntryPatches(idx.rawWebRows, Array.isArray(parsed) ? parsed : [], rel, patchJournal)
  }

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
    scanned += 1
    if (!/\.(register|inject|on|once|provide|set)\s*\(/.test(text)) continue
    try { hits.push(...scanSource(f, text, dir, idx)) } catch (e) {
      skipped += 1
      scanErrors.push(`${relative(dir, f)}: ${String(e).slice(0, 160)}`)
    }
  }

  const contributions = hits.map((h) => {
    if (h.verb === 'slot-register') {
      const slot = h.target !== null ? idx.slotByKey.get(h.target) : undefined
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
      const collides = h.target !== null && idx.toolNames.has(h.target)
      return { ...h, known: collides, action: collides ? 'collision' : 'add' }
    }
    if (h.verb === 'event-listen') return { ...h, known: idx.eventNames.has(h.target ?? ''), action: 'observe' }
    if (h.verb === 'slot-inject') return { ...h, known: idx.slotByKey.has(h.target ?? ''), action: 'depends' }
    return { ...h, known: null, action: 'add' }
  })

  const contrib = v => contributions.filter(c => c.verb === v)
  return {
    repo: fullName,
    pkgName: pkg?.name ?? null,
    version: pkg?.version ?? null,
    hasDshField: pkg?.dsh !== undefined,
    dsh: pkg?.dsh ?? null,
    peerDeps: Object.keys(pkg?.peerDependencies ?? {}).filter(d => d.startsWith('@deepseek-ai/')),
    patchFiles,
    patchJournal,
    filesScanned: scanned,
    filesSkipped: skipped,
    scanErrors,
    contributions,
    summary: {
      configInserts: patchJournal.filter(j => j.action === 'insert').length,
      configOverrides: patchJournal.filter(j => j.action === 'override').length,
      configDisables: patchJournal.filter(j => j.action === 'disable').length,
      configOrphans: patchJournal.filter(j => j.action.startsWith('orphan')).length,
      droppedKeyPatches: patchJournal.filter(j => (j.droppedConfigKeys?.length ?? 0) > 0).length,
      slotOverrides: contrib('slot-register').filter(c => c.action === 'override').length,
      slotAdds: contrib('slot-register').filter(c => c.action === 'add').length,
      slotUnknown: contrib('slot-register').filter(c => c.action === 'unknown-target').length,
      toolAdds: contrib('tool-register').length,
      toolCollisions: contrib('tool-register').filter(c => c.action === 'collision').length,
      events: contrib('event-listen').length,
    },
  }
}
