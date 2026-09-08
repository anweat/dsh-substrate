/** Materialize the selected release's headless composition using its own parser. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

export async function prepareProfile(root, workspace) {
  const output = join(workspace, 'base.cordis.yml')
  if (process.env.DSH_E2E_PROFILE === 'core') {
    writeFileSync(output, "- id: system-prompt\n  name: '@deepseek-ai/dsh-system-prompt'\n- id: tools\n  name: '@deepseek-ai/dsh-tools'\n  config:\n    mode: native\n")
    return { output, source: 'CORE ONLY: real SystemPrompt + ToolRuntime; not a full shipped profile' }
  }
  if (process.env.DSH_E2E_PROFILE && process.env.DSH_E2E_PROFILE !== 'shipped') {
    throw new Error(`Unknown DSH_E2E_PROFILE: ${process.env.DSH_E2E_PROFILE}`)
  }
  const legacy = ['apps/cli/tests/profiles/headless/cordis.yml', 'examples/headless-agent/cordis.yml']
    .map(path => join(root, path)).find(path => existsSync(path))
  if (legacy) {
    writeFileSync(output, readFileSync(legacy))
    return { output, source: legacy }
  }
  // alpha.3 removed standalone test compositions in favor of product bundles.
  const { entryListSchema, applyEntryPatches } = await import(pathToFileURL(join(root, 'vendor/include/src/index.ts')).href)
  let rows = []
  for (const path of ['packages/bundle/base/cordis.patch.yml', 'packages/bundle/headless/cordis.patch.yml']) {
    const patches = yaml.load(readFileSync(join(root, path), 'utf8'), { schema: entryListSchema })
    rows = applyEntryPatches(rows, patches, message => { throw new Error(message) })
  }
  // This probe owns the boot and must never launch a paid model turn. These
  // two driver rows are disabled by upstream's real-model test overlay too.
  for (const id of ['headless-startup', 'headless-runner']) {
    const row = rows.find(row => row.id === id)
    if (!row) throw new Error(`Missing upstream driver row: ${id}`)
    row.disabled = true
  }
  writeFileSync(output, yaml.dump(rows, { schema: entryListSchema, noRefs: true }))
  return { output, source: 'base + headless bundles; startup/runner disabled (registration-only probe)' }
}
