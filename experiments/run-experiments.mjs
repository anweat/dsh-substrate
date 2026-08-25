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
import { readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  { file: 'lab-client-priority.ts', asks: 'BootPluginRow 带 priority 后,前端争用能否从整包禁用变成槽位让位', phase: 'P3.5' },
  { file: 'lab-panel.ts', asks: '面板脚手架在真 SlotRegistry/WebServer/connection 上:身份是否跟随调用方 ctx、派生通道能否让同名面板共存', phase: 'L4' },
  { file: 'lab-no-restart.ts', asks: '改补丁层要不要重启、爆炸半径多大、浏览器那一侧收不收得到名册变更', phase: 'P3.6' },
]

const args = process.argv.slice(2)
const filter = args.find(a => !a.startsWith('--'))

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

const targets = REGISTRY.filter(e => filter === undefined || e.file.includes(filter))
if (targets.length === 0) {
  console.error(`没有匹配 "${filter}" 的实验;用 --list 看注册表`)
  process.exit(1)
}

const results = []
for (const e of targets) {
  const run = spawnSync(process.execPath, ['--import', 'tsx/esm', e.file], {
    cwd: here, encoding: 'utf8', timeout: 180000,
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
writeFileSync(STATUS, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2))
console.log(`\n合计 ${totalPassed} 通过, ${totalFailed} 失败  ->  STATUS.json`)
process.exit(totalFailed === 0 && results.every(r => r.ok) ? 0 : 1)
