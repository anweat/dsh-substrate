#!/usr/bin/env node
/**
 * Pre-boot conflict check.
 *
 * This is a command rather than a plugin because of when the failures happen.
 * A duplicate loader entry id is rejected in `EntryGroup.update` during
 * `mountRootInclude`, before a single entry applies — measured: when it throws,
 * zero plugins have mounted. So nothing running inside the tree can report it,
 * and a plugin that promised to would be arriving after the argument was over.
 *
 * What it reads is the composed row list. What it reports is what will fail and
 * which of those failures anything can fix.
 *
 * Usage:
 *   dsh-substrate-check <composed-config.yml> [--json]
 *
 * @module @anweat/dsh-substrate/check
 */
import { readFileSync } from 'node:fs'

/** Rows in a composed config, flattened through groups. */
function rowsOf(text) {
  // Deliberately not a YAML dependency: the composed row list this reads is a
  // flat sequence of `- id:` / `name:` pairs, and a parser here would be a
  // parser to keep in step with the loader's dialect for no gain.
  const rows = []
  let current
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '  ')
    const id = /^(\s*)-\s+id:\s*(.+?)\s*$/.exec(line)
    if (id !== null) {
      if (current !== undefined) rows.push(current)
      current = { id: unquote(id[2]), indent: id[1].length, name: undefined, disabled: false }
      continue
    }
    if (current === undefined) continue
    const name = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (name !== null && current.name === undefined) current.name = unquote(name[1])
    if (/^\s*disabled:\s*true\s*$/.test(line)) current.disabled = true
  }
  if (current !== undefined) rows.push(current)
  return rows
}

const unquote = v => v.replace(/^['"]|['"]$/g, '')

/**
 * Find what will stop this composition from booting.
 *
 * @param {ReturnType<typeof rowsOf>} rows Composed rows.
 * @returns {{ fatal: object[], rows: number }} Findings and how many rows were read.
 */
export function inspect(rows) {
  const byId = new Map()
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, [])
    byId.get(row.id).push(row)
  }
  const fatal = []
  for (const [id, claimants] of byId) {
    if (claimants.length < 2) continue
    fatal.push({
      kind: 'duplicate-entry-id',
      id,
      claimants: claimants.map(r => r.name ?? '(unnamed)'),
      // Both measured in `experiments/lab-duplicate-entry-id.ts`.
      whyPatchesCannotFix: [
        'EntryGroup.update rejects the id list before it reads `disabled`, so switching a row off leaves it holding the id',
        'applyEntryPatches skips `id` when copying overrides, so a patch cannot rename a row',
      ],
      // Who can act, and how. A later patch layer is not on this list, and
      // saying only "make the id unique" leaves a reader hunting for a lever
      // that does not exist. Each option is measured in the same experiment.
      fix: [
        '拥有其中一行的插件,在它自己的 cordis.patch.yml 里改掉那个 id —— 仍可被后续补丁按 id 定位',
        '或者干脆不写 id:EntryTree.ensureId 会生成一个空闲的,代价是那行再也无法按 id 定位',
        '或者把 id 做成配置项,让部署方自己决定',
      ],
    })
  }
  return { fatal, rows: rows.length }
}

/** Render findings for a terminal. */
export function render({ fatal, rows }) {
  const lines = [`\n读入 ${rows} 行`]
  if (fatal.length === 0) {
    lines.push('未发现会阻止启动的 entry id 冲突。\n')
    lines.push('这不是"没有冲突"。工具名、槽位与路由的争用发生在插件挂载之后,')
    lines.push('这个命令看不见;那部分由 substrate 插件在运行时报告。\n')
    return lines.join('\n')
  }
  lines.push(`\n${fatal.length} 处会让整个 profile 起不来:\n`)
  for (const f of fatal) {
    lines.push(`  entry id "${f.id}" 被 ${f.claimants.length} 行认领`)
    for (const c of f.claimants) lines.push(`      ${c}`)
    lines.push('')
    for (const why of f.whyPatchesCannotFix) lines.push(`    · ${why}`)
    lines.push('\n    出路(后续补丁层不在其列):')
    for (const option of f.fix) lines.push(`      · ${option}`)
    lines.push('')
  }
  return lines.join('\n')
}

/* v8 ignore next 12 -- CLI entry; the reporting above is what the tests drive. */
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const file = process.argv[2]
  if (file === undefined) {
    console.error('用法: dsh-substrate-check <composed-config.yml> [--json]')
    process.exit(2)
  }
  const result = inspect(rowsOf(readFileSync(file, 'utf8')))
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : render(result))
  process.exit(result.fatal.length === 0 ? 0 : 1)
}
