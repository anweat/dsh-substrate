/**
 * Dependency-free early row for the tool runtime fallback.
 *
 * Loader siblings start concurrently. This row listens for the ToolRuntime
 * fiber before its constructor runs, and also handles the case where the tools
 * service already exists. Exact-version boot integration remains the only way
 * to guarantee ordering before every third-party row.
 */
import {
  installToolConflictPrefixing,
  installToolConflictPrefixingPrototype,
  toolConflictStore,
} from './tool-conflicts.mjs'

export const name = 'dsh-substrate/tool-prefix-bootstrap'
export const inject = []

export function apply(ctx) {
  const store = toolConflictStore(ctx)
  let restore
  const installRuntime = (runtime) => {
    if (restore !== undefined || !runtime || typeof runtime.register !== 'function') return
    restore = installToolConflictPrefixing(runtime, store)
  }
  try { installRuntime(ctx.get?.('tools')) } catch {}

  const stopListening = ctx.on('internal/plugin', (fiber) => {
    if (restore !== undefined) return
    const callback = fiber?.runtime?.callback
    const proto = callback?.prototype
    if (callback?.name !== 'ToolRuntime' || typeof proto?.register !== 'function' || typeof proto?.schemas !== 'function') return
    restore = installToolConflictPrefixingPrototype(proto, store)
  }, { prepend: true })

  return () => {
    stopListening?.()
    restore?.()
  }
}
