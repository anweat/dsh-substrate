/**
 * What deriving a panel's channel from its package name would buy, measured on
 * the route sample.
 *
 * A backend path is a free-form string today, so two packages wanting the same
 * surface claim the same path and the second one to load throws. Deriving the
 * path from the package name makes that collision impossible between distinct
 * packages while leaving the genuine one — the same package mounted twice —
 * exactly as it is.
 *
 * Route paths are only statically decidable for part of the corpus, so this
 * runs over the published 503-repository sample rather than all 9,873.
 *
 * Usage: node bin/whatif-panel-channels.mjs [routes.json]
 */
import { readFileSync } from 'node:fs'
import { channelFor } from '../src/panel.mjs'
import { ECO } from '../../paths.mjs'

const source = process.argv[2] ?? `${ECO}/out/routes.json`
const rows = Object.values(JSON.parse(readFileSync(source, 'utf8')))

/** Claimants per literal path, as the runtime sees them. */
const byPath = new Map()
for (const row of rows) {
  for (const route of row.routes ?? []) {
    if (typeof route.path !== 'string') continue
    if (!byPath.has(route.path)) byPath.set(route.path, new Set())
    byPath.get(route.path).add(row.pkg)
  }
}

const contended = [...byPath].filter(([, claimants]) => claimants.size > 1)
const involved = new Set()
for (const [, claimants] of contended) for (const pkg of claimants) involved.add(pkg)

// Derivation puts the package name in the path. Two distinct packages therefore
// cannot land on one channel; two copies of one package still do, and must.
let separable = 0
const stillCollide = []
for (const [path, claimants] of contended) {
  const derived = new Set([...claimants].map(pkg => channelFor(pkg, 'main')))
  if (derived.size > 1) separable += 1
  else stillCollide.push({ path, claimants: [...claimants] })
}

// Host wrappers replace the harness rather than coexist with it, so their
// collisions are not something a plugin-side convention was ever going to fix.
const WRAPPER_PATHS = /^\/plugins\b/
const wrapperPaths = contended.filter(([path]) => WRAPPER_PATHS.test(path)).length

const pct = (n, d) => `${(n / d * 100).toFixed(1)}%`
console.log(`\n路由样本 ${rows.length} 仓库 · 去重字面路径 ${byPath.size}\n`)
console.log(`  被多个包争用的路径   ${String(contended.length).padStart(4)}   牵涉包 ${involved.size}`)
console.log(`  派生后可分离         ${String(separable).padStart(4)}   ${pct(separable, contended.length)}`)
console.log(`  派生后仍然撞车       ${String(stillCollide.length).padStart(4)}   同名包的两份拷贝,本就该撞`)
for (const { path, claimants } of stillCollide.slice(0, 5)) {
  console.log(`      ${path}  ${claimants.join(', ')}`)
}
console.log(`\n  其中 ${wrapperPaths} 条属于 /plugins —— 那是替换整个 host 的壳,不是与它共存的插件,`)
console.log('  一个插件侧的约定本来也管不到它们。\n')
