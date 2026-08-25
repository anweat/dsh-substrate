/**
 * L4 — the panel scaffold against the real services.
 *
 * `test/panel.spec.mjs` pins the scaffold against fakes that reproduce the
 * ownership rules; this proves those rules are the ones the runtime actually
 * has. Three claims need the real thing to be worth anything:
 *
 *   1. `registrant` follows the Context that reads `slots`, so a scaffold
 *      function called with the plugin's ctx keeps the plugin's identity, and
 *      one called with the scaffold's own ctx loses it.
 *   2. `connection.rpc.handle` lands as a real prefix route on the real
 *      webserver and answers over HTTP.
 *   3. Deriving the channel from the package name makes two same-named panels
 *      from different packages coexist, while the genuine collision — one
 *      package mounted twice — still throws.
 *
 * Run: node --import tsx/esm lab-panel.ts
 */
import { pathToFileURL } from 'node:url'
import { Context } from './vendor/cordis/src/index.ts'
import { SlotRegistry } from './packages/client/runtime/src/client/slots.ts'
import WebServer from './packages/host/webserver/src/index.ts'
import * as connection from './packages/client/connection/src/index.ts'

const SUBSTRATE = pathToFileURL(process.env.DSH_SUBSTRATE ?? '../substrate/src').href
const { definePanel, mountPanelHost, mountPanelClient, channelFor } = await import(`${SUBSTRATE}/panel.mjs`)

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

declare module './packages/client/ui-slots/src/index.ts' {
  interface SlotMap {
    'lab.panel.list': { kind: 'list', scope: 'root', owner: Record<string, never> }
  }
}
const Comp = () => null

async function main(): Promise<void> {
  const root = new Context()
  await root.plugin(SlotRegistry)
  await root.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await root.plugin(connection, { trustedHosts: [] })

  const slots = root.slots as SlotRegistry
  slots.register(
    { name: 'root', children: { 'lab.panel.list': { kind: 'list', scope: 'root' } } } as never,
    Comp as never,
  )

  /** Run a body inside a named plugin fiber and hand it that fiber's Context. */
  const asPlugin = async (name: string, body: (ctx: Context) => void | Promise<void>): Promise<void> => {
    let failure: unknown
    await root.plugin({
      name,
      inject: ['slots', 'connection', 'webServer'],
      apply: async (ctx: Context) => { try { await body(ctx) } catch (e) { failure = e } },
    })
    if (failure !== undefined) throw failure
  }

  console.log('\n=== 前端半:registrant 跟随调用方 ctx ===')
  let scaffoldCtx!: Context
  await asPlugin('the-scaffold', ctx => { scaffoldCtx = ctx })
  {
    const panel = definePanel({ pkg: '@a/plugin', name: 'main', slot: 'lab.panel.list' })
    await asPlugin('plugin-a', ctx => { mountPanelClient(ctx, panel, Comp) })

    const entries = slots.entries('lab.panel.list') as Array<{ options?: { id?: string }, registrant?: string }>
    check('用插件自己的 ctx 挂载,registrant 是插件',
      entries[0].registrant === 'plugin-a', String(entries[0].registrant))
    check('entryId 落到条目上', entries[0].options?.id === '@a/plugin:main', JSON.stringify(entries[0].options))

    // The failure mode the scaffold is shaped to avoid.
    const other = definePanel({ pkg: '@b/plugin', name: 'main', slot: 'lab.panel.list' })
    mountPanelClient(scaffoldCtx, other, Comp)
    const after = slots.entries('lab.panel.list') as Array<{ registrant?: string }>
    check('换成脚手架的 ctx,registrant 变成脚手架 —— 包裹式实现会把整个生态盖成同一个名字',
      after[1].registrant === 'the-scaffold', String(after[1].registrant))
  }

  console.log('\n=== 后端半:通道确实落成真路由并应答 ===')
  const port = (root.webServer as { port: number }).port
  {
    const panel = definePanel({
      pkg: '@a/plugin', name: 'data', slot: 'lab.panel.list', endpoints: ['list'],
    })
    await asPlugin('plugin-a-host', ctx => {
      mountPanelHost(ctx, panel, { list: (payload: unknown) => ({ echo: payload }) })
    })
    check('通道路径由包名派生', panel.channel === '/a-plugin.data', panel.channel)

    const response = await fetch(`http://127.0.0.1:${port}${panel.channel}/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ type: 'client-request', rpcId: 1, payload: { hello: 'world' } }),
    })
    check('真 HTTP 请求打到了这条通道', response.status === 200, String(response.status))
    const body = await response.json() as { result?: { ok?: boolean } }
    check('应答是 RPC 信封', body.result !== undefined, JSON.stringify(body).slice(0, 120))
  }

  console.log('\n=== 撞车:不同包共存,同一个包仍然抛错 ===')
  {
    check('两个不同包的同名面板派生出不同路径',
      channelFor('@a/plugin', 'shared') !== channelFor('@b/plugin', 'shared'))

    const a = definePanel({ pkg: '@a/plugin', name: 'shared', slot: 'lab.panel.list', endpoints: ['x'] })
    const b = definePanel({ pkg: '@b/plugin', name: 'shared', slot: 'lab.panel.list', endpoints: ['x'] })
    let coexist: unknown
    try {
      await asPlugin('co-a', ctx => { mountPanelHost(ctx, a, { x: () => 1 }) })
      await asPlugin('co-b', ctx => { mountPanelHost(ctx, b, { x: () => 2 }) })
    } catch (e) { coexist = e }
    check('两个同名面板的不同包在真 webserver 上共存',
      coexist === undefined, String(coexist).slice(0, 140))

    let duplicate: unknown
    try {
      await asPlugin('co-a-fork', ctx => { mountPanelHost(ctx, a, { x: () => 3 }) })
    } catch (e) { duplicate = e }
    check('同一个面板挂第二次仍然抛错 —— 脚手架不掩盖真冲突',
      duplicate !== undefined && /duplicate/.test(String(duplicate)), String(duplicate).slice(0, 140))
  }

  console.log('\n=== 处置:通道随插件的 fiber 一起消失 ===')
  {
    const panel = definePanel({ pkg: '@d/plugin', name: 'temp', slot: 'lab.panel.list', endpoints: ['ping'] })
    const fiber = await root.plugin({
      name: 'disposable',
      inject: ['slots', 'connection', 'webServer'],
      apply: (ctx: Context) => { mountPanelHost(ctx, panel, { ping: () => 'pong' }) },
    })
    const url = `http://127.0.0.1:${port}${panel.channel}/ping`
    const live = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ type: 'client-request', rpcId: 1, payload: null }),
    })
    check('挂载后可达', live.status === 200, String(live.status))
    await fiber.dispose()
    const gone = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ type: 'client-request', rpcId: 2, payload: null }),
    })
    check('插件卸载后通道消失 —— 归属正确才会这样',
      gone.status === 404, String(gone.status))
  }

  // Close the listening socket before exiting; leaving it open makes the
  // process abort on Windows and lose the verdict.
  await (root.fiber as { dispose: () => Promise<void> }).dispose()
  // Give libuv a turn to finish closing the listening handle. Exiting while it
  // is still closing aborts the process on Windows and loses the verdict.
  await new Promise(resolve => { setTimeout(resolve, 50) })
  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
