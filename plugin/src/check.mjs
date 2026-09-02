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
 * The loader package the published patch targets, pinned to the version it was
 * generated against. pnpm refuses to apply a patch whose target moved, so the
 * pin is what makes an upgrade fail loudly instead of silently doing nothing.
 */
const PATCH_TARGET = '@deepseek-ai/cordis-plugin-include@1.0.7'
const PATCH_FILE = '@deepseek-ai__cordis-plugin-include@1.0.7.patch'

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
      // Who can act, and how, in the order worth trying. A later patch layer is
      // not on this list: an existing id cannot be changed by one, and nothing
      // at runtime gets a turn either, because the throw precedes every apply.
      // Omitting the id is last on purpose — it works by making the row
      // anonymous, which also puts it beyond anyone's reach.
      fix: [
        '首选:拥有其中一行的插件,在它自己的 cordis.patch.yml 里换一个唯一的 id —— 仍可被后续补丁停用与配置',
        '更好:把 id 做成配置项,让部署方自己决定',
        '下策:干脆不写 id。ensureId 会生成一个空闲的随机值,撞车在构造上不可能,但那一行从此无法按 id 定位 —— 谁都停不掉、配不了它',
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
  // The one-command version of the advice above. Printed rather than applied:
  // pnpm reads `patchedDependencies` only from the workspace manifest, never
  // from a dependency, so adopting it is the root workspace's decision and this
  // command has no business making it for anyone. Copy-paste is the right
  // amount of friction — one step away, but a step somebody takes on purpose.
  lines.push('  想让这类冲突整体消失,可以给 loader 打一份补丁(58 行,纯文本 diff)。')
  lines.push('  在 <profile>/pnpm-workspace.yaml 里追加:\n')
  lines.push('    patchedDependencies:')
  lines.push(`      '${PATCH_TARGET}': patches/${PATCH_FILE}\n`)
  lines.push('  补丁与说明:https://github.com/anweat/dsh-substrate/tree/master/patches\n')
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
