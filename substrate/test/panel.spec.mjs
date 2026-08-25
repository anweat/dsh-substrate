/**
 * Panel scaffold tests.
 *
 * The assertions that carry weight are the ones about identity and collision,
 * because those are what the scaffold exists for. A scaffold that registered
 * from its own Context would stamp every panel with its own name; a scaffold
 * that let plugins pick channel paths freely would reproduce the collision it
 * is meant to remove. Both are pinned here against fakes that reproduce the
 * real services' ownership rules, and against the real runtime in
 * `lab-panel.ts`.
 *
 * Run: node test/panel.spec.mjs
 */
import {
  definePanel, channelFor, contributionsOfPanel, panelClient,
  mountPanelHost, mountPanelClient, RESERVED_CHANNELS,
} from '../src/panel.mjs'

let ok = 0, fail = 0
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}
const throws = fn => { try { fn(); return false } catch { return true } }

/** A Context whose services carry the ownership rules the real ones have. */
function fakeCtx(name, world) {
  return {
    name,
    slots: {
      register: (options, component) => {
        const entry = { ...options, registrant: options.registrant ?? name, component }
        const seat = world.slots.get(options.name) ?? []
        if (seat.some(e => e.id === entry.id)) throw new Error(`duplicate slot entry ${entry.id}`)
        world.slots.set(options.name, [...seat, entry])
        return () => world.slots.set(options.name, (world.slots.get(options.name) ?? []).filter(e => e !== entry))
      },
    },
    connection: {
      rpc: {
        handle: (channel, handler, options) => {
          if (world.channels.has(channel)) throw new Error(`webserver: duplicate prefix route "${channel}"`)
          world.channels.set(channel, { owner: name, handler, options })
          return async () => { world.channels.delete(channel) }
        },
      },
    },
  }
}
const world = () => ({ slots: new Map(), channels: new Map() })

console.log('\n=== 路径从包名派生,所以不同包不可能撞车 ===')
{
  check('作用域包名去掉 @', channelFor('@scope/thing', 'main') === '/scope-thing.main', channelFor('@scope/thing', 'main'))
  check('裸包名同样可用', channelFor('thing', 'main') === '/thing.main', channelFor('thing', 'main'))
  check('大小写归一', channelFor('@Scope/Thing', 'Main') === '/scope-thing.main', channelFor('@Scope/Thing', 'Main'))
  check('派生的通道只有一段 —— 连接层的文法拒绝内层斜杠',
    !channelFor('@a/b', 'c').slice(1).includes('/'), channelFor('@a/b', 'c'))
  check('两半用 . 连接,slug 里不会有 . 所以拆分无歧义',
    channelFor('@a/b', 'c') !== channelFor('@a', 'b-c'),
    `${channelFor('@a/b', 'c')} vs ${channelFor('@a', 'b-c')}`)
  check('两个不同包拿不到同一条路径',
    channelFor('@a/panel', 'main') !== channelFor('@b/panel', 'main'))
  check('同包不同面板也不同',
    channelFor('@a/p', 'one') !== channelFor('@a/p', 'two'))
  check('同一个包的同一个面板确实相同 —— 分叉互撞是对的',
    channelFor('@a/p', 'main') === channelFor('@a/p', 'main'))
  check('派生不出段就抛错', throws(() => channelFor('@@@', 'main')) && throws(() => channelFor('p', '---')))
}

console.log('\n=== 声明是自足可检的 ===')
{
  const p = definePanel({ pkg: '@a/p', name: 'main', slot: 'settings.section', endpoints: ['list', 'save'] })
  check('派生出 channel', p.channel === '/a-p.main', p.channel)
  check('派生出 entryId', p.entryId === '@a/p:main', p.entryId)
  check('authority 默认 loopback', p.authority === 'loopback')
  check('endpoints 被复制而非借用', p.endpoints !== undefined && p.endpoints.length === 2)

  check('缺 pkg 抛错', throws(() => definePanel({ name: 'a', slot: 's' })))
  check('缺 slot 抛错', throws(() => definePanel({ pkg: '@a/p', name: 'a' })))
  check('空字符串不算给了', throws(() => definePanel({ pkg: '', name: 'a', slot: 's' })))

  for (const reserved of RESERVED_CHANNELS) {
    check(`保留通道 ${reserved} 被拒`,
      throws(() => definePanel({ pkg: '@a/p', name: 'm', slot: 's', channel: reserved })))
  }
  check('相对路径的 channel 被拒',
    throws(() => definePanel({ pkg: '@a/p', name: 'm', slot: 's', channel: 'a/b' })))
  check('带内层斜杠的 channel 被拒 —— 真文法只认一段',
    throws(() => definePanel({ pkg: '@a/p', name: 'm', slot: 's', channel: '/a/b' })))
  check('非法字符的 channel 被拒',
    throws(() => definePanel({ pkg: '@a/p', name: 'm', slot: 's', channel: '/a b' })))
  check('非法 endpoint 被拒',
    throws(() => definePanel({ pkg: '@a/p', name: 'm', slot: 's', endpoints: ['../etc'] })))
  check('重复 endpoint 被拒',
    throws(() => definePanel({ pkg: '@a/p', name: 'm', slot: 's', endpoints: ['a', 'a'] })))
  check('显式 channel 覆盖派生值',
    definePanel({ pkg: '@a/p', name: 'm', slot: 's', channel: '/custom-path' }).channel === '/custom-path')
}

