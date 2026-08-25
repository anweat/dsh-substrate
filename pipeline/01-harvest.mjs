/**
 * Harvest the DSH plugin repo universe from GitHub search.
 * Search caps at 1000 results per query, so each query is recursively split by
 * `created:` date range until every slice fits under the cap.
 */
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
const API = 'https://api.github.com'
const OUT = new URL('./data/repos.json', import.meta.url)

const QUERIES = [
  'topic:dsh-plugin',
  'topic:deepseek-harness',
  'topic:dsh-plugins',
  'dsh-plugin in:name',
  'deepseek-harness in:name',
]

const sleep = ms => new Promise(r => setTimeout(r, ms))
let calls = 0

async function search(q, page = 1) {
  const url = `${API}/search/repositories?q=${encodeURIComponent(q)}&per_page=100&page=${page}&sort=updated`
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json' },
    })
    calls += 1
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000
      const wait = Math.max(2000, reset - Date.now() + 1500)
      process.stderr.write(`  rate-limited, waiting ${Math.round(wait / 1000)}s\n`)
      await sleep(wait)
      continue
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
    await sleep(2100) // 30 search req/min
    return res.json()
  }
  throw new Error('rate limit retries exhausted')
}

/** ISO date (YYYY-MM-DD) arithmetic on UTC days. */
const day = d => d.toISOString().slice(0, 10)
const addDays = (iso, n) => day(new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000))

const found = new Map()

function keep(items) {
  for (const r of items) {
    if (!found.has(r.full_name)) {
      found.set(r.full_name, {
        full_name: r.full_name,
        html_url: r.html_url,
        clone_url: r.clone_url,
        description: r.description,
        stars: r.stargazers_count,
        forks: r.forks_count,
        size_kb: r.size,
        created_at: r.created_at,
        pushed_at: r.pushed_at,
        topics: r.topics ?? [],
        is_fork: r.fork,
        archived: r.archived,
        default_branch: r.default_branch,
      })
    }
  }
}

/** Drain one query slice, splitting the date range when it exceeds the 1000 cap. */
async function drain(base, from, to, depth = 0) {
  const q = `${base} created:${from}..${to}`
  const first = await search(q, 1)
  const total = first.total_count
  const pad = '  '.repeat(depth)
  if (total > 1000 && from !== to) {
    const mid = addDays(from, Math.floor((Date.parse(to) - Date.parse(from)) / 86400000 / 2))
    process.stderr.write(`${pad}split ${from}..${to} (${total})\n`)
    await drain(base, from, mid, depth + 1)
    await drain(base, addDays(mid, 1), to, depth + 1)
    return
  }
  process.stderr.write(`${pad}${from}..${to} -> ${total}\n`)
  keep(first.items)
  const pages = Math.min(10, Math.ceil(total / 100))
  for (let p = 2; p <= pages; p += 1) keep((await search(q, p)).items)
}

const TODAY = day(new Date())
for (const base of QUERIES) {
  process.stderr.write(`\n=== ${base} ===\n`)
  await drain(base, '2026-07-01', TODAY)
  process.stderr.write(`  running unique total: ${found.size}\n`)
}

const repos = [...found.values()].sort((a, b) => b.stars - a.stars)
writeFileSync(OUT, JSON.stringify(repos, null, 2))
process.stderr.write(`\nharvested ${repos.length} unique repos in ${calls} API calls -> data/repos.json\n`)
