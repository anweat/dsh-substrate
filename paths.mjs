/**
 * Where this workspace expects to find things that are not in it.
 *
 * Three of the four are outside the repository by necessity: a harness checkout
 * is someone else's product, and the scanner's per-repository extraction is
 * deliberately unpublished — the aggregate is the data set, not the raw crawl.
 * Every one resolves from an environment variable so a clone works without
 * editing sources.
 *
 * @module paths
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This workspace's own root. */
export const ROOT = dirname(fileURLToPath(import.meta.url))

/** The substrate's source directory, for scripts that load it dynamically. */
export const SUBSTRATE = join(ROOT, 'substrate', 'src')

/**
 * A DeepSeek Harness checkout: `$DSH_ROOT`.
 *
 * The experiments and the e2e install boot the real product, so they need one.
 * Nothing under `substrate/` does.
 */
export const DSH_ROOT = process.env.DSH_ROOT ?? ''

/**
 * The scanner's working root: `$DSH_ECO`, defaulting to `pipeline/`.
 *
 * Holds `data/baseline.json` and `out/records.jsonl`. The per-repository
 * extraction under `out/` is deliberately unpublished.
 */
export const ECO = process.env.DSH_ECO ?? join(ROOT, 'pipeline')

/** The published measurements repository, when a script syncs into it: `$DSH_EVIDENCE`. */
export const EVIDENCE = process.env.DSH_EVIDENCE ?? ''

/**
 * Resolve a required path, failing with what to set rather than what was missing.
 *
 * A script that silently proceeds without a checkout reports a clean run over
 * nothing, which is worse than not running.
 *
 * @param {string} value Resolved path, possibly empty.
 * @param {string} variable Environment variable that supplies it.
 * @param {string} purpose What the script needs it for.
 * @returns {string} The path.
 */
export function require_(value, variable, purpose) {
  if (value === '' || !existsSync(value)) {
    throw new Error(`${variable} is not set to an existing path (needed to ${purpose})`)
  }
  return value
}
