/**
 * Where the patch declaration goes, and where it must not.
 *
 * The first version of this button wrote into the profile. That write
 * succeeded, warned about nothing, and patched nothing, because profiles do not
 * depend on the loader. The second failure mode is subtler and this suite
 * exists mostly for it: a dsh running from a source checkout resolves the
 * loader to a workspace package, and pnpm's `patchedDependencies` does not
 * apply to workspace packages at all — so a declaration written there is
 * accepted and ignored, exactly like the first bug wearing a different path.
 *
 * Both are silent. Nothing observable distinguishes "patched" from "wrote a
 * file nobody reads" except knowing which case you are in, so the classifier is
 * pinned here per case rather than exercised through one happy path.
 *
 * Run: node plugin/test/patch-target.spec.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePatchTarget, LOADER_PACKAGE } from '../src/patch-target.mjs'
import { status, apply, revert } from '../src/patch-rpc.mjs'
import { PATCH_FILE } from '../src/stage-patch.mjs'

let ok = 0, fail = 0
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const roots = []
const tempRoot = () => { const d = mkdtempSync(join(tmpdir(), 'dsh-substrate-target-')); roots.push(d); return d }
process.on('exit', () => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }) } catch { /* already gone */ } } })

/** A directory holding the patch file, standing in for the installed package's own. */
function patchSource() {
  const dir = join(tempRoot(), 'patches')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, PATCH_FILE), 'diff --git a/lib/index.js b/lib/index.js\n')
  return dir
}

/**
 * Build a home whose fallback link points where the caller says.
 * @param {string} target Directory the loader link resolves to.
 * @returns {string} the home.
 */
function homeLinking(target) {
  const home = tempRoot()
  const link = join(home, 'profiles', 'node_modules', ...LOADER_PACKAGE.split('/'))
  mkdirSync(join(link, '..'), { recursive: true })
  symlinkSync(target, link, 'junction')
  return home
}

console.log('\n=== 装出来的 loader:定位到它所属的工作区 ===')
{
  const source = join(tempRoot(), 'vendor', 'include')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: LOADER_PACKAGE, version: '1.0.6' }))
  const home = homeLinking(source)
  const view = status(home)
  check('alpha.1 源码安装仍显示实际 loader 版本', view.state === 'source' && view.actualVersion === '1.0.6' && view.target.endsWith('@1.0.6'))
  check('读取源码版本不会开放安装写入', apply(home).reason === 'source' && !existsSync(join(source, 'pnpm-workspace.yaml')))
}
{
  const root = tempRoot()
  const real = join(root, 'node_modules', '.pnpm', 'cordis-plugin-include@1.0.7', 'node_modules', LOADER_PACKAGE)
  mkdirSync(real, { recursive: true })
  writeFileSync(join(real, 'package.json'), JSON.stringify({ name: LOADER_PACKAGE, version: '1.0.7' }))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  const found = resolvePatchTarget(homeLinking(real))
  check('判为 installed', found.kind === 'installed', found.kind)
  // pnpm 的真实布局里 node_modules 是嵌套的;取最外层那个,取内层会指到 store 条目而不是工作区。
  check('取的是最外层 node_modules 的父目录,不是 store 条目', found.root === root, `${found.root} != ${root}`)
}

console.log('\n=== 源码 checkout 的 loader:拒绝,不写 ===')
{
  const checkout = tempRoot()
  const real = join(checkout, 'vendor', 'include')
  mkdirSync(real, { recursive: true })
  writeFileSync(join(checkout, 'pnpm-workspace.yaml'), 'packages:\n  - vendor/*\n')
  const home = homeLinking(real)
  const found = resolvePatchTarget(home)
  check('判为 source —— 上层没有 node_modules', found.kind === 'source', found.kind)
  check('状态报 source', status(home).state === 'source')
  const result = apply(home, patchSource())
  check('apply 拒绝', result.ok === false && result.reason === 'source', JSON.stringify(result))
  check('清单没有被动过', !readFileSync(join(checkout, 'pnpm-workspace.yaml'), 'utf8').includes('patchedDependencies'))
  check('没有留下 patches 目录', !existsSync(join(checkout, 'patches')))
}

console.log('\n=== 找不到 loader:如实说,不猜 ===')
{
  const home = tempRoot()
  const found = resolvePatchTarget(home)
  check('判为 unresolved', found.kind === 'unresolved', found.kind)
  check('把找过的位置说出来', String(found.link).includes('cordis-plugin-include'), found.link)
  check('apply 拒绝', apply(home, patchSource()).ok === false)
}

console.log('\n=== 写入:声明和补丁文件都落到那个工作区 ===')
{
  const root = tempRoot()
  const real = join(root, 'node_modules', LOADER_PACKAGE)
  mkdirSync(real, { recursive: true })
  writeFileSync(join(real, 'package.json'), JSON.stringify({ name: LOADER_PACKAGE, version: '1.0.7' }))
  mkdirSync(join(real, 'lib'), { recursive: true })
  writeFileSync(join(real, 'lib', 'index.js'), 'export function applyEntryPatches() {}\n')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - '.'\nnodeLinker: hoisted\n")
  const home = homeLinking(real)

  check('写之前是 available', status(home).state === 'available')
  const first = apply(home, patchSource())
  check('写成功', first.ok === true && first.changed === true, JSON.stringify(first))

  const manifest = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  check('声明进了 pnpm-workspace.yaml', manifest.includes('patchedDependencies'))
  check('别人的键还在 —— 追加而不是重写', manifest.includes('nodeLinker: hoisted'))
  check('补丁文件也到位', existsSync(join(root, 'patches', PATCH_FILE)))
  check('写完状态转为 install-required', status(home).state === 'install-required')
  check('给出的下一步是 pnpm install', status(home).install === 'pnpm install')

  const second = apply(home, patchSource())
  check('再按一次不重复写', second.ok === true && second.changed === false, JSON.stringify(second))
  check('清单里只有一个声明块',
    readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').split('patchedDependencies').length === 2)

  const undone = revert(home)
  check('撤销报告改动了', undone.ok === true && undone.changed === true)
  check('声明没了', !readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').includes('patchedDependencies'))
  check('别人的键仍然在', readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').includes('nodeLinker: hoisted'))
  check('补丁文件也删了', !existsSync(join(root, 'patches', PATCH_FILE)))
  check('状态转回 available', status(home).state === 'available')
}

console.log('\n=== 状态里带上路径,好让人自己核对 ===')
{
  const root = tempRoot()
  const real = join(root, 'node_modules', LOADER_PACKAGE)
  mkdirSync(real, { recursive: true })
  writeFileSync(join(real, 'package.json'), JSON.stringify({ name: LOADER_PACKAGE, version: '1.0.7' }))
  const view = status(homeLinking(real))
  check('给出工作区', typeof view.root === 'string' && view.root.length > 0, view.root)
  check('给出 loader 的真实位置', typeof view.packageDir === 'string' && view.packageDir.includes('cordis-plugin-include'), view.packageDir)
  check('给出被打补丁的包名版本', view.target.includes('@1.0.7'), view.target)
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
