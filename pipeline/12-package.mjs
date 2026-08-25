/**
 * Assemble the public evidence package.
 *
 * What ships: the method, the aggregated findings, the scanner that produced
 * them, and the mechanism experiments anyone can re-run. What does not ship:
 * the per-repo raw extraction (`records.jsonl`, 24 MB of file/line detail
 * harvested from other people's repositories) — the aggregate is the claim,
 * and the pipeline reproduces the rest from public sources.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const LAB = process.env.DSH_ROOT ?? ''
const OUT = process.argv[2] ?? process.env.DSH_EVIDENCE ?? ''

for (const d of ['data', 'pipeline', 'experiments']) mkdirSync(join(OUT, d), { recursive: true })

const report = JSON.parse(readFileSync(join(here, 'out/report.json'), 'utf8'))
const chain = JSON.parse(readFileSync(join(here, 'out/chain-stats.json'), 'utf8'))
const routes = JSON.parse(readFileSync(join(here, 'out/routes.json'), 'utf8'))

// --- summary.json: the headline numbers, nothing derived beyond counting ----
const bySeverity = {}
const byKind = {}
for (const c of report.conflicts) {
  bySeverity[c.severity] = (bySeverity[c.severity] ?? 0) + 1
  byKind[c.kind] = (byKind[c.kind] ?? 0) + 1
}
writeFileSync(join(OUT, 'data/summary.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  coverage: report.totals,
  conflicts: { total: report.conflicts.length, bySeverity, byKind },
  branchingFactors: chain.hops,
  contributionMix: Object.fromEntries(chain.verbMix ?? []),
}, null, 2))

// --- conflicts.json: one row per conflict group, parties named -------------
writeFileSync(join(OUT, 'data/conflicts.json'), JSON.stringify(
  report.conflicts.map(c => ({
    severity: c.severity, kind: c.kind, target: c.target,
    detail: c.detail, partyCount: c.parties.length, parties: c.parties,
  })), null, 1))

// --- occupancy / namespaces ------------------------------------------------
writeFileSync(join(OUT, 'data/surfaces.json'), JSON.stringify({
  slotOccupancy: report.occupancy.filter(o => o.thirdParty > 0),
  toolNamespace: report.toolNamespace.filter(t => t.plugins.length > 1),
  eventUse: report.eventUse,
  configTargets: report.configTargets.filter(t => t.plugins.length > 1),
  unknownSlotTargets: report.unknownSlotTargets,
}, null, 1))

// --- routes: paths and claimants, no handler detail ------------------------
const byPath = new Map()
for (const rec of routes) {
  for (const r of rec.routes) {
    if (r.path === null) continue
    const k = `${r.kind ?? '?'} ${r.path}`
    if (!byPath.has(k)) byPath.set(k, new Set())
    byPath.get(k).add(rec.pkg)
  }
}
writeFileSync(join(OUT, 'data/routes.json'), JSON.stringify({
  sampledRepos: routes.length,
  literalRegistrations: routes.reduce((a, r) => a + r.routes.filter(x => x.path !== null).length, 0),
  unresolvedRegistrations: routes.reduce((a, r) => a + r.routes.filter(x => x.path === null).length, 0),
  distinctPaths: byPath.size,
  contended: [...byPath.entries()].filter(([, s]) => s.size > 1)
    .sort((a, b) => b[1].size - a[1].size)
    .map(([path, s]) => ({ path, packages: [...s] })),
}, null, 1))

// --- the scanner and the experiments --------------------------------------
const PIPELINE = ['00-baseline.mjs', '01-harvest.mjs', '02-clone.mjs', '03-extract.mjs', '04-report.mjs',
  '05-stream.mjs', '06-chain.mjs', '07-export.mjs', '08-dsh-self.mjs', '10-patterns.mjs', '11-routes.mjs',
  'analyze.mjs', 'normalize.mjs', 'run-pipeline.sh']
for (const f of PIPELINE) if (existsSync(join(here, f))) copyFileSync(join(here, f), join(OUT, 'pipeline', f))

const LABS = ['lab-isolate-proxy.ts', 'lab-real-registry.ts', 'lab-loader-isolate.ts', 'lab-event-order.ts']
for (const f of LABS) if (existsSync(join(LAB, f))) copyFileSync(join(LAB, f), join(OUT, 'experiments', f))

const s = JSON.parse(readFileSync(join(OUT, 'data/summary.json'), 'utf8'))
console.log('packaged ->', OUT)
console.log('  conflicts', s.conflicts.total, JSON.stringify(s.conflicts.bySeverity))
console.log('  pipeline scripts', PIPELINE.length, '| experiments', LABS.length)
for (const f of ['data/summary.json', 'data/conflicts.json', 'data/surfaces.json', 'data/routes.json']) {
  console.log(`  ${f}  ${(readFileSync(join(OUT, f)).length / 1024).toFixed(0)} KB`)
}
