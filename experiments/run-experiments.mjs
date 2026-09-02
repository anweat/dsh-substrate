/**
 * Experiment runner: one command, one compact verdict.
 *
 * Exists so a session does not have to re-derive the plan or re-read each
 * script to know where things stand. Every experiment is a standalone file
 * that prints `PASS`/`FAIL` lines and exits non-zero on failure; this collects
 * them, prints one line each, and writes STATUS.json for the next session to
 * read instead of re-running everything.
 *
 * Usage:
 *   node run-experiments.mjs              run every registered experiment
 *   node run-experiments.mjs isolate      run those whose name matches
 *   node run-experiments.mjs --list       show the registry and last results
 */
import { readdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_ROOT, ECO, require_ } from '../paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const STATUS = join(here, 'STATUS.json')

/** Registered experiments: file plus the question it settles. */
const REGISTRY = [
  { file: 'lab-isolate-proxy.ts', asks: 'isolate 是否给子树独立服务实例;代理能否转发到真实现', phase: 'P0' },
  { file: 'lab-real-registry.ts', asks: '真 ToolRuntime 下 scope 分层是否可行;链序是否即优先级', phase: 'P0' },
  { file: 'lab-loader-isolate.ts', asks: 'loader 的 isolate entry 选项能否纯配置声明拦截', phase: 'P0' },
  { file: 'lab-event-order.ts', asks: 'prepend 是否稳拿头位;短路能否检测;guard 是否免疫短路', phase: 'P0' },
  { file: 'lab-substrate-e2e.ts', asks: '裁决→排链→挂载 整条链在真 ToolRuntime 上是否成立', phase: 'P3' },
  { file: 'lab-gatekeeper-timing.ts', asks: '冲突发生在什么时候;守门员能否在其之前看到 entry list', phase: 'P3' },
  { file: 'lab-gate-ordering.ts', asks: '守门员先于争用者激活能否被保证', phase: 'P3' },
  { file: 'lab-gatekeeper-plugin.ts', asks: '守门员插件在真启动里 veto/report/clean 三态是否正确', phase: 'P3' },
  { file: 'lab-preset-host.ts', asks: '预设宿主经 standingKeyFor 建链后 agent 是否解析到裁决赢家', phase: 'P3' },
  { file: 'lab-scale.ts', asks: '全语料 896 包同链、7164 工具真注册是否成立;开销多少', phase: 'P4' },
  { file: 'lab-client-priority.ts', asks: 'BootPluginRow 带 priority 后,前端争用能否从整包禁用变成槽位让位', phase: 'P3.5', needsPatch: 'bootpluginrow-priority.patch' },
  { file: 'lab-panel.ts', asks: '面板脚手架在真 SlotRegistry/WebServer/connection 上:身份是否跟随调用方 ctx、派生通道能否让同名面板共存', phase: 'L4' },
  { file: 'lab-duplicate-entry-id.ts', asks: '补丁层能否解决重复 entry id;disabled 与改 id 各自有没有用(源自 anweat/dsh-browser#11)', phase: 'L3' },
  { file: 'lab-id-injection.ts', asks: '重复 id 的拒绝能否从内核外替换;插件能不能是替换它的人', phase: 'L3' },
  { file: 'lab-no-restart.ts', asks: '改补丁层要不要重启、爆炸半径多大、浏览器那一侧收不收得到名册变更', phase: 'P3.6' },
]

const args = process.argv.slice(2)
const filter = args.find(a => !a.startsWith('--'))

/**
 * Which checkout this run actually judged.
 *
 * A green run means nothing without it: these assertions pin a moving product,
 * and "the experiments pass" is only a claim about the commit they ran against.
 */
function checkoutUnderTest() {
  const root = process.env.DSH_ROOT
  if (root === undefined || root === '') return { error: 'DSH_ROOT not set' }
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  try {
    return {
      commit: git(['rev-parse', 'HEAD']),
      describe: git(['describe', '--tags', 'HEAD']),
      version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
      dirty: git(['status', '--porcelain']) !== '',
    }
  } catch (error) {
    return { error: String(error?.message ?? error).split('\n')[0] }
  }
}

const checkout = checkoutUnderTest()
if (checkout.describe !== undefined) {
  console.log(`\n对照 ${checkout.version} · ${checkout.describe}${checkout.dirty ? ' · 工作区有未提交改动' : ''}`)
} else {
  console.log(`\n未能识别被测 checkout: ${checkout.error}`)
}
if (args.includes('--list')) {
  const prev = existsSync(STATUS) ? JSON.parse(readFileSync(STATUS, 'utf8')) : { results: [] }
  const byFile = new Map((prev.results ?? []).map(r => [r.file, r]))
  console.log(`\n实验注册表(上次运行: ${prev.ranAt ?? '从未'})\n`)
  for (const e of REGISTRY) {
    const last = byFile.get(e.file)
    const mark = last === undefined ? '  ? ' : last.ok ? ` ok ` : 'FAIL'
    const score = last ? ` ${last.passed}/${last.total}` : ''
    console.log(`  [${mark}]${score.padEnd(7)} ${e.phase}  ${e.file}`)
    console.log(`             ${e.asks}`)
  }
  // Unregistered files are a reminder, not an error: a new experiment is
  // written before it is registered, and silence there loses work.
  const known = new Set(REGISTRY.map(e => e.file))
  const stray = readdirSync(here).filter(f => /^lab-.*\.ts$/.test(f) && !known.has(f))
  if (stray.length > 0) console.log(`\n  未注册的实验文件: ${stray.join(', ')}`)
  process.exit(0)
}

