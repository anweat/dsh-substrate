/**
 * Staging tests.
 *
 * Two properties carry this module. It must not damage a workspace manifest it
 * shares with DSH and the user, and turning the setting off must give back
 * exactly what turning it on took — otherwise "reversible" is a claim rather
 * than a fact, and nobody will believe the switch.
 *
 * Run: node plugin/test/stage-patch.spec.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stage, unstage, isStaged, PATCH_FILE, PATCH_TARGET } from '../src/stage-patch.mjs'

let ok = 0, fail = 0
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/** A profile whose manifest already carries DSH's keys and a user's own. */
const MANAGED = `packages:
  - '.'
nodeLinker: hoisted
autoInstallPeers: false
strictDepBuilds: false
# a line the user added themselves
minimumReleaseAge: 1440
`

function profile() {
  const dir = mkdtempSync(join(tmpdir(), 'stage-'))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), MANAGED)
  const source = join(dir, 'src-patches')
  mkdirSync(source)
  writeFileSync(join(source, PATCH_FILE), '--- a/lib/index.js\n+++ b/lib/index.js\n')
  return { dir, source }
}

console.log('\n=== 启用 ===')
{
  const { dir, source } = profile()
  check('启用前未就位', !isStaged(dir))
  const result = stage(dir, source)
  check('报告发生了改动', result.changed)
  check('就位了', isStaged(dir))

  const manifest = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
  check('声明写进 pnpm-workspace.yaml', manifest.includes('patchedDependencies:'), manifest)
  check('目标带版本号 —— 版本一变 pnpm 会拒绝而不是静默失效',
    manifest.includes(PATCH_TARGET), manifest)
  check('补丁文件被复制进 profile', existsSync(join(dir, 'patches', PATCH_FILE)))
  check('给出下一步该跑什么', /install/.test(result.install), result.install)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n=== 不破坏别人的内容 ===')
{
  const { dir, source } = profile()
  stage(dir, source)
  const manifest = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
  check('DSH 管理的三个键都还在',
    manifest.includes('nodeLinker: hoisted')
    && manifest.includes('autoInstallPeers: false')
    && manifest.includes('strictDepBuilds: false'), manifest)
  check('用户自己加的行也还在', manifest.includes('minimumReleaseAge: 1440'), manifest)
  check('packages 列表没被动', manifest.includes("- '.'"), manifest)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n=== 关闭要能完全还原 ===')
{
  const { dir, source } = profile()
  const before = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
  stage(dir, source)
  const removal = unstage(dir)
  check('报告发生了移除', removal.changed)
  check('不再就位', !isStaged(dir))
  check('补丁文件被删掉', !existsSync(join(dir, 'patches', PATCH_FILE)))

  const after = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
  check('清单逐字还原 —— 可逆不是说说而已',
    after.trim() === before.trim(), JSON.stringify({ before: before.trim(), after: after.trim() }))
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n=== 幂等 ===')
{
  const { dir, source } = profile()
  stage(dir, source)
  const again = stage(dir, source)
  check('重复启用不再改动', !again.changed)
  const manifest = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
  check('声明只出现一次 —— 追加式写入最容易在这里出事',
    manifest.split('patchedDependencies:').length - 1 === 1, manifest)

  unstage(dir)
  check('重复关闭不报错也不再改动', !unstage(dir).changed)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n=== 边界 ===')
{
  const { dir, source } = profile()
  rmSync(join(dir, 'pnpm-workspace.yaml'))
  const result = stage(dir, source)
  check('清单不存在时也能建起来', result.changed && isStaged(dir))
  rmSync(dir, { recursive: true, force: true })

  const missing = profile()
  rmSync(join(missing.source, PATCH_FILE))
  let threw = false
  try { stage(missing.dir, missing.source) } catch { threw = true }
  check('找不到补丁文件时抛错,而不是写一个指向空气的声明', threw)
  check('抛错后清单没有被改动',
    !readFileSync(join(missing.dir, 'pnpm-workspace.yaml'), 'utf8').includes('patchedDependencies'))
  rmSync(missing.dir, { recursive: true, force: true })
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
