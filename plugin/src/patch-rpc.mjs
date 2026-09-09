/**
 * Read-only RPC behind the compatibility card.
 * RC uses the per-channel loopback policy. Alpha Connection applies its
 * Host/Origin fence and authenticated browser session to every channel;
 * the legacy third argument is ignored there. No write endpoint is mounted.
 *
 * The card runs in a browser and the write lands on the machine running dsh, so
 * the card needs a Host endpoint. It carries `status`; installation changes
 * are deliberately made by the external `dsh-substrate repair` process.
 *
 * The underlying apply helper refuses more often than it writes, and every refusal names a
 * situation where writing would look like it worked. The rule the endpoint
 * enforces is that a declaration is only worth writing where pnpm will read it
 * AND act on it — see `patch-target.mjs` for why those are two different
 * questions.
 *
 * @module @anweat/dsh-substrate/patch-rpc
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePatchTarget } from './patch-target.mjs'
import { isStaged, stage, unstage, PATCH_TARGET, PATCH_FILE, PATCH_VERSION, patchFor } from './stage-patch.mjs'
import { PACKAGE_SPEC } from './package-spec.mjs'

/** Exact read-only route carried by Connection's shared authenticated API. */
export const STATUS_ROUTE = '/api/dsh-substrate/status'

/** Stable source marker inserted by the version-locked loader patch. */
export const PATCH_MARKER = '// dsh-substrate entry-id repair v4'

/** Whether the loader currently present on disk carries this exact repair. */
export function isPatchInstalled(packageDir) {
  const entry = join(packageDir, 'lib', 'index.js')
  if (!existsSync(entry)) return false
  try {
    return readFileSync(entry, 'utf8').includes(PATCH_MARKER)
  } catch {
    return false
  }
}

/**
 * What the card renders, in one read.
 *
 * @param {string} home The Harness home.
 * @param {{ bootApplied?: boolean }} [options] What the currently running Host
 *   loaded at boot. Keeping it fixed across calls distinguishes a file changed
 *   underneath the process from a repair the process has actually loaded.
 * @returns {object} Transaction state plus the paths and exact target version.
 */
export function status(home, options = {}) {
  const found = resolvePatchTarget(home)
  const patch = typeof found.version === 'string' ? patchFor(found.version) : undefined
  const homeArg = home.includes('"') ? '' : ` --home "${home}"`
  const common = {
    home,
    target: patch?.target ?? (found.packageName ? `${found.packageName}@${found.version ?? 'unknown'}` : PATCH_TARGET),
    expectedVersion: patch?.version ?? (found.packageName ? '0.1.2-alpha.2 - 0.1.5-alpha.1 (audited releases only)' : PATCH_VERSION),
    file: patch?.file ?? PATCH_FILE,
    install: 'pnpm install',
    commands: {
      apply: `npx --yes ${PACKAGE_SPEC} repair --apply${homeArg}`,
      revert: `npx --yes ${PACKAGE_SPEC} repair --revert${homeArg}`,
    },
  }
  if (found.kind === 'unresolved') return { state: 'unresolved', link: found.link, ...common }
  if (found.kind === 'source') return { state: 'source', packageDir: found.packageDir, actualVersion: found.version, ...common }

  const installed = isPatchInstalled(found.packageDir)
  const bootApplied = options.bootApplied ?? installed
  const declared = isStaged(found.root, found.version)
  if (!patch) {
    return {
      state: 'version-mismatch', root: found.root, packageDir: found.packageDir,
      actualVersion: found.version, declared, installed, bootApplied, ...common,
    }
  }

  let state
  if (declared) {
    if (!installed) state = 'install-required'
    else state = bootApplied ? 'verified' : 'restart-required'
  } else if (installed) {
    state = 'removal-install-required'
  } else if (bootApplied) {
    state = 'removal-restart-required'
  } else {
    state = 'available'
  }
  return {
    state,
    root: found.root,
    packageDir: found.packageDir,
    actualVersion: found.version,
    declared,
    installed,
    bootApplied,
    ...common,
  }
}

/**
 * Write the declaration and the patch file, or say why not.
 *
 * @param {string} home The Harness home.
 * @param {string} [patchSource] Directory holding the `.patch`; defaults to this package's.
 * @returns {{ ok: true, changed: boolean, manifest: string, install: string }
 *   | { ok: false, reason: 'source' | 'unresolved' }}
 *   `changed: false` means the declaration was already there — the endpoint is
 *   idempotent, so a second press reports rather than duplicating the block.
 */
export function apply(home, patchSource) {
  const found = resolvePatchTarget(home)
  if (found.kind !== 'installed') return { ok: false, reason: found.kind }
  if (typeof found.version !== 'string' || !patchFor(found.version)) return { ok: false, reason: 'version-mismatch' }
  const written = stage(found.root, patchSource, found.version)
  return { ok: true, changed: written.changed, root: found.root, manifest: written.manifest, install: written.install }
}

/**
 * Take the declaration back out.
 *
 * @param {string} home The Harness home.
 * @returns {{ ok: true, changed: boolean, install: string } | { ok: false, reason: 'source' | 'unresolved' }}
 */
export function revert(home) {
  const found = resolvePatchTarget(home)
  if (found.kind !== 'installed') return { ok: false, reason: found.kind }
  if (typeof found.version !== 'string' || !patchFor(found.version)) return { ok: false, reason: 'version-mismatch' }
  return { ok: true, root: found.root, ...unstage(found.root, found.version) }
}

/**
 * Mount the channel while a connection service exists.
 *
 * @param {object} ctx The plugin's own Context.
 * @param {string} home The Harness home.
 * @returns {void}
 */
export function registerPatchRpc(ctx, home) {
  const initial = status(home)
  const bootApplied = initial.bootApplied === true
  const currentStatus = () => status(home, { bootApplied })
  ctx.inject(['connection'], (connectionCtx) => {
    // DSH 0.1.5 made WebServer an optional Connection transport. A dedicated
    // channel registered before that transport appears has no physical route.
    // The exact Fetch registry is carrier-neutral and joins /api whenever the
    // browser transport exists; registering only this path also keeps every
    // installation write endpoint absent.
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: STATUS_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const rpcId = typeof body === 'object' && body !== null && typeof body.rpcId === 'string'
          ? body.rpcId
          : 'invalid-request'
        if (typeof body !== 'object' || body === null || body.type !== 'client-request'
          || body.method !== 'dsh-substrate/status') {
          return Response.json({
            type: 'server-response', rpcId,
            result: { ok: false, error: { code: 'gateway/bad-request', message: 'invalid status request', details: {} } },
          })
        }
        try {
          return Response.json({
            type: 'server-response', rpcId,
            result: { ok: true, value: currentStatus() },
          })
        } catch (error) {
          return Response.json({
            type: 'server-response', rpcId,
            result: { ok: false, error: { code: 'gateway/bad-request', message: String(error instanceof Error ? error.message : error).slice(0, 500), details: {} } },
          })
        }
      },
    }), 'dsh-substrate: patch RPC')
  })
}
