/** Installable Host entry against the selected checkout's real services. */
import { Context } from './vendor/cordis/src/index.ts'
import { ToolRuntime } from './packages/core/tools/src/index.ts'
import { SystemPrompt } from './packages/core/system-prompt/src/index.ts'
import { pathToFileURL } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const substrate = pathToFileURL(`${process.env.DSH_SUBSTRATE}/`).href
const plugin = await import(new URL('../../plugin/src/index.mjs', substrate).href)
const root = new Context()
let passed = 0
const check = (name: string, value: boolean) => {
  if (!value) throw new Error(`FAIL ${name}`)
  passed++
  console.log(`PASS ${name}`)
}
try {
  await root.plugin(SystemPrompt, {})
  await root.plugin(ToolRuntime, { mode: 'native' })
  root.tools.register({ name: 'substrate_probe', description: 'compatibility probe', parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false },
      render: () => ({ card: 'generic', title: 'probe' }) }, execute: () => ({}) } as never)
  const lines: string[] = []
  const fiber = await root.plugin(plugin, { settleMs: 10, log: (line: string) => lines.push(line),
    home: mkdtempSync(join(tmpdir(), 'substrate-host-probe-')) })
  await new Promise(resolve => setTimeout(resolve, 150))
  check('published Host entry reports the real tool registry', lines.some(line => /1 个工具/.test(line)))
  check('report retains quiet-window limitation', lines.some(line => line.includes('启发式')))
  await fiber.dispose()
  const count = lines.length
  await root.plugin({ name: 'later-plugin', apply() {} })
  await new Promise(resolve => setTimeout(resolve, 50))
  check('unloaded reporter no longer reacts to later plugins', lines.length === count)
} finally {
  await root.fiber.dispose()
}
console.log(`${passed} assertions`)
