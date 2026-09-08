/** Real pnpm apply/relink/new-process/revert checks for both audited loaders.
 * Usage: node experiments/verify-published-loaders.mjs [new-output-directory]
 * Uses only newly created installation fixtures; never the user's DSH home.
 */
import { mkdirSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { performRepair, runPnpmInstall } from '../plugin/src/repair.mjs'
import { LOADER_PACKAGE } from '../plugin/src/patch-target.mjs'

const out = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'substrate-published-'))
if (process.argv[2] && existsSync(out)) throw new Error(`Refusing existing output directory: ${out}`)
mkdirSync(out, { recursive: true })
const results = []
for (const version of ['1.0.6', '1.0.7']) {
  const root = join(out, version)
  mkdirSync(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
    [LOADER_PACKAGE]: version,
    '@deepseek-ai/cordis': version === '1.0.6' ? '4.0.1' : '4.0.2',
    '@deepseek-ai/cordis-plugin-loader': version === '1.0.6' ? '1.0.2' : '1.0.3',
  } }, null, 2))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - '.'\nnodeLinker: hoisted\n")
  if (!runPnpmInstall(root).ok) throw new Error(`Initial install failed: ${version}`)
  const home = join(root, 'home')
  const link = join(home, 'profiles', 'node_modules', LOADER_PACKAGE)
  mkdirSync(join(link, '..'), { recursive: true })
  symlinkSync(join(root, 'node_modules', LOADER_PACKAGE), link, process.platform === 'win32' ? 'junction' : 'dir')
  const probe = () => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import Include from ${JSON.stringify(pathToFileURL(join(root, 'node_modules', LOADER_PACKAGE, 'lib/index.js')).href)};
      const rows = [{ id: 'browser', name: '@a/browser' }, { id: 'browser', name: '@b/browser' }];
      const result = Include.prototype.applyPatches.call({ ctx: { root: {} } }, rows, []);
      const nested = [{id:'browser',name:'@a/browser'}, {id:'group',name:'cordis:group',group:true,config:[
        {id:'browser',name:'@b/browser'}, {id:'deep',name:'cordis:group',group:true,config:[{id:'browser',name:'@c/browser'}]}
      ]}, {id:'b-browser',name:'reserved'}, {id:'data',name:'ordinary-plugin',config:[{id:'browser',name:'data-only'}]}];
      const patched = Include.prototype.applyPatches.call({ctx:{root:{}}},nested,[]);
      const repeated = Include.prototype.applyPatches.call({ctx:{root:{}}},patched,[]);
      console.log(JSON.stringify({flat:result.map(row => row.id),nested:patched,stable:JSON.stringify(patched)===JSON.stringify(repeated)}));
    `], { encoding: 'utf8', timeout: 30000 })
    if (run.status !== 0) throw new Error(run.stderr)
    return JSON.parse(run.stdout.trim())
  }
  const before = probe()
  const applied = await performRepair({ home, mode: 'apply' })
  const after = probe()
  const reverted = await performRepair({ home, mode: 'revert' })
  const restored = probe()
  const ok = applied.ok && reverted.ok && new Set(before.flat).size === 1
    && after.flat[0] === 'browser' && new Set(after.flat).size === 2
    && after.nested[1].config[0].id === 'b-browser-2'
    && after.nested[1].config[1].config[0].id === 'c-browser'
    && after.nested[2].id === 'b-browser'
    && after.nested[3].config[0].id === 'browser' && after.stable
    && JSON.stringify(restored) === JSON.stringify(before)
  results.push({ version, ok, before, after, restored, applied, reverted })
  console.log(`${ok ? 'PASS' : 'FAIL'} published loader ${version}: pnpm repair and new-process behavior`)
}
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2))
console.log(`Evidence: ${out}`)
process.exitCode = results.every(result => result.ok) ? 0 : 1
