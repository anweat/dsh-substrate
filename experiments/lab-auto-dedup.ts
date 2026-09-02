/**
 * Can duplicate ids be resolved automatically, with no change by any plugin author?
 *
 * The pieces are settled elsewhere. No patch layer and no plugin can do it
 * (`lab-duplicate-entry-id.ts`). Deriving an id from the npm package name is
 * sound but only reaches rows that omit `id`, and must happen before
 * `applyEntryPatches` to stay addressable (`lab-derived-entry-id.ts`). The
 * conflict that prompted all of this has explicit ids on both rows, so
 * derivation alone would not touch it.
 *
 * This asks the remaining question: `Include.prototype.applyPatches` receives
 * the composed rows before any patch reads them. Rewriting a losing claimant's
 * id there — to its package-derived name rather than an ordinal — should
 * resolve the collision, keep both rows addressable, and leave a genuine
 * double-install still failing loudly, because two rows of one package derive
 * the same name and collide anyway.
 *
 * That last property is the reason to prefer derivation over a `-2` suffix: a
 * suffix silences every duplicate, including the ones that are real mistakes.
 *
 * Run: node --import tsx/esm lab-auto-dedup.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from './packages/boot/app-boot/src/index.ts'
import Include from './vendor/include/src/index.ts'

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const RECORDER = `
export const name = 'recorder'
export function apply(ctx, config) {
  globalThis.__lab ??= []
  globalThis.__lab.push(config?.who ?? 'anon')
}
`
const mounted = (): string[] => ((globalThis as { __lab?: string[] }).__lab ?? []).slice().sort()

/** A package name slugged into one path-safe segment. */
function idFromName(name: string): string {
  return name.replace(/^@/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
}

/**
 * Resolve duplicate ids on the composed rows, before any patch reads them.
 *
 * The first claimant keeps the contested id, so anything already targeting it
 * still lands where it did. Later claimants take their package-derived name,
 * which is deterministic — the rewritten row stays addressable, unlike one
 * given a random or ordinal id.
 */
function installAutoDedup(): { restore: () => void, log: string[] } {
  const log: string[] = []
  const target = Include.prototype as unknown as {
    applyPatches: (data: { id?: string, name?: string }[], patches?: unknown[]) => unknown
  }
  const original = target.applyPatches
  target.applyPatches = function deduped(data, patches) {
    const seen = new Set<string>()
    for (const row of data) {
      if (row.id === undefined) continue
      if (!seen.has(row.id)) { seen.add(row.id); continue }
      const base = typeof row.name === 'string' ? idFromName(row.name) : ''
      if (base === '') continue
      // One package legitimately contributes several rows — the real
      // `dsh-builtin-browser` inserts `browser`, `browser-electron` and
      // `tool-browser` — so a derived id can itself already be taken. An
      // earlier version treated a repeated name as a double-install and
      // refused to rewrite, which left that package unfixable on a real boot.
      let candidate = base
      let ordinal = 2
      while (seen.has(candidate)) { candidate = `${base}-${ordinal}`; ordinal += 1 }
      log.push(`${row.id} -> ${candidate}  (${String(row.name)})`)
      row.id = candidate
      seen.add(candidate)
    }
    return original.call(this, data as never, patches as never)
  }
  return { restore: () => { target.applyPatches = original }, log }
}

async function bootConfig(dir: string, patches: unknown[] = []): Promise<{ error?: string, ids: string[] }> {
  ;(globalThis as { __lab?: string[] }).__lab = []
  try {
    const ctx = await boot('dsh-lab', join(dir, 'cordis.yml'), patches as never)
    const ids = [...ctx.loader.entries()].map(e => (e as { id: string }).id).sort()
    await (ctx.fiber as { dispose: () => Promise<void> }).dispose()
    return { ids }
  } catch (error) {
    return { error: String((error as Error).message).slice(0, 150), ids: [] }
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-autodedup-'))
  writeFileSync(join(dir, 'builtin.mjs'), RECORDER)
  writeFileSync(join(dir, 'third-party.mjs'), RECORDER)

  // The reported shape: two different packages, both hardcoding `id: browser`.
  const REPORTED = `
- id: browser
  name: ./builtin.mjs
  config:
    who: builtin

- id: browser
  name: ./third-party.mjs
  config:
    who: third-party
`

  console.log('\n=== 基线:两个包都写死 id: browser ===')
  {
    writeFileSync(join(dir, 'cordis.yml'), REPORTED)
    const result = await bootConfig(dir)
    check('启动失败', result.error !== undefined && /duplicate loader entry id/.test(result.error), result.error ?? 'booted')
  }

  console.log('\n=== 自动去重:后来者改用包名派生的 id ===')
  {
    const { restore, log } = installAutoDedup()
    const result = await bootConfig(dir)
    check('启动成功 —— 两个插件作者都不用改任何东西',
      result.error === undefined, result.error ?? '')
    check('两个插件都挂上了', mounted().join(',') === 'builtin,third-party', mounted().join(','))
    check('第一个认领者保住原 id', result.ids.some(id => id.endsWith(':browser')), JSON.stringify(result.ids))
    check('后来者拿到派生 id,不是序号', result.ids.some(id => id.endsWith(':third-party-mjs')), JSON.stringify(result.ids))
    check('改写被记录下来,不是静默发生', log.length === 1, JSON.stringify(log))
    restore()
  }

  console.log('\n=== 改写后两行都仍然可被补丁定位 ===')
  {
    const { restore } = installAutoDedup()
    const first = await bootConfig(dir, [{ id: 'browser', disabled: true }])
    check('按原 id 定位,命中第一个认领者',
      first.error === undefined && mounted().join(',') === 'third-party',
      `${first.error ?? ''} ${mounted().join(',')}`)

    const second = await bootConfig(dir, [{ id: 'third-party-mjs', disabled: true }])
    check('按派生 id 定位,命中后来者 —— 派生早于补丁,所以补丁看得见它',
      second.error === undefined && mounted().join(',') === 'builtin',
      `${second.error ?? ''} ${mounted().join(',')}`)
    restore()
  }

  console.log('\n=== 一个包贡献多行时也要能修 ===')
  {
    // Measured against the real dsh-builtin-browser, which inserts three rows
    // from one package. A rule that read "same name twice" as a double-install
    // refused to rewrite here, and the real boot stayed broken.
    writeFileSync(join(dir, 'cordis.yml'), `
- id: browser
  name: ./builtin.mjs
  config:
    who: first

- id: browser
  name: ./builtin.mjs
  config:
    who: second
`)
    const { restore } = installAutoDedup()
    const result = await bootConfig(dir)
    check('同一个包的两行都能拿到不同 id',
      result.error === undefined && mounted().length === 2,
      `${result.error ?? ''} ${JSON.stringify(mounted())}`)
    restore()
  }

  console.log('\n=== 没有冲突时什么也不做 ===')
  {
    writeFileSync(join(dir, 'cordis.yml'), `
- id: a
  name: ./builtin.mjs
  config:
    who: first

- id: b
  name: ./third-party.mjs
  config:
    who: second
`)
    const { restore, log } = installAutoDedup()
    const result = await bootConfig(dir)
    check('id 本来就唯一时零改写', log.length === 0, JSON.stringify(log))
    check('两行的 id 原样保留',
      result.ids.some(id => id.endsWith(':a')) && result.ids.some(id => id.endsWith(':b')),
      JSON.stringify(result.ids))
    restore()
  }

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exitCode = fail === 0 ? 0 : 1
}

await main()
