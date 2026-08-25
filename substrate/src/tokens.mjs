/**
 * L4 — the design-token contract.
 *
 * The shell defines its tokens on `body` and redefines them under
 * `body[data-ds-dark-theme]`, so every plugin's CSS inherits the whole
 * vocabulary for free. That makes the tokens usable but unpublished: nothing
 * tells a plugin author which names exist, which of them flip between themes,
 * or which references have gone stale since. This module turns that ambient
 * vocabulary into a checkable contract.
 *
 * The tier split is the substance. `static` names a fixed palette entry and
 * mostly holds its value across themes; `alias` names a role and flips. A
 * themed property that reaches for a `static` token therefore pins one theme's
 * appearance into both — the failure this module exists to catch, alongside
 * references to tokens that no longer exist at all.
 *
 * @module tokens
 */

/**
 * How much each rule proves, which is not the same for all three.
 *
 * `dangling` is a defect on its own evidence: the token is defined nowhere, the
 * reference carries no fallback, and the declaration therefore resolves to
 * nothing at runtime. Nothing about the design can make that intended.
 *
 * The other two need a human. A brand accent is deliberately the same colour in
 * both themes, and a surface that stays dark in both — a tooltip, a scrim —
 * correctly carries light text written as a literal. Both rules find those
 * alongside real mistakes, so they advise and never fail a build.
 */
export const SEVERITY = Object.freeze({
  dangling: 'error',
  'static-on-themed': 'advisory',
  'pinned-literal': 'advisory',
})

/** Declaration properties whose value must follow the active theme. */
export const THEMED_PROPERTIES = Object.freeze([
  'color', 'background', 'background-color', 'border-color', 'border',
  'border-top', 'border-right', 'border-bottom', 'border-left',
  'fill', 'stroke', 'outline', 'outline-color', 'box-shadow', 'text-decoration-color',
])

/**
 * Colour literals that carry no theme: fully transparent, or `transparent`
 * itself. A mask or a scrim written as `rgba(0, 0, 0, 0.24)` is a deliberate
 * theme-independent overlay, so alpha at or below this bound is not reported.
 */
const THEME_FREE_ALPHA = 0.5

const DECLARATION = /(^|[;{])\s*([a-z-]+)\s*:\s*([^;{}]*)/g
const VAR_REFERENCE = /var\(\s*(--[a-zA-Z0-9-]+)\s*(,)?/g
const DEFINITION = /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+)/g
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)|\btransparent\b/g

