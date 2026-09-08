/**
 * Installation-level repair transaction tests.
 *
 * A pnpm patch is not a settings toggle: declaration, dependency relink,
 * process restart, and runtime verification are four different facts. This
 * suite pins those boundaries so the UI cannot call "written" "fixed".
 *
 * Run: node plugin/test/repair.spec.mjs
 */
import {
  existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { status, apply, revert } from '../src/patch-rpc.mjs'
import { PATCH_FILE, patchFor } from '../src/stage-patch.mjs'
import { PATCH_MARKER, performRepair, renderStatus } from '../src/repair.mjs'
import { LOADER_PACKAGE } from '../src/patch-target.mjs'

let ok = 0, fail = 0
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const roots = []
const tempRoot = () => { const d = mkdtempSync(join(tmpdir(), 'dsh-substrate-repair-')); roots.push(d); return d }
process.on('exit', () => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

console.log('\n=== npm 包可独立调用修复 CLI ===')
{
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const peers = Object.keys(packageJson.peerDependencies)
  check('所有 DSH 运行时 peer 都是 optional', peers.every(name => packageJson.peerDependenciesMeta?.[name]?.optional === true))
  check('npm 包包含独立安装说明', packageJson.files.includes('README.md') && existsSync(new URL('../README.md', import.meta.url)))
}

function fixture(version = '1.0.7') {
  const root = tempRoot()
  const real = join(root, 'node_modules', LOADER_PACKAGE)
  mkdirSync(join(real, 'lib'), { recursive: true })
  writeFileSync(join(real, 'package.json'), JSON.stringify({ name: LOADER_PACKAGE, version }))
  writeFileSync(join(real, 'lib', 'index.js'), 'export function applyEntryPatches() {}\n')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - '.'\nnodeLinker: hoisted\n")

  const home = tempRoot()
  const link = join(home, 'profiles', 'node_modules', ...LOADER_PACKAGE.split('/'))
  mkdirSync(join(link, '..'), { recursive: true })
  symlinkSync(real, link, 'junction')

  const patchSource = join(tempRoot(), 'patches')
  mkdirSync(patchSource, { recursive: true })
  writeFileSync(join(patchSource, PATCH_FILE), '--- a/lib/index.js\n+++ b/lib/index.js\n')
  return { root, real, home, patchSource }
}

const markApplied = real => writeFileSync(join(real, 'lib', 'index.js'), `${PATCH_MARKER}\n`)
const markRemoved = real => writeFileSync(join(real, 'lib', 'index.js'), 'export function applyEntryPatches() {}\n')

console.log('\n=== 修复是事务,不是开关 ===')
for (const version of ['1.0.6', '1.0.7']) {
  const f = fixture(version)
  const patch = patchFor(version)
  const before = status(f.home, { bootApplied: false })
  check(`${version}: 精确选择目标与补丁文件`, before.state === 'available'
    && before.target === patch.target && before.file === patch.file)
  const result = await performRepair({ home: f.home, mode: 'apply', runInstall(root) {
    const manifest = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
    check(`${version}: 声明指向匹配版本`, manifest.includes(patch.target) && manifest.includes(patch.file))
    check(`${version}: 分发补丁有真实修复代码`, readFileSync(join(root, 'patches', patch.file), 'utf8').includes(PATCH_MARKER))
    markApplied(f.real)
    return { ok: true, code: 0 }
  } })
  check(`${version}: 重链后等待新 Host`, result.ok && result.after.state === 'restart-required')
  const removed = await performRepair({ home: f.home, mode: 'revert', runInstall() {
    markRemoved(f.real)
    return { ok: true, code: 0 }
  } })
  check(`${version}: 撤销成功`, removed.ok && removed.after.state === 'available')
}
check('未知 loader 不以版本范围推断兼容', patchFor('1.0.8') === undefined && patchFor('1.0.7-alpha.1') === undefined)
{
  const f = fixture()
  check('初始状态是可准备修复', status(f.home, { bootApplied: false }).state === 'available')

  apply(f.home, f.patchSource)
  check('只写声明后等待 pnpm install', status(f.home, { bootApplied: false }).state === 'install-required')

  markApplied(f.real)
  check('文件已安装但当前进程未加载时等待重启', status(f.home, { bootApplied: false }).state === 'restart-required')
  check('重启后的 Host 才能报告已验证', status(f.home, { bootApplied: true }).state === 'verified')

  revert(f.home)
  check('撤销声明后仍需重新安装', status(f.home, { bootApplied: true }).state === 'removal-install-required')
  markRemoved(f.real)
  check('补丁已移出磁盘但旧进程仍需重启', status(f.home, { bootApplied: true }).state === 'removal-restart-required')
  check('重启后回到可准备状态', status(f.home, { bootApplied: false }).state === 'available')
}

console.log('\n=== 版本不匹配要在写之前拒绝 ===')
{
  const f = fixture('1.0.8')
  const view = status(f.home, { bootApplied: false })
  check('明确报告版本不匹配', view.state === 'version-mismatch', JSON.stringify(view))
  const result = apply(f.home, f.patchSource)
  check('不写入错误版本的工作区', result.ok === false && result.reason === 'version-mismatch', JSON.stringify(result))
  check('清单保持未修改', !readFileSync(join(f.root, 'pnpm-workspace.yaml'), 'utf8').includes('patchedDependencies'))
}

console.log('\n=== 外部执行器负责重新链接依赖 ===')
{
  const f = fixture()
  let installRoot
  const result = await performRepair({
    home: f.home,
    mode: 'apply',
    patchSource: f.patchSource,
    runInstall(root) { installRoot = root; markApplied(f.real); return { ok: true, code: 0 } },
  })
  check('安装发生在解析出的真实工作区', installRoot === f.root, `${installRoot} != ${f.root}`)
  check('事务结束时磁盘补丁已可验证', result.ok === true && result.installed === true, JSON.stringify(result))
  check('声明仍保留以供后续安装复现', status(f.home, { bootApplied: false }).state === 'restart-required')
}

console.log('\n=== 命令行说明使用用户语义 ===')
{
  const f = fixture()
  const available = renderStatus(status(f.home, { bootApplied: false }))
  check('可执行状态给出明确动作', /可以准备安装级修复/.test(available))
  check('可执行状态给出完整命令', /npx --yes @anweat\/dsh-substrate@0\.1\.1 repair --apply/.test(available))

  const source = renderStatus({
    ...status(f.home, { bootApplied: false }),
    state: 'source',
    packageDir: 'D:\\source\\vendor\\include',
    root: undefined,
  })
  check('源码状态说明为什么不适用', /源码工作区/.test(source) && /不提供安装级修复/.test(source))
  check('源码状态不诱导执行修复', !/repair --apply/.test(source))
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
