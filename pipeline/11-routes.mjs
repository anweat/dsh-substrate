/**
 * Measure the HTTP-route blind spot.
 *
 * The first ecosystem pass recorded `webServer.register` call sites but not the
 * route they claim: the argument is an object keyed by `path`, not `name`, so
 * the extractor stored null. The registry throws on a duplicate path with no
 * scope layering of any kind, so a path collision is as fatal as a tool-name
 * one — and it has never been counted.
 *
 * Re-cloning the whole corpus to fix this would cost an hour, so this samples
 * the repos already known to register routes and reports the collision rate
 * with its sample size stated, rather than extrapolating silently.
 *
 * Usage: node 11-routes.mjs [--sample N] [--concurrency N]
 */
import { readFileSync, writeFileSync, existsSync, statfsSync, rmSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeRepo, indexBaseline } from './analyze.mjs'
import { normalizeRecord } from './normalize.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? fallback : Number(process.argv[i + 1])
}
const SAMPLE = arg('--sample', 700)
const CONCURRENCY = arg('--concurrency', 10)
const FLOOR = 50 * 1024 ** 3
const WORK = 'C:/dshw-routes'
mkdirSync(WORK, { recursive: true })

const baseline = JSON.parse(readFileSync(join(here, 'data/baseline.json'), 'utf8'))
const idx = indexBaseline(baseline)
const repos = new Map(JSON.parse(readFileSync(join(here, 'data/repos.json'), 'utf8')).map(r => [r.full_name, r]))

/** Repos the first pass proved register at least one route. */
const candidates = readFileSync(join(here, 'out/records.jsonl'), 'utf8')
  .split(/\r?\n/).filter(l => l.trim() !== '')
  .flatMap((l) => { try { return [normalizeRecord(JSON.parse(l))] } catch { return [] } })
  .filter(r => r.status === 'ok' && (r.contributions ?? []).some(c => c.verb === 'webServer-register'))
  .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))

process.stderr.write(`repos known to register routes: ${candidates.length}; sampling ${Math.min(SAMPLE, candidates.length)}\n`)
const targets = candidates.slice(0, SAMPLE).map(r => repos.get(r.repo)).filter(Boolean)

const purge = d => { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }) } catch { /* recreated next attempt */ } }
const sleep = ms => new Promise(r => setTimeout(r, ms))

function cloneOnce(repo, dir) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.longpaths=true', 'clone', '--depth', '1', '--single-branch',
      '--no-tags', '--filter=blob:limit=300k', '--quiet', repo.clone_url, dir], { stdio: 'ignore' })
    const t = setTimeout(() => child.kill('SIGKILL'), 90000)
    child.on('close', c => { clearTimeout(t); resolve(c === 0) })
    child.on('error', () => { clearTimeout(t); resolve(false) })
  })
}
async function clone(repo, dir) {
  for (let i = 0; i < 3; i += 1) {
    if (i > 0) { purge(dir); await sleep(1200 * 2 ** (i - 1)) }
    if (await cloneOnce(repo, dir)) return true
  }
  return false
}

const out = []
let cursor = 0, done = 0, failed = 0, stopping = false

async function worker(id) {
  while (cursor < targets.length && !stopping) {
    const repo = targets[cursor]; cursor += 1
    if (statfsSync(here).bavail * statfsSync(here).bsize < FLOOR) { stopping = true; break }
    const dir = join(WORK, `w${id}`)
    purge(dir)
    if (await clone(repo, dir)) {
      try {
        const r = analyzeRepo(dir, repo.full_name, idx)
        const routes = (r.contributions ?? []).filter(c => c.verb === 'route-register' || c.verb === 'route-upgrade')
        out.push({ repo: repo.full_name, pkg: r.pkgName ?? repo.full_name, routes: routes.map(c => ({ path: c.target, kind: c.routeKind, verb: c.verb, at: c.source })) })
      } catch { failed += 1 }
    } else failed += 1
    purge(dir)
    done += 1
    if (done % 50 === 0) process.stderr.write(`  ${done}/${targets.length} | 失败 ${failed}\n`)
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)))
for (let i = 0; i < CONCURRENCY; i += 1) purge(join(WORK, `w${i}`))
writeFileSync(join(here, 'out/routes.json'), JSON.stringify(out, null, 1))

// --- report ---------------------------------------------------------------
const byPath = new Map()
let literal = 0, unresolved = 0
for (const rec of out) {
  for (const r of rec.routes) {
    if (r.path === null) { unresolved += 1; continue }
    literal += 1
    const key = `${r.kind ?? '?'} ${r.path}`
    if (!byPath.has(key)) byPath.set(key, new Set())
    byPath.get(key).add(rec.pkg)
  }
}
const contended = [...byPath.entries()].filter(([, s]) => s.size > 1).sort((a, b) => b[1].size - a[1].size)

console.log(`\n=== HTTP 路由冲突(样本 ${out.length} 个仓库,失败 ${failed})===`)
console.log(`  路由注册点: 字面量 ${literal} | 非字面量(静态不可判定) ${unresolved}`)
console.log(`  不同路径: ${byPath.size} | 被 2 个以上包争用: ${contended.length} (${(contended.length / Math.max(1, byPath.size) * 100).toFixed(1)}%)`)
console.log('\n=== 最挤的路径 ===')
for (const [path, pkgs] of contended.slice(0, 20)) {
  console.log(`  ${String(pkgs.size).padStart(4)}  ${path}`)
}
console.log(`\n报告 -> out/routes.json`)
