#!/usr/bin/env node
/**
 * External repair runner.
 *
 * A running DSH plugin must not reinstall the process that hosts it. This CLI
 * performs the installation-level transaction from a separate process:
 * validate the exact loader, stage or remove the declaration, run pnpm in the
 * resolved installation workspace, then verify the installed file. The Web UI
 * only reports state and hands this command to the user.
 *
 * @module @anweat/dsh-substrate/repair
 */
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  apply, revert, status, isPatchInstalled, PATCH_MARKER,
} from './patch-rpc.mjs'

export { PATCH_MARKER }

/**
 * Turn an internal transaction snapshot into action-oriented terminal copy.
 * State names stay an implementation detail; the operator sees what is true,
 * what remains, and whether a command is safe to run.
 *
 * @param {object} view Result of {@link status}.
 * @returns {string} Human-readable status without terminal styling.
 */
export function renderStatus(view) {
  const lines = [
    `DSH home: ${view.home}`,
    `修复目标: ${view.target}`,
  ]
  if (view.root !== undefined) lines.push(`安装工作区: ${view.root}`)
  if (view.actualVersion !== undefined) lines.push(`检测到 loader: ${view.actualVersion}`)

  switch (view.state) {
    case 'available':
      lines.push('状态:目标版本已确认,可以准备安装级修复。')
      lines.push(`下一步: ${view.commands.apply}`)
      break
    case 'install-required':
      lines.push('状态:修复声明已经准备,但依赖尚未重新链接。')
      lines.push(`继续: ${view.commands.apply}`)
      break
    case 'restart-required':
      lines.push('状态:补丁已经进入依赖,当前 DSH 仍运行旧代码。')
      lines.push('下一步:重启 DSH;新进程检测到修复代码后才算验证通过。')
      break
    case 'verified':
      lines.push('状态:当前 DSH 已从修复后的 loader 启动,验证通过。')
      lines.push(`如需撤销: ${view.commands.revert}`)
      break
    case 'removal-install-required':
      lines.push('状态:撤销声明已经完成,但依赖中仍有补丁。')
      lines.push(`继续撤销: ${view.commands.revert}`)
      break
    case 'removal-restart-required':
      lines.push('状态:补丁已经从依赖移除,当前 DSH 仍运行旧代码。')
      lines.push('下一步:重启 DSH;新进程确认补丁已移除后才算撤销完成。')
      break
    case 'version-mismatch':
      lines.push(`状态: loader 版本 ${view.actualVersion ?? '未知'} 与补丁目标 ${view.expectedVersion} 不一致。`)
      lines.push('未提供写入操作;请使用匹配版本,或等待针对当前 loader 验证的新补丁。')
      break
    case 'source':
      lines.push(`状态:当前 DSH 从源码工作区运行(${view.packageDir})。`)
      lines.push('pnpm 不会给工作区包应用 patchedDependencies,因此不提供安装级修复命令。')
      break
    case 'unresolved':
      lines.push(`状态:无法通过依赖回退链接定位 loader(${view.link})。`)
      lines.push('未猜测写入目标;请先修复 DSH 安装或依赖回退链接。')
      break
    default:
      lines.push('状态:无法识别,未提供写入操作。')
  }
  return lines.join('\n')
}

/** Run pnpm without constructing a shell command from a path. */
export function runPnpmInstall(root) {
  // Repair intentionally changes patchedDependencies and must update the lockfile,
  // including in CI where pnpm otherwise defaults to a frozen install.
  const child = spawnSync('pnpm', ['install', '--no-frozen-lockfile'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  return { ok: child.status === 0, code: child.status ?? 1 }
}

/**
 * Apply or remove the repair and relink the installation.
 *
 * @param {object} options
 * @param {string} options.home DSH home used to resolve the real installation.
 * @param {'apply'|'revert'} options.mode Transaction direction.
 * @param {string} [options.patchSource] Test/development patch source.
 * @param {(root: string) => {ok: boolean, code: number}} [options.runInstall]
 * @returns {Promise<object>} Outcome with separate staging and installation facts.
 */
export async function performRepair({ home, mode, patchSource, runInstall = runPnpmInstall }) {
  const before = status(home, { bootApplied: false })
  if (['source', 'unresolved', 'version-mismatch'].includes(before.state)) {
    return { ok: false, reason: before.state, before }
  }

  const staged = mode === 'apply' ? apply(home, patchSource) : revert(home)
  if (!staged.ok) return { ok: false, reason: staged.reason, before }

  const install = runInstall(staged.root)
  const after = status(home, { bootApplied: false })
  const installed = after.packageDir === undefined ? false : isPatchInstalled(after.packageDir)
  const expected = mode === 'apply'
  return {
    ok: install.ok && installed === expected,
    mode,
    root: staged.root,
    changed: staged.changed,
    install,
    installed,
    restartRequired: install.ok && installed === expected,
    after,
  }
}

function parseArgs(argv) {
  const mode = argv.includes('--revert') ? 'revert' : argv.includes('--apply') ? 'apply' : 'status'
  const homeAt = argv.indexOf('--home')
  return {
    mode,
    yes: argv.includes('--yes'),
    home: homeAt >= 0 && argv[homeAt + 1] !== undefined ? argv[homeAt + 1] : undefined,
  }
}

async function confirm(question) {
  if (!stdin.isTTY) return false
  const prompt = createInterface({ input: stdin, output: stdout })
  try {
    const answer = (await prompt.question(`${question} [y/N] `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    prompt.close()
  }
}

async function main(argv) {
  const args = parseArgs(argv.filter(arg => arg !== 'repair'))
  const home = args.home ?? (await import('@deepseek-ai/dsh-home-paths')).resolveDshHome()
  const view = status(home, { bootApplied: false })

  console.log(renderStatus(view))

  if (args.mode === 'status') return 0
  if (['source', 'unresolved', 'version-mismatch'].includes(view.state)) {
    console.error('当前环境不满足这份版本锁定修复的应用条件,未修改任何文件。')
    return 2
  }

  const verb = args.mode === 'apply' ? '写入兼容补丁并运行 pnpm install' : '撤销兼容补丁并运行 pnpm install'
  if (!args.yes && !await confirm(`${verb}?`)) {
    console.log('已取消,未修改任何文件。')
    return 1
  }

  const result = await performRepair({ home, mode: args.mode })
  if (!result.ok) {
    console.error(`修复事务未完成:${result.reason ?? `pnpm exit ${result.install?.code ?? 'unknown'}`}`)
    return 2
  }
  console.log(args.mode === 'apply'
    ? '依赖已重新链接并检测到补丁。请重启 DSH,由新进程完成最终验证。'
    : '依赖已重新链接且补丁已移除。请重启 DSH,由新进程完成最终验证。')
  return 0
}

const invoked = process.argv[1] !== undefined
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (invoked) process.exitCode = await main(process.argv.slice(2))
