/**
 * Stage the loader patch into a profile, or take it back out.
 *
 * Splitting this from the plugin body so the decision it encodes is testable
 * without a booted tree: what gets written, what gets left alone, and what
 * `enabled: false` restores.
 *
 * Nothing here runs a package manager. Writing the declaration and installing
 * it are different acts — the second one is `dsh plugin`'s job, invoked by a
 * person who has read what the first one wrote. A plugin that did both on a
 * setting change would be a plugin that installs software when you flip a
 * switch, which is the behaviour the switch exists to make visible.
 *
 * @module @anweat/dsh-substrate/stage-patch
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The patched package, pinned to the version the diff was generated against. */
export const PATCH_TARGET = '@deepseek-ai/cordis-plugin-include@1.0.7'
/** File name under the profile's `patches/`, and under this package's. */
export const PATCH_FILE = '@deepseek-ai__cordis-plugin-include@1.0.7.patch'

/** Marks the block this module owns, so removal takes back exactly what it wrote. */
const BEGIN = '# >>> dsh-substrate: loader entry-id patch'
const END = '# <<< dsh-substrate'

/** The declaration block, as pnpm 11 reads it — from the workspace manifest, not package.json. */
function block() {
  return [
    BEGIN,
    'patchedDependencies:',
    `  '${PATCH_TARGET}': patches/${PATCH_FILE}`,
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
 * Whether a profile currently carries this module's declaration.
 *
 * @param {string} profileDir Profile directory.
 * @returns {boolean} True when both the block and the patch file are present.
 */
export function isStaged(profileDir) {
  const manifest = join(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(manifest)) return false
  return readFileSync(manifest, 'utf8').includes(BEGIN)
    && existsSync(join(profileDir, 'patches', PATCH_FILE))
}

/**
 * Write the patch and its declaration into a profile.
 *
 * The workspace manifest is appended to rather than rewritten: DSH manages
 * three keys in that file and a user may have added more, so replacing it would
 * silently discard both.
 *
 * @param {string} profileDir Profile directory.
 * @param {string} [patchSource] Directory holding the `.patch`; defaults to this package's.
 * @returns {{ changed: boolean, manifest: string, patch: string, install: string }} What happened and what to run next.
 */
export function stage(profileDir, patchSource = join(here, '..', '..', 'patches')) {
  const manifestPath = join(profileDir, 'pnpm-workspace.yaml')
  const patchPath = join(profileDir, 'patches', PATCH_FILE)
  const install = `dsh plugin --profile <profile> install`
  if (isStaged(profileDir)) return { changed: false, manifest: manifestPath, patch: patchPath, install }

  const source = join(patchSource, PATCH_FILE)
  if (!existsSync(source)) throw new Error(`stage-patch: no patch at ${source}`)
  mkdirSync(dirname(patchPath), { recursive: true })
  writeFileSync(patchPath, readFileSync(source, 'utf8'))

  const current = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : ''
  writeFileSync(manifestPath, `${withoutBlock(current).trimEnd()}\n\n${block()}\n`)
  return { changed: true, manifest: manifestPath, patch: patchPath, install }
}

/**
 * Take the declaration and the patch file back out.
 *
 * @param {string} profileDir Profile directory.
 * @returns {{ changed: boolean, install: string }} Whether anything was removed, and what re-installs without it.
 */
export function unstage(profileDir) {
  const manifestPath = join(profileDir, 'pnpm-workspace.yaml')
  const install = `dsh plugin --profile <profile> install`
  let changed = false

  if (existsSync(manifestPath)) {
    const current = readFileSync(manifestPath, 'utf8')
    const next = withoutBlock(current)
    if (next !== current) { writeFileSync(manifestPath, next.trimEnd() + '\n'); changed = true }
  }
  const patchPath = join(profileDir, 'patches', PATCH_FILE)
  if (existsSync(patchPath)) { rmSync(patchPath); changed = true }
  return { changed, install }
}
