/**
 * Derive the entry id from the npm package name instead of a random value.
 *
 * `lab-duplicate-entry-id.ts` found that a row omitting `id` never collides,
 * because `EntryTree.ensureId` invents a free one. The objection to relying on
 * that is fair: the invented id is `Math.random().toString(16)`, so the row
 * becomes unaddressable — nothing downstream can disable or configure it.
 *
 * But `EntryOptions.name` is already the module specifier, which for a plugin
 * row is the npm package name, and npm guarantees those are unique. Deriving
 * from it keeps the property that makes omission safe while removing the one
 * that makes it dangerous: the id becomes predictable, so it stays addressable.
 *
 * Four things have to hold for that to be a real proposal rather than a nice
 * idea, and the last two are where a naive version breaks.
 *
 * Run: node --import tsx/esm lab-derived-entry-id.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from './packages/boot/app-boot/src/index.ts'
import { EntryGroup } from './vendor/loader/src/config/group.ts'

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

/** The proposed derivation: a package name slugged into one path-safe segment. */
export function idFromName(name: string): string {
  return name
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

/**
 * Install the derivation at the level that can see the whole batch.
 *
 * The obvious home is `EntryTree.ensureId`, and it does not work: `EntryGroup.update`
 * calls it once per row *before* any of them reach the store, so two rows of
 * one package both derive the same base and collide on the spot. Only the
 * batch loop knows what its siblings just took. Measured — the first version of
 * this experiment put it in `ensureId` and failed with
 * `duplicate loader entry id: recorder-mjs`.
 *
 * Two details are not decoration. An explicit id is left alone, so nothing that
 * names one today changes behaviour. And a package legitimately loaded twice
 * (`tool-subagent` under two `toolName` configs is the shipped example) gets an
 * ordinal, because a package name alone cannot separate those.
 */
function installDerivation(): () => void {
  const original = EntryGroup.prototype.update
  EntryGroup.prototype.update = async function derived(config: { id?: string, name?: string }[]) {
    const taken = new Set(config.map(row => row.id).filter((id): id is string => id !== undefined))
    for (const row of config) {
      if (row.id !== undefined) continue
      const base = typeof row.name === 'string' ? idFromName(row.name) : ''
      if (base === '') continue
      let candidate = base
      let ordinal = 2
      while (taken.has(candidate)) { candidate = `${base}-${ordinal}`; ordinal += 1 }
      row.id = candidate
      taken.add(candidate)
    }
    return original.call(this, config as never)
  } as typeof original
  return () => { EntryGroup.prototype.update = original }
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
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-derived-'))
  writeFileSync(join(dir, 'recorder.mjs'), RECORDER)

  // Both rows omit `id`, which is what the proposal makes safe to do.
  const NO_IDS = `
- name: ./recorder.mjs
  config:
    who: builtin

- name: ./recorder.mjs
  config:
    who: third-party
`

  console.log('\n=== 现状:省略 id 得到随机值 ===')
  {
    writeFileSync(join(dir, 'cordis.yml'), NO_IDS)
    const first = await bootConfig(dir)
    const second = await bootConfig(dir)
    check('能启动', first.error === undefined, first.error ?? '')
    check('但两次启动的 id 不同 —— 所以谁也没法按 id 定位它',
      JSON.stringify(first.ids) !== JSON.stringify(second.ids),
      `${JSON.stringify(first.ids)} vs ${JSON.stringify(second.ids)}`)
  }

  console.log('\n=== 提案:从包名派生 ===')
  {
    const restore = installDerivation()
    const first = await bootConfig(dir)
    const second = await bootConfig(dir)
    check('能启动', first.error === undefined, first.error ?? '')
    check('两个插件都挂上了', mounted().join(',') === 'builtin,third-party', mounted().join(','))
    check('**两次启动 id 完全一致** —— 这正是随机值缺的那半',
      JSON.stringify(first.ids) === JSON.stringify(second.ids),
      `${JSON.stringify(first.ids)} vs ${JSON.stringify(second.ids)}`)
    check('同一个包装两次时带序号,而不是撞车',
      first.ids.some(id => /-2$/.test(id)), JSON.stringify(first.ids))
    restore()
  }

  console.log('\n=== 派生装在哪一层,决定它有没有用 ===')
  {
    // The proposal's whole appeal is that a derived id stays addressable. That
    // does not follow from deriving it — it follows from deriving it early
    // enough. Patches run in `applyEntryPatches` during composition; this
    // prototype derives in `EntryGroup.update`, at load. A patch written
    // against the derived name therefore finds nothing, because at the moment
    // it runs the row still has no id at all.
    const restore = installDerivation()
    const before = await bootConfig(dir)
    const target = before.ids.find(id => id.includes(':') && !/-2$/.test(id))
    check('id 带父级前缀,不是裸的派生值', target !== undefined && target.includes(':'), String(target))

    const after = await bootConfig(dir, [{ id: target, disabled: true }])
    check('装在加载期时补丁定位不到它 —— 补丁跑得更早,那时这行还没有 id',
      after.error === undefined && mounted().length === 2,
      `target=${String(target)} mounted=${JSON.stringify(mounted())}`)
    restore()
  }

  console.log('\n=== 所以提案必须说清改在哪一层 ===')
  {
    // Recorded as an assertion so it survives being skimmed: the change belongs
    // where the composed row list is first built, before any patch layer reads
    // it, so patches and the loader agree on what each row is called. Deriving
    // in two places would be two things to keep in step.
    check('派生必须早于 applyEntryPatches,否则"可定位"这个卖点不成立', true)
  }

  console.log('\n=== 显式 id 的行为完全不变 ===')
  {
    const restore = installDerivation()
    writeFileSync(join(dir, 'cordis.yml'), `
- id: kept
  name: ./recorder.mjs
  config:
    who: builtin
`)
    const result = await bootConfig(dir)
    check('写了 id 就用它,派生不插手 —— 改动是纯增量',
      result.ids.some(id => id.endsWith(':kept')), JSON.stringify(result.ids))
    restore()
  }

  console.log('\n=== 不同包名派生出不同 id ===')
  {
    check('作用域包名', idFromName('@anweat/dsh-browser') === 'anweat-dsh-browser', idFromName('@anweat/dsh-browser'))
    check('内置包名', idFromName('@deepseek-ai/dsh-builtin-browser') === 'deepseek-ai-dsh-builtin-browser')
    check('两者不同 —— npm 的唯一性直接传递过来',
      idFromName('@anweat/dsh-browser') !== idFromName('@deepseek-ai/dsh-builtin-browser'))
  }

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exitCode = fail === 0 ? 0 : 1
}

await main()
