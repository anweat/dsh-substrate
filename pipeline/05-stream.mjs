/**
 * Streaming ecosystem analysis: clone one repo, extract its contributions,
 * delete the checkout, keep only the record. Peak disk stays at roughly
 * (concurrency x one repo) instead of the whole corpus, so the full 12k-repo
 * universe costs no more storage than a handful of them.
 *
 * A free-space floor is checked before every clone and the run stops cleanly
 * when it would be crossed. Results append to a JSONL as they are produced, so
 * an interrupted run resumes rather than restarting.
 *
 * Usage: node 05-stream.mjs [--limit N] [--concurrency N] [--floor-gb N] [--max-size-kb N]
 */
import { readFileSync, appendFileSync, existsSync, statfsSync, rmSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeRepo, indexBaseline } from './analyze.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, 'out/records.jsonl')
// Windows resolves paths against MAX_PATH (260 chars) unless a repo opts out,
// and the scratchpad root alone is ~141 chars — too little headroom for many
// repos. The checkout goes to a short root; only the records stay under `here`.
const workArg = process.argv.indexOf('--work-dir')
const WORK = workArg === -1 ? 'C:/dshw' : process.argv[workArg + 1]
mkdirSync(join(here, 'out'), { recursive: true })
mkdirSync(WORK, { recursive: true })

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? fallback : Number(process.argv[i + 1])
}
const LIMIT = arg('--limit', Infinity)
const CONCURRENCY = arg('--concurrency', 10)
const FLOOR_BYTES = arg('--floor-gb', 50) * 1024 ** 3
const MAX_SIZE_KB = arg('--max-size-kb', 60000)
const CLONE_TIMEOUT_MS = 90000
const CLONE_RETRIES = arg('--retries', 3)
const RETRY_BASE_MS = arg('--retry-base-ms', 1500)

const baseline = JSON.parse(readFileSync(join(here, 'data/baseline.json'), 'utf8'))
const idx = indexBaseline(baseline)
const all = JSON.parse(readFileSync(join(here, 'data/repos.json'), 'utf8'))

/** Repos already recorded, so an interrupted run resumes where it stopped. */
const done = new Set()
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try { done.add(JSON.parse(line).repo) } catch { /* a torn final line is re-analyzed */ }
  }
}

const targets = all
  .filter(r => !r.archived && r.size_kb <= MAX_SIZE_KB && !done.has(r.full_name))
  .slice(0, LIMIT)

const freeBytes = () => {
  const s = statfsSync(here)
  return s.bavail * s.bsize
}

let stopping = false
const stats = { ok: 0, empty: 0, failed: 0, skipped: 0 }

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** One clone attempt; keeps git's stderr so a failure can be diagnosed rather than guessed at. */
function cloneOnce(repo, dir) {
  return new Promise((resolve) => {
    const child = spawn('git', [
      // Long paths must be enabled per invocation: the deep names some plugin
      // repos ship (template asset trees) exceed MAX_PATH even from a short root,
      // and git reports them as a checkout error rather than a clone failure.
      '-c', 'core.longpaths=true',
      'clone', '--depth', '1', '--single-branch', '--no-tags',
      '--filter=blob:limit=300k', '--quiet', repo.clone_url, dir,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => { if (err.length < 500) err += d.toString() })
    const timer = setTimeout(() => child.kill('SIGKILL'), CLONE_TIMEOUT_MS)
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, err: err.trim().slice(0, 300) }) })
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, err: String(e).slice(0, 300) }) })
  })
}

/**
 * Clone with backoff. GitHub throttles parallel clones from one host rather
 * than refusing them outright, so a first failure is usually transient and a
 * retry after a pause succeeds — treating it as a dead repo would silently
 * discard most of the corpus.
 */
async function clone(repo, dir) {
  let last = { ok: false, err: 'not attempted' }
  for (let attempt = 0; attempt < CLONE_RETRIES; attempt += 1) {
    if (attempt > 0) {
      purge(dir)
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1) + Math.random() * 400)
    }
    last = await cloneOnce(repo, dir)
    if (last.ok) return last
  }
  return last
}

const purge = (dir) => {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }) } catch { /* next run's clone re-creates it */ }
}

/** Whether a record carries any DSH-specific signal worth keeping in full. */
const isReal = rec => rec.hasDshField || rec.patchFiles.length > 0 || rec.contributions.length > 0

let cursor = 0
let processed = 0

async function worker(id) {
  while (cursor < targets.length && !stopping) {
    const repo = targets[cursor]
    cursor += 1
    const free = freeBytes()
    if (free < FLOOR_BYTES) {
      stopping = true
      process.stderr.write(`\n[guard] free space ${(free / 1024 ** 3).toFixed(1)}GB below floor ${(FLOOR_BYTES / 1024 ** 3).toFixed(0)}GB — stopping\n`)
      break
    }
    const dir = join(WORK, `w${id}`)
    purge(dir)
    let record
    const cloned = await clone(repo, dir)
    if (!cloned.ok) {
      record = { repo: repo.full_name, status: 'clone-failed', error: cloned.err }
      stats.failed += 1
    } else {
      try {
        const analyzed = analyzeRepo(dir, repo.full_name, idx)
        if (isReal(analyzed)) {
          record = { ...analyzed, status: 'ok', stars: repo.stars, created_at: repo.created_at }
          stats.ok += 1
        } else {
          // Keep only the verdict for a placeholder repo: it is a statistic,
          // not a plugin, and its full record would dominate the output.
          record = { repo: repo.full_name, status: 'no-dsh-signal', stars: repo.stars, created_at: repo.created_at }
          stats.empty += 1
        }
      } catch (e) {
        record = { repo: repo.full_name, status: 'analyze-failed', error: String(e).slice(0, 200) }
        stats.failed += 1
      }
    }
    purge(dir)
    appendFileSync(OUT, `${JSON.stringify(record)}\n`)
    processed += 1
    if (processed % 50 === 0) {
      process.stderr.write(`  ${processed}/${targets.length} | real ${stats.ok} | 空壳 ${stats.empty} | 失败 ${stats.failed} | 剩余磁盘 ${(freeBytes() / 1024 ** 3).toFixed(0)}GB\n`)
    }
  }
}

process.stderr.write(`streaming ${targets.length} repos (${done.size} already recorded), concurrency ${CONCURRENCY}, floor ${(FLOOR_BYTES / 1024 ** 3).toFixed(0)}GB\n`)
process.stderr.write(`free now: ${(freeBytes() / 1024 ** 3).toFixed(1)}GB\n`)
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)))
for (let i = 0; i < CONCURRENCY; i += 1) purge(join(WORK, `w${i}`))
process.stderr.write(`\ndone: real ${stats.ok} | 空壳 ${stats.empty} | 失败 ${stats.failed} -> out/records.jsonl\n`)
process.stderr.write(`free after: ${(freeBytes() / 1024 ** 3).toFixed(1)}GB\n`)
