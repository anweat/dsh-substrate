/**
 * P3.6 — does a patch-layer edit stay live, and at what blast radius?
 *
 * The substrate writes its decisions into the user patch layer, and its emitter
 * owns that file wholly: it regenerates it rather than appending, because patch
 * rows carry no conditional guard and stacking them would build a group twice.
 * That contract is only affordable if re-applying a wholly rewritten file
 * touches the rows that changed and leaves the rest alone. If every rewrite
 * tore down every patched plugin, each substrate decision would cost a full
 * restart and nobody would run it interactively.
 *
 * So the question is not "does hot reload work" but "what does one edit cost".
 * The plugins here record every apply and dispose, and the assertions are
 * mostly about what must NOT appear in that log.
 *
 * Run: node --import tsx/esm lab-no-restart.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot, watchUserPatches } from './packages/boot/app-boot/src/index.ts'
import { Context } from './vendor/cordis/src/index.ts'
import WebServer from './packages/host/webserver/src/index.ts'
import * as clientHmr from './packages/client/hmr/src/index.ts'
import { EVENTS_ENDPOINT } from './packages/client/hmr/src/events.ts'

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/** Every plugin writes its lifecycle here, so the cost of an edit is readable. */
interface LabEvent { who: string, what: 'apply' | 'dispose', mark?: unknown }
const lab = (): LabEvent[] => (globalThis as { __lab?: LabEvent[] }).__lab ?? []

const RECORDER = `
export const name = 'recorder'
export function apply(ctx, config) {
  const who = config?.who ?? 'anon'
  globalThis.__lab ??= []
  globalThis.__lab.push({ who, what: 'apply', mark: config?.mark })
  ctx.effect(() => () => { globalThis.__lab.push({ who, what: 'dispose' }) }, who + ':lifecycle')
}
`

const CONFIG = `
- id: alpha
  name: ./recorder.mjs
  config:
    who: alpha

- id: beta
  name: ./recorder.mjs
  config:
    who: beta

- id: gamma
  name: ./recorder.mjs
  config:
    who: gamma
`

const since = (mark: number): LabEvent[] => lab().slice(mark)
const whoDid = (mark: number, what: 'apply' | 'dispose'): string[] =>
  since(mark).filter(e => e.what === what).map(e => e.who).sort()
const summary = (mark: number): string =>
  JSON.stringify(since(mark).map(e => `${e.who}:${e.what}${e.mark === undefined ? '' : `(${String(e.mark)})`}`))

/**
 * Write a patch file and wait for the tree to go quiet.
 *
 * Waiting for the first matching event is not enough. The loader is still
 * settling an update when its first lifecycle event lands, and a second write
 * arriving during that window is coalesced away — which is what a person
 * editing the file would never do, and what an earlier version of this test
 * did, reporting a product failure that was its own race.
 */
async function writePatch(path: string, body: string): Promise<void> {
  writeFileSync(path, body)
  let seen = -1
  while (seen !== lab().length) {
    seen = lab().length
    await new Promise(resolve => { setTimeout(resolve, 400) })
  }
}

/**
 * The other half of the question: is the browser told?
 *
 * Everything above is the host plane. A patch edit that disables a row also
 * has to reach the browser, or the page keeps rendering a plugin whose host
 * half is gone. The dev channel carries two frame types, so this reads what
 * the host actually puts on the wire.
 *
 * The contrast is the point. Asserting silence proves nothing if the channel
 * is simply broken, so this first shows a `rebuilt` frame arriving, and only
 * then asserts that nothing corresponds to a roster change.
 */
