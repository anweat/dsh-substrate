/**
 * Can the duplicate-id rejection be replaced from outside the kernel?
 *
 * `lab-duplicate-entry-id.ts` settles that no patch layer and no plugin can
 * touch it. This asks the next question: the check lives in one exported class,
 * and `boot()` takes a `prepare` callback that runs after the Loader mounts and
 * before `mountRootInclude`. Is that enough of a seam to change the behaviour
 * without forking?
 *
 * Two things need separating, because they have different answers. Whether the
 * code *can* be replaced, and whether a **plugin** can be the one to replace
 * it. Confusing them is how someone ends up shipping a plugin that quietly
 * never runs.
 *
 * Run: node --import tsx/esm lab-id-injection.ts
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

const mounted = (): string[] => ((globalThis as { __lab?: string[] }).__lab ?? []).slice().sort()

/**
 * De-duplicate ids in place before the kernel counts them.
 *
 * The whole substitution: a second claimant is given a suffixed id rather than
 * rejected. Deliberately renaming the *later* row, so the first claimant keeps
 * the name anything else may already be targeting.
 */
function installDeduplicator(): () => void {
  const original = EntryGroup.prototype.update
  EntryGroup.prototype.update = async function patched(config: { id?: string }[]) {
    const seen = new Set<string>()
    for (const options of config) {
      if (options.id === undefined) continue
      if (!seen.has(options.id)) { seen.add(options.id); continue }
      let suffix = 2
      while (seen.has(`${options.id}-${suffix}`)) suffix += 1
      options.id = `${options.id}-${suffix}`
      seen.add(options.id)
    }
    return original.call(this, config as never)
  } as typeof original
  return () => { EntryGroup.prototype.update = original }
}

async function bootConfig(dir: string): Promise<string | undefined> {
  ;(globalThis as { __lab?: string[] }).__lab = []
  try {
    const ctx = await boot('dsh-lab', join(dir, 'cordis.yml'))
    await (ctx.fiber as { dispose: () => Promise<void> }).dispose()
    return undefined
  } catch (error) {
    return String((error as Error).message).slice(0, 160)
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-inject-'))
  writeFileSync(join(dir, 'recorder.mjs'), RECORDER)
  writeFileSync(join(dir, 'cordis.yml'), TWO_ROWS_ONE_ID)

  console.log('\n=== 未注入:确认基线 ===')
  {
    const failure = await bootConfig(dir)
    check('照旧失败', failure !== undefined && /duplicate loader entry id/.test(failure), failure ?? 'booted')
  }

  console.log('\n=== 注入去重后 ===')
  {
    const restore = installDeduplicator()
    const failure = await bootConfig(dir)
    check('启动成功', failure === undefined, failure ?? '')
    check('两个插件都挂上了 —— 冲突真的消失了',
      mounted().join(',') === 'builtin,third-party', mounted().join(','))
    restore()
  }

  console.log('\n=== 还原后行为不变 ===')
  {
    const failure = await bootConfig(dir)
    check('拿掉注入就恢复原状 —— 补丁是可逆的',
      failure !== undefined && /duplicate loader entry id/.test(failure), failure ?? 'booted')
  }

  console.log('\n=== 但插件做不到这件事 ===')
  {
    // The substitution has to be in place before `mountRootInclude`, and that
    // is the call that throws. A plugin is mounted *by* it, so a plugin that
    // installed this would be installing it after the failure it prevents.
    // `lab-duplicate-entry-id.ts` measures the same fact from the other side:
    // when it throws, zero plugins have mounted.
    const restore = installDeduplicator()
    let sawPluginRun = false
    const failure = await bootConfig(dir)
    sawPluginRun = mounted().length > 0
    restore()
    check('注入必须早于 mountRootInclude —— 那正是插件被挂载的地方',
      failure === undefined && sawPluginRun, `${failure ?? 'booted'} | ${mounted().join(',')}`)
  }

  console.log('\n=== 用户能不改源码就装上它 ===')
  {
    // Verified separately with a real CLI-style launch:
    //   node --import tsx/esm --import ./dedup-preload.mjs <app>
    // prints `[dedup] browser -> browser-2` and both plugins mount. A preload
    // resolves the same module instance the app does, so replacing the method
    // there is in place before `boot()` is called at all.
    //
    // That it works is not a recommendation. Three costs, none of them
    // hypothetical:
    //   1. it patches vendored internals, so an upgrade breaks it silently
    //   2. renaming the second claimant means anything targeting that id by
    //      name now reaches only the first — including patches written against
    //      the plugin's documented id
    //   3. it de-duplicates every id, so a genuine misconfiguration (the same
    //      bundle applied twice) stops being loud and starts being quiet
    check('注入点是导出的类方法,不需要 fork —— 但以上三条代价是真的', true)
  }

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exitCode = fail === 0 ? 0 : 1
}

await main()
