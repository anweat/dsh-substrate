/**
 * Shallow-clone harvested repos. Clones do not consume GitHub API quota, so
 * this is the scalable path; large blobs are filtered out because plugin
 * analysis only ever reads manifests, patch files, and JS.
 *
 * Usage: node 02-clone.mjs [--limit N] [--concurrency N] [--max-size-kb N]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPOS = join(here, 'data/repos.json')
const DEST = join(here, 'data/repos')
mkdirSync(DEST, { recursive: true })

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? fallback : Number(process.argv[i + 1])
}
const LIMIT = arg('--limit', Infinity)
const CONCURRENCY = arg('--concurrency', 12)
const MAX_SIZE_KB = arg('--max-size-kb', 80000)
const CLONE_TIMEOUT_MS = 120000

const all = JSON.parse(readFileSync(REPOS, 'utf8'))
const targets = all.filter(r => !r.archived && r.size_kb <= MAX_SIZE_KB).slice(0, LIMIT)
const slug = full => full.replace('/', '__')

/** One shallow clone; resolves to a status record, never rejects. */
function clone(repo) {
  const dir = join(DEST, slug(repo.full_name))
  if (existsSync(join(dir, '.git'))) return Promise.resolve({ repo: repo.full_name, status: 'cached' })
  return new Promise((resolve) => {
    const child = spawn('git', [
      'clone', '--depth', '1', '--single-branch', '--no-tags',
      '--filter=blob:limit=200k', '--quiet', repo.clone_url, dir,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => { err += d.toString().slice(0, 400) })
    const timer = setTimeout(() => child.kill('SIGKILL'), CLONE_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0
        ? { repo: repo.full_name, status: 'ok' }
        : { repo: repo.full_name, status: 'failed', error: err.trim().slice(0, 200) })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ repo: repo.full_name, status: 'failed', error: String(e) })
    })
  })
}

const results = []
let cursor = 0
let done = 0
async function worker() {
  while (cursor < targets.length) {
    const repo = targets[cursor]
    cursor += 1
    const r = await clone(repo)
    results.push(r)
    done += 1
    if (done % 25 === 0 || done === targets.length) {
      const ok = results.filter(x => x.status !== 'failed').length
      process.stderr.write(`  ${done}/${targets.length} cloned (${ok} ok)\n`)
    }
  }
}

process.stderr.write(`cloning ${targets.length} of ${all.length} repos, concurrency ${CONCURRENCY}\n`)
await Promise.all(Array.from({ length: CONCURRENCY }, worker))
writeFileSync(join(here, 'data/clone-status.json'), JSON.stringify(results, null, 2))
const failed = results.filter(r => r.status === 'failed')
process.stderr.write(`done: ${results.length - failed.length} ok, ${failed.length} failed -> data/clone-status.json\n`)
