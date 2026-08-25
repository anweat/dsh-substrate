/**
 * Measure how GitHub responds to parallel clones from this host, so the batch
 * runner's concurrency is chosen from evidence rather than guessed. Clones a
 * fixed sample of previously-failed repos at several concurrency levels and
 * reports the success rate and the actual git error text at each.
 */
import { readFileSync, rmSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const WORK = join(here, 'data/probe')
const SAMPLE = 24

const failed = readFileSync(join(here, 'out/records.jsonl'), 'utf8')
  .split(/\r?\n/).filter(l => l.trim() !== '')
  .flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  .filter(r => r.status === 'clone-failed')
  .map(r => r.repo)

const purge = d => { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }) } catch { /* recreated next attempt */ } }

function clone(repo, dir) {
  return new Promise((resolve) => {
    const child = spawn('git', [
      'clone', '--depth', '1', '--single-branch', '--no-tags',
      '--filter=blob:limit=300k', '--quiet', `https://github.com/${repo}.git`, dir,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => { err += d.toString() })
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000)
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, err: err.trim() }) })
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, err: String(e) }) })
  })
}

for (const concurrency of [4, 8, 14]) {
  const sample = failed.slice(0, SAMPLE)
  mkdirSync(WORK, { recursive: true })
  let cursor = 0
  let ok = 0
  const errors = []
  const started = Date.now()
  const worker = async (id) => {
    while (cursor < sample.length) {
      const repo = sample[cursor]
      cursor += 1
      const dir = join(WORK, `p${id}`)
      purge(dir)
      const r = await clone(repo, dir)
      if (r.ok) ok += 1
      else if (errors.length < 3) errors.push(`${repo}: ${r.err.split('\n')[0]}`)
      purge(dir)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)))
  const secs = ((Date.now() - started) / 1000).toFixed(0)
  console.log(`concurrency ${String(concurrency).padStart(2)}: ${ok}/${sample.length} ok  (${secs}s)`)
  for (const e of errors) console.log(`    ${e}`)
}
purge(WORK)
