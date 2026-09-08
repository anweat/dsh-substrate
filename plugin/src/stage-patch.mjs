/**
 * Write the loader patch into a pnpm workspace, or take it back out.
 *
 * Which workspace is not this module's decision — `patch-target.mjs` resolves
 * it, and getting it wrong is silent: a declaration in a profile is accepted by
 * pnpm and patches nothing, because profiles do not depend on the loader.
 *
 * Nothing here runs a package manager. Writing the declaration and applying it
 * are different acts: pnpm applies `patchedDependencies` while it links
 * packages, so the patch takes effect at the next install and not before.
 * Running that install would mean a plugin reinstalling the dsh that hosts it,
 * from inside that dsh; reporting the command instead keeps the act with the
 * person who can see what it will touch.
 *
 * @module @anweat/dsh-substrate/stage-patch
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The patched package, pinned to the version the diff was generated against. */
export const PATCH_TARGET = '@deepseek-ai/cordis-plugin-include@1.0.7'
/** Exact loader version the patch was generated against. */
export const PATCH_VERSION = '1.0.7'
/** File name under the profile's `patches/`, and under this package's. */
export const PATCH_FILE = '@deepseek-ai__cordis-plugin-include@1.0.7.patch'

/** Audited release artifacts only; do not widen this to a semver range. */
export function patchFor(version = PATCH_VERSION) {
  if (['0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5'].includes(version)) {
    return {version, target: `@deepseek-ai/dsh-app-boot@${version}`,
      file: `@deepseek-ai__dsh-app-boot@${version}.patch`}
  }
  if (!['1.0.6', '1.0.7'].includes(version)) return undefined
  return {
    version,
    target: `@deepseek-ai/cordis-plugin-include@${version}`,
    file: `@deepseek-ai__cordis-plugin-include@${version}.patch`,
  }
}

/** Marks the block this module owns, so removal takes back exactly what it wrote. */
const BEGIN = '# >>> dsh-substrate: loader entry-id patch'
const END = '# <<< dsh-substrate'

/** The declaration block, as pnpm 11 reads it — from the workspace manifest, not package.json. */
function block(patch) {
  return [
    BEGIN,
    'patchedDependencies:',
    `  '${patch.target}': patches/${patch.file}`,
    END,
  ].join('\n')
}

/** Strip a previously written block, leaving everything else byte-identical. */
function withoutBlock(text) {
  const start = text.indexOf(BEGIN)
  if (start === -1) return text
  const end = text.indexOf(END, start)
  if (end === -1) return text
  return `${text.slice(0, start)}${text.slice(end + END.length)}`.replace(/\n{3,}/g, '\n\n')
}

/**
 * Whether a workspace currently carries this module's declaration.
 *
 * @param {string} workspaceRoot The workspace whose `pnpm-workspace.yaml` pnpm reads.
 * @returns {boolean} True when both the block and the patch file are present.
 */
export function isStaged(workspaceRoot, version = PATCH_VERSION) {
  const patch = patchFor(version)
  if (!patch) return false
  const manifest = join(workspaceRoot, 'pnpm-workspace.yaml')
  if (!existsSync(manifest)) return false
  const text = readFileSync(manifest, 'utf8')
  return text.includes(BEGIN) && text.includes(`'${patch.target}': patches/${patch.file}`)
    && existsSync(join(workspaceRoot, 'patches', patch.file))
}

/**
 * Write the patch and its declaration into a workspace.
 *
 * The workspace manifest is appended to rather than rewritten: DSH manages
 * three keys in that file and a user may have added more, so replacing it would
 * silently discard both.
 *
 * @param {string} workspaceRoot The workspace whose `pnpm-workspace.yaml` pnpm reads.
 * @param {string} [patchSource] Directory holding the `.patch`; defaults to the copy
 *   shipped inside this package, which is the only one present once installed.
 * @returns {{ changed: boolean, manifest: string, patch: string, install: string }} What happened and what to run next.
 */
export function stage(workspaceRoot, patchSource = join(here, '..', 'patches'), version = PATCH_VERSION) {
  const patch = patchFor(version)
  if (!patch) throw new Error(`stage-patch: unsupported loader ${version}`)
  const manifestPath = join(workspaceRoot, 'pnpm-workspace.yaml')
  const patchPath = join(workspaceRoot, 'patches', patch.file)
  const install = 'pnpm install'
  const source = join(patchSource, patch.file)
  if (!existsSync(source)) throw new Error(`stage-patch: no patch at ${source}`)
  if (isStaged(workspaceRoot, version) && readFileSync(source, 'utf8') === readFileSync(patchPath, 'utf8')) {
    return { changed: false, manifest: manifestPath, patch: patchPath, install }
  }
  mkdirSync(dirname(patchPath), { recursive: true })
  writeFileSync(patchPath, readFileSync(source, 'utf8'))

  const current = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : ''
  writeFileSync(manifestPath, `${withoutBlock(current).trimEnd()}\n\n${block(patch)}\n`)
  return { changed: true, manifest: manifestPath, patch: patchPath, install }
}

/**
 * Take the declaration and the patch file back out.
 *
 * @param {string} workspaceRoot The workspace whose `pnpm-workspace.yaml` pnpm reads.
 * @returns {{ changed: boolean, install: string }} Whether anything was removed, and what re-installs without it.
 */
export function unstage(workspaceRoot, version = PATCH_VERSION) {
  const patch = patchFor(version)
  if (!patch) throw new Error(`stage-patch: unsupported loader ${version}`)
  const manifestPath = join(workspaceRoot, 'pnpm-workspace.yaml')
  const install = 'pnpm install'
  let changed = false

  if (existsSync(manifestPath)) {
    const current = readFileSync(manifestPath, 'utf8')
    const next = withoutBlock(current)
    if (next !== current) { writeFileSync(manifestPath, next.trimEnd() + '\n'); changed = true }
  }
  const patchPath = join(workspaceRoot, 'patches', patch.file)
  if (existsSync(patchPath)) { rmSync(patchPath); changed = true }
  return { changed, install }
}
