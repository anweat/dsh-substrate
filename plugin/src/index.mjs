/**
 * The substrate plugin, host half.
 *
 * It reports, and that is all it does. Everything it could usefully *decide* is
 * decided before it exists — a duplicate entry id is rejected during
 * `mountRootInclude` with zero plugins mounted — so a row promising to fix that
 * would be promising something its position rules out.
 *
 * It also exposes a read-only repair-status endpoint for the settings card.
 * The browser never changes dependencies: `patch-target.mjs` follows the
 * profile's fallback link to the workspace pnpm actually reads, and an
 * external `dsh-substrate repair` process performs the version-locked install
 * transaction. A restarted Host is the authority for final verification.
 *
 * @module @anweat/dsh-substrate
 */

import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { PATCH_TARGET, PATCH_FILE } from './stage-patch.mjs'
import { registerPatchRpc } from './patch-rpc.mjs'

export const name = 'dsh-substrate'
export const inject = ['tools']

/** The settings-document section and the settings-card key are the same name. */
export const SETTINGS_NAMESPACE = 'dsh-substrate'

/**
 * The quiet window, in milliseconds, that stands in for "the tree has settled".
 *
 * Deployment-varying rather than a constant: the window has to outlast the
 * gap between two fibers activating, and that gap tracks machine speed and
 * profile size. Too short and the report describes a half-built tree; too
 * long and it lands after the reader has moved on.
 */
export const Config = z.object({
  settleMs: z.natural().default(250).description('fiber 状态安静多久后出报告（毫秒）'),
})

/**
 * Where the loader patch has to be declared. The card reads the same facts
 * from the `status` endpoint; users do not need to find or edit this path.
 */
export const PATCH_DECLARATION = Object.freeze({
  /** The patched package, pinned to the version the diff was generated against. */
  target: PATCH_TARGET,
  /** The diff's file name. */
  file: PATCH_FILE,
  /** The workspace that installs dsh — never a profile. */
  where: '安装 dsh 的那个工作区的 pnpm-workspace.yaml',
})

/**
 * Tool names reserved outright, which no layering can take. A report that
 * stayed quiet about one would be describing a composition that cannot exist.
 */
const RESERVED = Object.freeze(['run_code'])

/**
 * Mount the reporter.
 *
 * @param {object} ctx Plugin context; needs `tools`.
 * @param {object} [config] Composition entry; `settleMs` is a {@link Config}
 * field, `log` and `home` test seams that are not part of the schema.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const log = config.log ?? (line => { ctx.logger?.info?.(line) ?? console.log(line) })

  // Registering the namespace is what puts the card on the plugin-settings tab.
  // `ConfigurablePluginsTabController` renders the intersection of two ledgers:
  // the namespaces the Host serves and the cards registered into
  // `settings.plugin.item`. A card whose key no Host namespace matches is
  // dropped with no error and no log line, so a browser half without this is a
  // browser half that silently does not appear.
  // Only the schema's own field goes into `base`; `log` is a test seam and
  // would not survive validation.
  const entry = config.settleMs === undefined ? {} : { settleMs: config.settleMs }
  registerPatchRpc(ctx, config.home ?? resolveDshHome())

  let source = () => entry
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, {
      base: entry,
      // Re-read on every use below, so a committed change reaches the next
      // report rather than waiting for a restart.
      applies: 'live',
    })
    source = () => scope.get()
  })

  // Not in the body of `apply`: at apply time the tool registry is typically
  // empty, because this plugin activates the moment `tools` exists and the
  // packages that fill it have not run yet. Reporting then would report nothing
  // and call it clean.
  //
  // Cordis has no "the tree has settled" event, so this waits for
  // `internal/status` to go quiet instead. That is a heuristic, not a
  // guarantee: a fiber that activates after the quiet window is missed, and the
  // report says how many it saw so a reader can tell when that has happened.
  let settle
  let statusEvents = 0
  const report = () => {
    const schemas = typeof ctx.tools?.schemas === 'function' ? ctx.tools.schemas() : []
    const names = schemas.map(s => s.name)
    const seen = new Set()
    const duplicated = new Set()
    for (const n of names) {
      if (seen.has(n)) duplicated.add(n)
      seen.add(n)
    }

    log(`dsh-substrate: ${names.length} 个工具在全局命名空间,${duplicated.size} 个重名`)
    for (const n of duplicated) log(`  重名: ${n}`)
    for (const n of RESERVED) {
      if (seen.has(n)) log(`  保留名 ${n} 已被占用 —— 它不接受任何分层`)
    }
    log(`  基于 ${statusEvents} 次 fiber 状态变化后的静默窗口 —— 这是启发式,不是"全部就绪"的保证。`)
    log('  entry id / 路由 / 槽位的争用发生在本插件挂载之前,这里看不到;用 dsh-substrate-check 在启动前查。')
  }

  ctx.on('internal/status', () => {
    statusEvents += 1
    clearTimeout(settle)
    settle = setTimeout(report, source().settleMs ?? 250)
    settle.unref?.()
  })
  ctx.effect(() => () => { clearTimeout(settle) }, 'dsh-substrate: settle timer')
}
