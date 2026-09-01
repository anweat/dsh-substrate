/**
 * Can the patch layer resolve a duplicate loader entry id?
 *
 * Prompted by a real report: `@anweat/dsh-browser` inserts `id: browser` and
 * so does the shipped `dsh-builtin-browser`, and the profile stops booting with
 * `duplicate loader entry id: browser`. The reporter tried `disabled: true` on
 * the built-in rows and says it had no effect.
 *
 * That claim matters here, because `emit-patch`'s `rename` remedy is built on
 * disabling a row at its original seat and re-inserting it elsewhere under a
 * new id. If disabling does not remove a row from the id check, the remedy
 * does not work for the case it was written for, and this file is where that
 * gets settled rather than assumed.
 *
 * Run: node --import tsx/esm lab-duplicate-entry-id.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from './packages/boot/app-boot/src/index.ts'

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

/** Boot one config with one patch layer, returning the failure if there is one. */
async function bootWith(dir: string, rows: string, patches: unknown[]): Promise<string | undefined> {
  writeFileSync(join(dir, 'cordis.yml'), rows)
  ;(globalThis as { __lab?: string[] }).__lab = []
  try {
    const ctx = await boot('dsh-lab', join(dir, 'cordis.yml'), patches as never)
    await (ctx.fiber as { dispose: () => Promise<void> }).dispose()
    return undefined
  } catch (error) {
    const flat: string[] = []
    const walk = (e: unknown): void => {
      const node = e as { errors?: unknown[], cause?: unknown, message?: string } | null
      if (node === null || node === undefined) return
      if (Array.isArray(node.errors)) { for (const child of node.errors) walk(child); return }
      if (node.cause !== undefined) { walk(node.cause); return }
      flat.push(String(node.message ?? e))
    }
    walk(error)
    return flat.join(' | ')
  }
}

const mounted = (): string[] => ((globalThis as { __lab?: string[] }).__lab ?? []).slice().sort()

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-dupid-'))
  writeFileSync(join(dir, 'recorder.mjs'), RECORDER)

  const TWO_ROWS_ONE_ID = `
- id: browser
  name: ./recorder.mjs
  config:
    who: builtin

- id: browser
  name: ./recorder.mjs
  config:
    who: third-party
`

  console.log('\n=== 复现:两行同 id ===')
  {
    const failure = await bootWith(dir, TWO_ROWS_ONE_ID, [])
    check('启动失败', failure !== undefined)
    check('失败原因正是 duplicate loader entry id',
      /duplicate loader entry id: browser/.test(failure ?? ''), (failure ?? '').slice(0, 140))
    // Decides whether a plugin could ever report this: the id check runs in
    // `EntryGroup.update` during `mountRootInclude`, before any entry applies.
    check('抛错时一个插件都没挂上 —— 所以这类冲突不可能由插件来报',
      mounted().length === 0, JSON.stringify(mounted()))
  }

  console.log('\n=== 报告里试过的办法:补丁层 disabled: true ===')
  {
    const failure = await bootWith(dir, TWO_ROWS_ONE_ID, [{ id: 'browser', disabled: true }])
    check('仍然失败 —— 报告属实',
      failure !== undefined && /duplicate loader entry id/.test(failure), (failure ?? 'booted').slice(0, 140))
    check('所以 disabled 不能把一行从 id 检查里移走',
      failure !== undefined)
  }

  console.log('\n=== 补丁能不能改一行的 id ===')
  {
    // `applyEntryPatches` destructures `id` out and then skips it while copying
    // overrides, so this should be a no-op rather than a rename.
    const failure = await bootWith(dir, TWO_ROWS_ONE_ID, [{ id: 'browser', name: './recorder.mjs' }])
    check('补丁改不了 id —— 冲突照旧',
      failure !== undefined && /duplicate loader entry id/.test(failure), (failure ?? 'booted').slice(0, 140))
  }

  console.log('\n=== 那什么能修 ===')
  {
    const UNIQUE = `
- id: browser
  name: ./recorder.mjs
  config:
    who: builtin

- id: browser-pro
  name: ./recorder.mjs
  config:
    who: third-party
`
    const failure = await bootWith(dir, UNIQUE, [])
    check('id 唯一后正常启动', failure === undefined, (failure ?? '').slice(0, 140))
    check('两个插件都挂上了', mounted().join(',') === 'builtin,third-party', mounted().join(','))
  }

  console.log('\n=== emit-patch 的 rename 补救在哪种情形下成立 ===')
  {
    // The remedy disables a row at its seat and re-inserts it under a new id.
    // That only removes a collision when the id it frees was not also claimed
    // by a row the patch cannot touch.
    const ONE_ROW = `
- id: browser
  name: ./recorder.mjs
  config:
    who: third-party
`
    const rehomed = await bootWith(dir, ONE_ROW, [
      { id: 'browser', disabled: true },
      { insert: [{ id: 'browser-pro', name: './recorder.mjs', config: { who: 'third-party' } }] },
    ])
    check('单行改名:启动正常', rehomed === undefined, (rehomed ?? '').slice(0, 140))
    check('挂上的是改名后那份', mounted().join(',') === 'third-party', mounted().join(','))

    const stillDuplicate = await bootWith(dir, TWO_ROWS_ONE_ID, [
      { id: 'browser', disabled: true },
      { insert: [{ id: 'browser-pro', name: './recorder.mjs', config: { who: 'third-party' } }] },
    ])
    check('两行同 id 时改名无效 —— 被停的那行仍占着 id',
      stillDuplicate !== undefined && /duplicate loader entry id/.test(stillDuplicate),
      (stillDuplicate ?? 'booted').slice(0, 140))
  }

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exitCode = fail === 0 ? 0 : 1
}

await main()