async function browserChannel(): Promise<void> {
  console.log('\n=== 浏览器那一侧:名册变了,通道上有什么 ===')
  const root = new Context()
  await root.plugin(WebServer, { host: '127.0.0.1', port: 0 })

  let roster = ['alpha', 'beta']
  let fireRebuilt: ((id: string, rev: string) => void) | undefined
  let fireGraphChanged: (() => void) | undefined
  root.provide('clientModules')
  root.set('clientModules', {
    graph: () => ({ rev: 'r1', entries: roster.map(id => ({ id, url: `/${id}.js`, rev: 'r1' })) }),
    clientPath: () => undefined,
    rebuilt: () => {},
    onRebuilt: (cb: (id: string, rev: string) => void) => { fireRebuilt = cb; return () => { fireRebuilt = undefined } },
    onGraphChanged: (cb: () => void) => { fireGraphChanged = cb; return () => { fireGraphChanged = undefined } },
  })
  await root.plugin(clientHmr)
  check('主机确实订阅了图变化 —— 它知道名册变了', fireGraphChanged !== undefined)

  const port = (root.webServer as { port: number }).port
  const frames: { type: string }[] = []
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${port}${EVENTS_ENDPOINT}`, { signal: controller.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        for (const line of buffer.split('\n')) {
          const payload = line.startsWith('data: ') ? line.slice(6).trim() : undefined
          if (payload === undefined || payload === '') continue
          try { frames.push(JSON.parse(payload) as { type: string }) } catch { /* partial frame; the next read completes it */ }
        }
        buffer = buffer.slice(buffer.lastIndexOf('\n') + 1)
      }
    } catch { /* the abort below ends the read */ }
  })()

  await new Promise(resolve => { setTimeout(resolve, 400) })
  check('连上时收到一帧 graph 快照', frames.filter(f => f.type === 'graph').length === 1, JSON.stringify(frames))

  // Roster change: the composition now has one fewer client half, and the host
  // is notified — `onGraphChanged` is what it uses to re-sync bundle watches.
  const mark = frames.length
  roster = ['alpha']
  fireGraphChanged?.()
  await new Promise(resolve => { setTimeout(resolve, 600) })
  check('主机收到了图变化通知,却没有往通道上写任何东西',
    frames.length === mark, JSON.stringify(frames.slice(mark)))

  // The channel itself is live, so the silence above is a real absence.
  fireRebuilt?.('alpha', 'r2')
  await new Promise(resolve => { setTimeout(resolve, 300) })
  check('同一条通道上 rebuilt 帧照常到达 —— 沉默不是通道坏了',
    frames.slice(mark).some(f => f.type === 'rebuilt'), JSON.stringify(frames.slice(mark)))

  controller.abort()
  await (root.fiber as { dispose: () => Promise<void> }).dispose()
  await new Promise(resolve => { setTimeout(resolve, 100) })
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-hmr-'))
  writeFileSync(join(dir, 'recorder.mjs'), RECORDER)
  writeFileSync(join(dir, 'cordis.yml'), CONFIG)
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, '[]\n')

  const ctx = await boot('dsh-lab', join(dir, 'cordis.yml'))
  await new Promise(resolve => { setTimeout(resolve, 300) })

  const pid = process.pid
  check('三个插件都起来了', whoDid(0, 'apply').join(',') === 'alpha,beta,gamma', summary(0))

  // The watch wiring profile-boot installs, reproduced here.
  if (ctx.get('timer') === undefined) await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
  if (ctx.get('hmr') === undefined) await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
  await watchUserPatches(ctx, { binName: 'dsh-lab', filename: patchPath })
  await new Promise(resolve => { setTimeout(resolve, 300) })

  console.log('\n=== 一次编辑:停掉一行 ===')
  {
    const mark = lab().length
    await writePatch(patchPath, '- id: beta\n  disabled: true\n')
    check('补丁改动生效了', whoDid(mark, 'dispose').includes('beta'), summary(mark))
    check('进程没有重启', process.pid === pid)
    check('alpha 与 gamma 没有被拆 —— 爆炸半径就是改动的那一行',
      whoDid(mark, 'dispose').join(',') === 'beta', summary(mark))
    check('也没有任何插件被重新 apply', whoDid(mark, 'apply').length === 0, summary(mark))
  }

  console.log('\n=== 重新启用 ===')
  {
    const mark = lab().length
    await writePatch(patchPath, '[]\n')
    check('清空补丁后 beta 回来了', whoDid(mark, 'apply').includes('beta'), summary(mark))
    check('只有 beta 重新 apply', whoDid(mark, 'apply').join(',') === 'beta', summary(mark))
    check('其它两个仍然没动', whoDid(mark, 'dispose').length === 0, summary(mark))
  }

  console.log('\n=== 发射器的契约:整体重写补丁文件 ===')
  {
    // The substrate never appends; it rewrites the whole file from a clean
    // base. So the bytes change completely even when one decision did, and the
    // cost must still be one row.
    await writePatch(patchPath, '- id: alpha\n  config:\n    who: alpha\n    mark: first\n')

    const mark = lab().length
    await writePatch(patchPath,
      '- id: alpha\n  config:\n    who: alpha\n    mark: first\n'
      + '- id: gamma\n  config:\n    who: gamma\n    mark: added\n')
    check('整体重写后新决定生效', since(mark).some(e => e.mark === 'added'), summary(mark))
    check('未变的 alpha 没有被重建 —— 重写整份文件不等于重建整棵树',
      !whoDid(mark, 'dispose').includes('alpha'), summary(mark))
    check('不在补丁里的 beta 完全没被打扰',
      !whoDid(mark, 'dispose').includes('beta') && !whoDid(mark, 'apply').includes('beta'), summary(mark))
  }

  console.log('\n=== 改一行的 config ===')
  {
    const mark = lab().length
    await writePatch(patchPath,
      '- id: alpha\n  config:\n    who: alpha\n    mark: second\n'
      + '- id: gamma\n  config:\n    who: gamma\n    mark: added\n')
    check('新 config 生效', since(mark).some(e => e.mark === 'second'), summary(mark))
    check('改 config 的那一行是 dispose + apply,不是就地重配',
      whoDid(mark, 'dispose').includes('alpha') && whoDid(mark, 'apply').includes('alpha'), summary(mark))
    check('config 未变的 gamma 没动 —— 同一份文件里,只有变了的那行付代价',
      !whoDid(mark, 'dispose').includes('gamma') && !whoDid(mark, 'apply').includes('gamma'), summary(mark))
  }

  console.log('\n=== 坏补丁不会拆掉正在跑的树 ===')
  {
    const mark = lab().length
    await writePatch(patchPath, 'this: is not a list\n')
    check('进程还活着', process.pid === pid)
    check('没有插件因为一份坏补丁被拆', whoDid(mark, 'dispose').length === 0, summary(mark))

    const recover = lab().length
    await writePatch(patchPath, '- id: beta\n  disabled: true\n')
    check('坏补丁之后的好补丁仍然生效 —— 监视没有因为一次失败停掉',
      whoDid(recover, 'dispose').includes('beta'), summary(recover))
  }

  await (ctx.fiber as { dispose: () => Promise<void> }).dispose()
  await new Promise(resolve => { setTimeout(resolve, 100) })
  rmSync(dir, { recursive: true, force: true })

  await browserChannel()
  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exitCode = fail === 0 ? 0 : 1
}

await main()
