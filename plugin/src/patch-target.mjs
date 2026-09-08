/**
 * Find the workspace whose `pnpm install` would actually patch the loader.
 *
 * This module exists because the obvious answer is wrong. A profile looks like
 * the place to declare `patchedDependencies` — it has its own
 * `pnpm-workspace.yaml` and its own `node_modules` — and declaring it there
 * installs cleanly, warns about nothing, and patches nothing. Profiles do not
 * depend on the loader. `healProfilesModuleFallback` maintains
 * `$DSH_HOME/profiles/node_modules/<pkg>` as a symlink per package in the dsh
 * app's dependency closure, each pointing at that package's real directory
 * inside the dsh installation, and Node's parent-directory walk finds it from
 * any profile. So the loader a profile runs is never the profile's own.
 *
 * Following that symlink is what makes the write addressable: its target is
 * inside the installation, and the installation's root is the workspace whose
 * manifest pnpm reads.
 *
 * @module @anweat/dsh-substrate/patch-target
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

/** The package the diff patches; the loader half that rejects duplicate ids. */
export const LOADER_PACKAGE = '@deepseek-ai/cordis-plugin-include'
/** Published alpha boot bundles embed Include; patch the code that actually boots. */
export const BOOT_PACKAGE = '@deepseek-ai/dsh-app-boot'

/**
 * Where a patch declaration would have to go for this dsh to pick it up.
 *
 * @param {string} home The Harness home (`$DSH_HOME`).
 * @returns {{ kind: 'installed', root: string, packageDir: string, version?: string }
 *   | { kind: 'source', packageDir: string, version?: string }
 *   | { kind: 'unresolved', link: string }}
 *   `installed` carries the workspace root to write to. `source` means this dsh
 *   runs from a checkout, where the loader is a workspace package and pnpm's
 *   `patchedDependencies` does not apply to it at all. `unresolved` means the
 *   fallback link is absent, so nothing here can be claimed.
 */
export function resolvePatchTarget(home) {
  const bootLink = join(home, 'profiles', 'node_modules', ...BOOT_PACKAGE.split('/'))
  const link = existsSync(bootLink) ? bootLink : join(home, 'profiles', 'node_modules', ...LOADER_PACKAGE.split('/'))
  if (!existsSync(link)) return { kind: 'unresolved', link }

  const packageDir = realpathSync(link)
  const root = installRootOf(packageDir)
  // No `node_modules` above it means the loader is a source directory in a
  // checkout, not an installed dependency. pnpm patches registry packages; a
  // declaration naming a workspace package is accepted and does nothing, which
  // is precisely the silent no-op this module exists to prevent.
  let version
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    if (typeof manifest.version === 'string') version = manifest.version
  } catch {
    // Missing or malformed metadata is reported by the caller as an unsupported
    // target. The resolver still returns the paths it proved, so the UI can
    // explain what it found instead of collapsing into "unresolved".
  }
  const metadata = { packageDir, ...(version === undefined ? {} : { version }),
    ...(link === bootLink ? {packageName: BOOT_PACKAGE} : {}) }
  if (root === undefined) return { kind: 'source', ...metadata }
  return { kind: 'installed', root, ...metadata }
}

/**
 * The install root above a resolved package directory.
 *
 * The OUTERMOST `node_modules` ancestor is the one that matters: pnpm's real
 * layout nests a second one (`<root>/node_modules/.pnpm/<pkg>@<v>/node_modules/<pkg>`),
 * and stopping at the innermost would name the store entry rather than the
 * workspace whose manifest pnpm reads.
 *
 * @param {string} packageDir Absolute, symlink-resolved package directory.
 * @returns {string | undefined} The workspace root, or undefined when the
 *   directory sits outside any `node_modules`.
 */
function installRootOf(packageDir) {
  let root
  for (let dir = packageDir, parent = dirname(dir); parent !== dir; dir = parent, parent = dirname(dir)) {
    if (dir.endsWith(`${sep}node_modules`) || dir.endsWith('/node_modules')) root = parent
  }
  return root
}
