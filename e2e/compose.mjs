/**
 * Compose the generated corpus onto a real profile, with the substrate applied.
 *
 * The arbitration itself is the substrate's — this only turns its decisions
 * into loader rows, which is the step no experiment had exercised: every
 * contender that must yield its global seat is re-homed into its own
 * `cordis:group` carrying `isolate: { tools: true }`, alongside a shim that
 * provides the `tools` that group resolves.
 *
 * One group per contender, not one group for all of them. Two scopes may claim
 * one tool name; two plugins in the *same* scope may not, so a shared sandbox
 * would reproduce the collision it is meant to remove.
 *
 * Usage: node e2e/compose.mjs [workspaceDir]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ROOT, DSH_ROOT, require_ } from '../paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = require_(DSH_ROOT, 'DSH_ROOT', 'read the shipped profile and the scope constructor')
const workspace = process.argv[2] ?? join(here, 'workspace')

const SUBSTRATE = pathToFileURL(join(ROOT, 'substrate', 'src')).href
const { contributionsOf } = await import(`${SUBSTRATE}/model.mjs`)
const { arbitrate } = await import(`${SUBSTRATE}/arbitrate.mjs`)

const rows = JSON.parse(readFileSync(join(workspace, 'rows.json'), 'utf8'))

// Tool names the shipped profile already owns, read from a real boot by
// `e2e/shipped-tools.mjs`. Guessing this list is how a corpus package ends up
// claiming a seat the profile already holds: an earlier hardcoded version
// missed `send_message` and the full-corpus boot failed on exactly that name.
const shippedTools = new Set(JSON.parse(readFileSync(join(here, 'shipped-tools.json'), 'utf8')))

const contributions = []
for (const row of rows) {
  contributions.push(...contributionsOf({
    pkgName: row.pkg,
    contributions: row.tools.map(t => ({ plane: 'host', verb: 'tool-register', target: t, resolved: true, source: null })),
  }).contributions)
}

const result = arbitrate(contributions, { shippedTools, fallback: 'alphabetical' })

/** Packages that must give up a global seat, and therefore need a scope. */
const needScope = new Set()
for (const decision of result.decisions) {
  if (decision.kind !== 'tool') continue
  for (const action of decision.actions ?? []) {
    if (action.action === 'layer' && action.owner !== undefined) needScope.add(action.owner)
  }
}

writeFileSync(join(workspace, 'shim.mjs'), `// generated: binds the substrate's tools shim to this checkout's createScope
import { makeToolsShim } from ${JSON.stringify(`${SUBSTRATE}/tools-shim.mjs`)}
import { createScope } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'packages/core/scope/src/index.ts')).href)}

const shim = makeToolsShim(createScope)
export const name = shim.name
// deliberately no inject: see makeToolsShim
export const apply = shim
`)

const base = readFileSync(join(repoRoot, 'examples/headless-agent/cordis.yml'), 'utf8')
const lines = [base, `# --- ${rows.length} corpus packages, ${needScope.size} of them scoped by the substrate ---`]

for (const row of rows) {
  if (!needScope.has(row.pkg)) {
    lines.push(`- id: ${row.id}\n  name: ./plugins/${row.id}.mjs`)
    continue
  }
  lines.push(
    `- id: scope-${row.id}`,
    '  name: cordis:group',
    '  group: true',
    '  isolate:',
    '    tools: true',
    '  config:',
    `    - id: shim-${row.id}`,
    '      name: ./shim.mjs',
    '      config:',
    `        scope: ${JSON.stringify(row.pkg)}`,
    `    - id: ${row.id}`,
    `      name: ./plugins/${row.id}.mjs`,
  )
}

writeFileSync(join(workspace, 'cordis.substrate.yml'), `${lines.join('\n')}\n`)

const tally = { intact: 0, adapted: 0, degraded: 0 }
for (const outcome of result.outcomes) tally[outcome.status] += 1
console.log(`\n裁决 ${rows.length} 个包 · ${contributions.length} 笔贡献`)
console.log(`  需要独立 scope 的包  ${needScope.size}`)
console.log(`  结局  intact ${tally.intact} · adapted ${tally.adapted} · degraded ${tally.degraded}`)
console.log(`\n写出 ${join(workspace, 'cordis.substrate.yml')}\n`)
