// Boot one composed config and report what happened, unwrapping the loader's
// aggregate so the reason is visible rather than just the fact of failure.
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { DSH_ROOT, require_ } from '../paths.mjs'
const requireRoot = () => require_(DSH_ROOT, 'DSH_ROOT', 'boot a harness checkout')
const { boot } = await import(pathToFileURL(join(requireRoot(), 'packages/boot/app-boot/src/index.ts')).href)

const leaves = (error, out = []) => {
  if (error === undefined || error === null) return out
  if (Array.isArray(error.errors)) { for (const e of error.errors) leaves(e, out); return out }
  if (error.cause !== undefined) return leaves(error.cause, out)
  out.push(String(error.message ?? error))
  return out
}

const t = Date.now()
try {
  const ctx = await boot('dsh-e2e', process.argv[2])
  const tools = ctx.get('tools')
  const names = typeof tools?.schemas === 'function' ? tools.schemas().map(x => x.name) : []
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)

  // Prove the scoped registrations landed rather than being swallowed: read
  // each minted scope's merged view and count what only it can see.
  const ledger = ctx.root[Symbol.for('dsh-substrate: tools scopes')]
  let scopes = 0, scopedOnly = 0, shadowed = 0
  const globalSet = new Set(names)
  for (const [, { key }] of ledger ?? []) {
    scopes += 1
    const seen = tools.schemas(key).map(x => x.name)
    for (const n of seen) if (!globalSet.has(n)) scopedOnly += 1
    for (const n of seen) if (globalSet.has(n)) shadowed += 1
  }
  console.log(JSON.stringify({
    ok: true, ms: Date.now() - t,
    entries: [...ctx.loader.entries()].length,
    globalTools: names.length,
    duplicateNames: dupes.length,
    scopes, scopedOnly, shadowed,
    sample: names.slice(0, 6),
  }, null, 1))
  await ctx.fiber.dispose()
} catch (e) {
  const all = leaves(e)
  const tally = new Map()
  for (const m of all) {
    const key = /already registered|duplicate|reserved/i.test(m) ? m.replace(/"[^"]*"/g, '"…"') : 'other'
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  console.log(JSON.stringify({
    ok: false, ms: Date.now() - t, failures: all.length,
    kinds: Object.fromEntries([...tally].sort((a, b) => b[1] - a[1]).slice(0, 4)),
    sample: all.slice(0, 3),
  }, null, 1))
}