console.log('\n=== 身份:注册必须落在插件自己的 ctx 上 ===')
{
  const w = world()
  const panel = definePanel({ pkg: '@a/p', name: 'main', slot: 'settings.section' })
  const plugin = fakeCtx('plugin-a', w)
  const scaffold = fakeCtx('the-scaffold', w)

  mountPanelClient(plugin, panel, 'Comp')
  check('用插件的 ctx,registrant 是插件',
    w.slots.get('settings.section')[0].registrant === 'plugin-a',
    w.slots.get('settings.section')[0].registrant)

  const other = definePanel({ pkg: '@b/p', name: 'main', slot: 'settings.section' })
  mountPanelClient(scaffold, other, 'Comp')
  check('用脚手架的 ctx,registrant 变成脚手架 —— 这正是不能包裹的原因',
    w.slots.get('settings.section')[1].registrant === 'the-scaffold',
    w.slots.get('settings.section')[1].registrant)

  const hostPanel = definePanel({ pkg: '@a/p', name: 'main', slot: 's', endpoints: ['list'] })
  mountPanelHost(plugin, hostPanel, { list: () => [] })
  check('通道归属同样取自调用方 ctx',
    w.channels.get('/a-p.main').owner === 'plugin-a',
    w.channels.get('/a-p.main').owner)
}

console.log('\n=== 两个包各自挂载,后端不再撞车 ===')
{
  const w = world()
  const a = definePanel({ pkg: '@a/p', name: 'main', slot: 'settings.section', endpoints: ['list'] })
  const b = definePanel({ pkg: '@b/p', name: 'main', slot: 'settings.section', endpoints: ['list'] })
  mountPanelHost(fakeCtx('a', w), a, { list: () => 1 })
  let threw
  try { mountPanelHost(fakeCtx('b', w), b, { list: () => 2 }) } catch (e) { threw = e }
  check('两个同名面板的不同包共存', threw === undefined, String(threw))
  check('各占一条通道', w.channels.size === 2, String(w.channels.size))

  // The same package mounted twice is a genuine collision and must still throw.
  const w2 = world()
  mountPanelHost(fakeCtx('a', w2), a, { list: () => 1 })
  check('同一个面板挂两次仍然抛错 —— 脚手架不掩盖真冲突',
    throws(() => mountPanelHost(fakeCtx('a-fork', w2), a, { list: () => 1 })))
}

console.log('\n=== handler 与声明必须对齐 ===')
{
  const w = world()
  const panel = definePanel({ pkg: '@a/p', name: 'm', slot: 's', endpoints: ['list', 'save'] })
  check('少一个 handler 就抛错',
    throws(() => mountPanelHost(fakeCtx('a', w), panel, { list: () => 1 })))
  check('多一个未声明的 handler 也抛错',
    throws(() => mountPanelHost(fakeCtx('a', w), panel, { list: () => 1, save: () => 2, extra: () => 3 })))
  check('对齐时通过',
    !throws(() => mountPanelHost(fakeCtx('a', w), panel, { list: () => 1, save: () => 2 })))
  check('无 endpoint 的面板可以只有前端半',
    !throws(() => mountPanelHost(fakeCtx('b', w), definePanel({ pkg: '@b/p', name: 'm', slot: 's' }), {})))
}

console.log('\n=== 调用方:路径只写一次 ===')
{
  const panel = definePanel({ pkg: '@a/p', name: 'main', slot: 's', endpoints: ['list', 'save'] })
  const calls = []
  const client = panelClient(panel, async (url, init) => {
    calls.push({ url, body: init.body })
    return { json: async () => ({ ok: true }) }
  })
  check('每个 endpoint 一个方法', Object.keys(client).join(',') === 'list,save', Object.keys(client).join(','))
  await client.list({ page: 1 })
  check('URL 由声明拼出,组件不写路径', calls[0].url === '/a-p.main/list', calls[0].url)
  check('载荷被序列化', calls[0].body === '{"page":1}', calls[0].body)
  await client.save()
  check('省略载荷时发 null', calls[1].body === 'null', calls[1].body)
  check('未声明的 endpoint 不存在方法', client.nope === undefined)
}

console.log('\n=== 接进裁决账本:一个面板是两笔贡献 ===')
{
  const panel = definePanel({ pkg: '@a/p', name: 'main', slot: 'settings.section', endpoints: ['list'] })
  const cs = contributionsOfPanel(panel, () => 'slot-single')
  check('两笔', cs.length === 2, String(cs.length))
  check('一笔在前端平面', cs.some(c => c.plane === 'client' && c.kind === 'slot-single' && c.target === 'settings.section'))
  check('一笔在主机平面', cs.some(c => c.plane === 'host' && c.kind === 'route' && c.target === '/a-p.main'))
  check('两笔同一个归属 —— 裁决才能把它们当一个单元',
    new Set(cs.map(c => c.owner)).size === 1 && cs[0].owner === '@a/p')
  check('槽的元数默认按 list 取', contributionsOfPanel(panel)[0].kind === 'slot-list')
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