/** Split a stylesheet into `{ selector, body }` blocks, ignoring nesting. */
function blocksOf(css) {
  return [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .map(m => ({ selector: m[1].trim().split('\n').pop().trim(), body: m[2] }))
}

/**
 * The tier segment of a token name: `--dsw-alias-bg-base` yields `alias`.
 *
 * @param {string} name Token name.
 * @param {string} [prefix] Prefix the vocabulary is namespaced under.
 * @returns {string | undefined} Tier, or undefined when the name is out of namespace.
 */
export function tierOf(name, prefix = '--dsw-') {
  if (!name.startsWith(prefix)) return undefined
  return name.slice(prefix.length).split('-')[0]
}

/**
 * Read the ambient token vocabulary out of the shell's own stylesheets.
 *
 * @param {Array<{ name: string, css: string }>} sources Ambient stylesheets, in load order.
 * @param {object} [options]
 * @param {string} [options.prefix] Token name prefix to collect.
 * @param {RegExp} [options.darkSelector] Marks a block as the dark-theme definition.
 * @returns {{ tokens: Map<string, { tier: string, light?: string, dark?: string, flips: boolean, source: string }>, order: string[] }} Vocabulary keyed by token name, plus definition order.
 */
export function parseTokens(sources, options = {}) {
  const prefix = options.prefix ?? '--dsw-'
  const darkSelector = options.darkSelector ?? /data-ds-dark-theme/
  const tokens = new Map()
  const order = []
  for (const { name: source, css } of sources) {
    for (const block of blocksOf(css)) {
      const isDark = darkSelector.test(block.selector)
      for (const d of block.body.matchAll(DEFINITION)) {
        const [, token, raw] = d
        if (!token.startsWith(prefix)) continue
        let record = tokens.get(token)
        if (record === undefined) {
          record = { tier: tierOf(token, prefix), flips: false, source }
          tokens.set(token, record)
          order.push(token)
        }
        record[isDark ? 'dark' : 'light'] = raw.trim()
        record.flips = record.light !== undefined && record.dark !== undefined && record.light !== record.dark
      }
    }
  }
  return { tokens, order }
}

/**
 * The alpha of a colour literal, or 1 when it carries none.
 *
 * Both CSS colour syntaxes reach the same place: `rgba(r, g, b, a)` puts alpha
 * fourth among comma-separated components, while `rgb(r g b / a)` puts it after
 * a slash. A three-component form is opaque — reading its last component as
 * alpha would treat every pure blue as a scrim.
 */
function alphaOf(literal) {
  if (literal === 'transparent') return 0
  if (/^#[0-9a-fA-F]{8}$/.test(literal)) return Number.parseInt(literal.slice(7), 16) / 255
  if (!/^(rgba?|hsla?)\(/.test(literal)) return 1
  const body = literal.slice(literal.indexOf('(') + 1, -1)
  const slash = body.split('/')
  if (slash.length === 2) return Number.parseFloat(slash[1]) || 0
  const parts = body.split(',')
  if (parts.length < 4) return 1
  return Number.parseFloat(parts[3]) || 0
}

/** The first literal in a value that pins an appearance a theme should own. */
function pinsAppearance(value) {
  for (const literal of value.match(COLOUR_LITERAL) ?? []) {
    if (alphaOf(literal) > THEME_FREE_ALPHA) return literal
  }
  return undefined
}

/** Line number of an offset, so a finding points at somewhere editable. */
function lineAt(css, index) {
  let line = 1
  for (let i = 0; i < index; i += 1) if (css.charCodeAt(i) === 10) line += 1
  return line
}

/**
 * Check one stylesheet against the vocabulary.
 *
 * Three rules, each pinned to a way the ambient arrangement fails silently.
 * `dangling` is a reference with no fallback to a token nothing defines, which
 * resolves to nothing at all. `static-on-themed` is a fixed palette entry on a
 * property the theme should drive. `pinned-literal` is an opaque colour written
 * out where a token belongs. Tokens the file defines itself are in scope, and a
 * reference carrying a fallback is never dangling.
 *
 * @param {string} css Stylesheet text.
 * @param {object} options
 * @param {Map<string, { tier: string }>} options.tokens Ambient vocabulary from `parseTokens`.
 * @param {string} [options.file] Path reported with each finding.
 * @param {string} [options.prefix] Token name prefix under contract.
 * @returns {Array<{ rule: string, severity: string, token?: string, property: string, value?: string, file?: string, line: number }>} Findings in source order.
 */
export function lintCss(css, options) {
  const { tokens, file } = options
  const prefix = options.prefix ?? '--dsw-'
  const themed = new Set(THEMED_PROPERTIES)
  const local = new Set([...css.matchAll(DEFINITION)].map(m => m[1]))
  const findings = []
  const at = (rule, index) => ({ rule, severity: SEVERITY[rule], ...(file === undefined ? {} : { file }), line: lineAt(css, index) })

  for (const d of css.matchAll(DECLARATION)) {
    const [, , property, value] = d
    const index = d.index + d[0].length - value.length
    const isThemed = themed.has(property)

    for (const v of value.matchAll(VAR_REFERENCE)) {
      const [, token, fallback] = v
      if (!token.startsWith(prefix)) continue
      if (!tokens.has(token) && !local.has(token)) {
        if (fallback === undefined) findings.push({ ...at('dangling', index), token, property })
        continue
      }
      if (isThemed && tokens.get(token)?.tier === 'static') {
        findings.push({ ...at('static-on-themed', index), token, property })
      }
    }

    if (!isThemed || value.includes('var(')) continue
    const literal = pinsAppearance(value)
    if (literal !== undefined) findings.push({ ...at('pinned-literal', index), property, value: literal })
  }
  return findings
}

/**
 * Group findings by rule, so a report leads with counts rather than a list.
 *
 * `errors` is the count a gate should act on; advisories are reported for a
 * human to judge and never fail one.
 *
 * @param {Array<{ rule: string, severity: string }>} findings Findings from `lintCss`.
 * @returns {{ total: number, errors: number, advisories: number, byRule: Record<string, number> }} Totals and per-rule counts.
 */
export function summarize(findings) {
  const byRule = new Map()
  let errors = 0
  for (const f of findings) {
    byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1)
    if (f.severity === 'error') errors += 1
  }
  return { total: findings.length, errors, advisories: findings.length - errors, byRule: Object.fromEntries(byRule) }
}

/**
 * Render the vocabulary as a TypeScript declaration a plugin can depend on.
 *
 * The union is the publishable half of the contract: it names every token and
 * marks which ones a theme redefines, so an editor completes them and a rename
 * upstream becomes a type error rather than a blank rule at runtime.
 *
 * @param {{ tokens: Map<string, { tier: string, flips: boolean }>, order: string[] }} vocabulary Parsed vocabulary.
 * @returns {string} Declaration file text.
 */
export function renderDeclaration({ tokens, order }) {
  const tiers = new Map()
  for (const name of order) {
    const { tier } = tokens.get(name)
    if (!tiers.has(tier)) tiers.set(tier, [])
    tiers.get(tier).push(name)
  }
  const pascal = t => `${t[0].toUpperCase()}${t.slice(1)}Token`
  const lines = [
    '/**',
    ' * Design tokens the shell defines on `body`, generated from its stylesheets.',
    ' *',
    ' * `alias` names a role and flips between themes; `static` names a fixed',
    ' * palette entry. Reach for an alias on anything a theme should drive.',
    ' *',
    ' * @module tokens',
    ' */',
    '',
  ]
  for (const [tier, names] of tiers) {
    const flipping = names.filter(n => tokens.get(n).flips).length
    lines.push(`/** \`${tier}\` tier: ${names.length} tokens, ${flipping} redefined under the dark theme. */`)
    lines.push(`export type ${pascal(tier)} =`)
    for (const n of names) lines.push(`  | '${n}'`)
    lines.push('')
  }
  lines.push('/** Every token the shell publishes. */')
  lines.push(`export type DesignToken = ${[...tiers.keys()].map(pascal).join(' | ')}`)
  lines.push('')
  lines.push('/** Tokens a theme redefines; anything theme-sensitive must come from here. */')
  lines.push('export type ThemedToken =')
  for (const n of order) if (tokens.get(n).flips) lines.push(`  | '${n}'`)
  lines.push('')
  return lines.join('\n')
}
