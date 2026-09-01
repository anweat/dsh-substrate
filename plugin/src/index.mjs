/**
 * The substrate plugin: reports the contention a booted tree can still see.
 *
 * It deliberately does very little. Everything it could usefully *decide* is
 * decided before it exists — a duplicate entry id is rejected during
 * `mountRootInclude`, with zero plugins mounted — so a row that promised to fix
 * that would be promising something its position rules out. That belongs to
 * `dsh-substrate-check`, which runs before boot.
 *
 * What is still visible from here is tool-name contention, because tools
 * register while entries apply. Even that has a timing limit worth stating:
 * Cordis activates a plugin as soon as its injected services exist, which is
 * before the packages that register into them have run. So this reports at
 * `ready`, not during `apply`, and says so rather than reporting an empty
 * registry as a clean bill of health.
 *
 * @module @anweat/dsh-substrate
 */

export const name = 'dsh-substrate'
export const inject = ['tools']

/**
 * Tool names that are reserved outright and cannot be layered or shadowed.
 * Registering one throws regardless of scope, so a report that stayed quiet
 * about it would be describing a composition that cannot exist.
 */
const RESERVED = Object.freeze(['run_code'])

/**
 * Mount the reporter.
 *
 * @param {object} ctx Plugin context; needs `tools`.
 * @param {object} [config] `{ log }` — where the report goes; defaults to the context logger.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const log = config.log ?? (line => { ctx.logger?.info?.(line) ?? console.log(line) })

  // Not in the body of `apply`: at apply time the tool registry is typically
  // empty, because this plugin activates the moment `tools` exists and the
  // packages that fill it have not run yet. Reporting then would report nothing
  // and call it clean.
  //
  // Cordis has no "the tree has settled" event, so this waits for `internal/status`
  // to go quiet instead. That is a heuristic, not a guarantee: a fiber that
  // activates after the quiet window is missed, and the report says how many
  // entries it saw so a reader can tell when that has happened.
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
    // A registry that reached here at all means no duplicate threw, so the
    // useful statement is about what this vantage point cannot see.
    log(`  基于 ${statusEvents} 次 fiber 状态变化后的静默窗口 —— 这是启发式,不是"全部就绪"的保证。`)
    log('  entry id / 路由 / 槽位的争用发生在本插件挂载之前,这里看不到;用 dsh-substrate-check 在启动前查。')
  }

  ctx.on('internal/status', () => {
    statusEvents += 1
    clearTimeout(settle)
    settle = setTimeout(report, config.settleMs ?? 250)
    settle.unref?.()
  })
  ctx.effect(() => () => { clearTimeout(settle) }, 'dsh-substrate: settle timer')
}