const targets = [...REGISTRY].filter(e => filter === undefined || e.file.includes(filter))
if (targets.length === 0) {
  console.error(`没有匹配 "${filter}" 的实验;用 --list 看注册表`)
  process.exit(1)
}

/**
 * Experiments run from inside the checkout, not from here.
 *
 * They import the product by relative path (`./vendor/cordis/src/index.ts`,
 * `./packages/...`), which is what lets them exercise the real thing rather
 * than a published build. That only resolves at the checkout root, so each
 * file is staged there for the run and removed afterwards. Staging beats
 * rewriting the imports: a path that resolves from two places is a path that
 * can silently resolve to the wrong one.
 */
const root = require_(DSH_ROOT, 'DSH_ROOT', 'run experiments against a real harness')

/**
 * One experiment measures a proposed upstream change, so it only means
 * anything on a checkout carrying that change. Detecting this beats letting it
 * fail: a red line reads as "the mechanism broke", when the real answer is
 * "this checkout does not have the prototype applied".
 */
function patchApplied(name) {
  const patch = readFileSync(join(here, name), 'utf8')
  // Every added line the patch introduces must already be in the checkout.
  const added = patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1).trim())
  const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1])
  const text = files.map(f => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '')).join('\n')
  return added.every(line => line === '' || text.includes(line))
}

const skipped = []
for (const e of [...targets]) {
  if (e.needsPatch === undefined) continue
  if (patchApplied(e.needsPatch)) continue
  targets.splice(targets.indexOf(e), 1)
  skipped.push(e)
}
for (const e of skipped) {
  console.log(`跳过 ${e.file} —— 它测的是一个上游提案,需要先应用 experiments/${e.needsPatch}`)
}

const staged = []
for (const e of targets) {
  const target = join(root, e.file)
  if (existsSync(target)) {
    console.error(`拒绝覆盖 checkout 里已有的 ${e.file};先清理它`)
    process.exit(1)
  }
  copyFileSync(join(here, e.file), target)
  staged.push(target)
}
const cleanup = () => { for (const f of staged) { try { rmSync(f) } catch { /* already gone */ } } }
process.on('exit', cleanup)

const results = []
for (const e of targets) {
  const run = spawnSync(process.execPath, ['--import', 'tsx/esm', e.file], {
    cwd: root, encoding: 'utf8', timeout: 180000,
    // Both absolute: the experiment runs with the checkout as its cwd, so a
    // relative default here would resolve beside the product instead of here.
    env: { ...process.env, DSH_SUBSTRATE: join(here, '..', 'substrate', 'src'), DSH_ECO: ECO },
  })
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const passed = (out.match(/^\s*PASS\s/gm) ?? []).length
  const failed = (out.match(/^\s*FAIL\s/gm) ?? []).length
  const ok = run.status === 0 && failed === 0
  results.push({ file: e.file, phase: e.phase, ok, passed, failed, total: passed + failed })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${String(passed).padStart(3)}/${String(passed + failed).padEnd(3)}  ${e.file}`)
  if (!ok) {
    // Only the failing lines and the tail: a full transcript per failure is
    // what makes a runner useless in a long session.
    for (const line of out.split('\n').filter(l => /^\s*FAIL\s/.test(l))) console.log(`        ${line.trim()}`)
    const tail = out.trim().split('\n').slice(-4)
    for (const line of tail) console.log(`        | ${line}`)
  }
}

const totalPassed = results.reduce((a, r) => a + r.passed, 0)
const totalFailed = results.reduce((a, r) => a + r.failed, 0)
// An experiment that dies before asserting anything reports zero of each, so
// counting assertions alone prints "0 failed" underneath a visible FAIL row.
const brokenRuns = results.filter(r => !r.ok && r.failed === 0)
writeFileSync(STATUS, JSON.stringify(
  { ranAt: new Date().toISOString(), checkout, skipped: skipped.map(e => e.file), results }, null, 2))
console.log(`\n合计 ${totalPassed} 通过, ${totalFailed} 失败`
  + (brokenRuns.length > 0 ? `,${brokenRuns.length} 个实验没跑起来(${brokenRuns.map(r => r.file).join(', ')})` : '')
  + (skipped.length > 0 ? `,跳过 ${skipped.length}` : '')
  + '  ->  STATUS.json')
process.exit(totalFailed === 0 && results.every(r => r.ok) ? 0 : 1)
