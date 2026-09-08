/**
 * Card copy.
 *
 * Registered through `ctx.locale.register` and named on the slot entry as
 * `locale: NS`. Both are required: without them the bundle loads, the plugin
 * appears in the boot graph, nothing is logged, and the card does not render.
 *
 * The chrome keys — expand, collapse, save, discard, the status line — are
 * carried here rather than read from `settings.plugins`: a slot entry binds `t`
 * to the one dictionary it names, so a card from outside that package cannot
 * reach its copy and owns every string it shows.
 *
 * Length is a contract with the reader, not a style preference. The title and
 * description sit in a stack with the official cards, whose descriptions run
 * one short clause; anything longer reads as a different kind of object. The
 * detail belongs in hints, which are read only after the reader has opened the
 * card and asked for it.
 */
export const zh = {
  title: '插件兼容性',
  description: '检测插件组合冲突，并引导完成安装级修复。',

  settleMs: '启动检测静默窗口',
  settleMsHint: 'fiber 状态持续安静这么多毫秒后生成运行时报告。机器较慢或 profile 较大时可调高。',
  invalidNumber: '需要一个非负整数。',

  repair: '安装级兼容修复',
  repairAvailable: '已确认目标版本，当前尚未修改 DSH 安装。',
  repairInstallRequired: '修复声明已经准备，但依赖尚未重新链接。',
  repairRestartRequired: '补丁已经进入依赖，当前 DSH 仍运行旧代码，需要重启。',
  repairVerified: '当前 DSH 已从修复后的 loader 启动，验证通过。',
  repairRemovalInstallRequired: '撤销声明已经完成，但依赖中仍有补丁，需要重新链接。',
  repairRemovalRestartRequired: '补丁已经从依赖移除，当前 DSH 仍运行旧代码，需要重启。',
  repairVersionMismatch: '当前 loader 版本 {actual} 与补丁目标 {expected} 不一致，未提供写入操作。',
  repairSource: '当前 DSH 从源码运行（{dir}），pnpm 不会给工作区包应用 patchedDependencies。',
  repairUnresolved: '找不到 loader 的真实安装位置（{link}），未猜测写入目标。',
  repairStatusFailed: '无法读取修复状态：{message}',
  unknownVersion: '未知',

  repairProgress: '修复进度',
  stepDetected: '环境检测',
  stepPrepared: '准备声明',
  stepInstalled: '重新链接依赖',
  stepVerified: '重启并验证',
  copyRepairCommand: '复制修复命令',
  copyContinueCommand: '复制继续命令',
  copyRevertCommand: '复制撤销命令',
  copied: '已复制',
  copyFailed: '复制失败，请手动复制命令。',
  repairHint: '请在外部终端执行。命令会再次校验真实安装目录和 loader 版本，再显示确认提示。',
  sourceHint: '这是开发版源码环境，不提供安装级修复命令；请在 loader 源码中处理，或改用匹配的正式安装包验证。',
  unresolvedHint: '请先修复 DSH 的依赖回退链接或重新安装 DSH。定位真实安装目录之前不会生成命令。',
  versionMismatchHint: '这份修复只适用于上方标出的目标版本。请使用匹配版本，或等待针对当前 loader 生成并验证的新补丁。',
  restartHint: '请重启 DSH；只有新进程加载补丁后，本页才会标记为已验证。',
  verifiedHint: '修复已生效。需要撤销时，复制撤销命令并在外部终端执行。',

  readOnly: '设置文档只读。',
  expand: '展开',
  collapse: '收起',
  unsaved: '未保存',
  save: '保存',
  saving: '保存中',
  discard: '放弃',
  reset: '恢复默认',
  saveFailed: '保存未成功',
  invalidSave: '填写有误',
}

export const en: Record<keyof typeof zh, string> = {
  title: 'Plugin compatibility',
  description: 'Detects composition conflicts and guides installation-level repairs.',

  settleMs: 'Startup inspection quiet window',
  settleMsHint: 'The runtime report is generated after fiber activity stays quiet this many milliseconds. Raise it on slower machines or larger profiles.',
  invalidNumber: 'Enter a non-negative whole number.',

  repair: 'Installation-level compatibility repair',
  repairAvailable: 'The target version is confirmed. The DSH installation has not been changed.',
  repairInstallRequired: 'The repair declaration is prepared, but dependencies have not been relinked.',
  repairRestartRequired: 'The dependency now contains the patch, but this DSH process still runs the old code.',
  repairVerified: 'This DSH process started from the repaired loader. Verification passed.',
  repairRemovalInstallRequired: 'The declaration was removed, but the installed dependency still contains the patch.',
  repairRemovalRestartRequired: 'The patch was removed from the dependency, but this DSH process still runs the old code.',
  repairVersionMismatch: 'Loader {actual} does not match patch target {expected}. No write action is offered.',
  repairSource: 'This DSH runs from source ({dir}); pnpm does not apply patchedDependencies to workspace packages.',
  repairUnresolved: 'The real loader installation could not be located ({link}); no write target was guessed.',
  repairStatusFailed: 'Could not read repair status: {message}',
  unknownVersion: 'unknown',

  repairProgress: 'Repair progress',
  stepDetected: 'Inspect environment',
  stepPrepared: 'Prepare declaration',
  stepInstalled: 'Relink dependencies',
  stepVerified: 'Restart and verify',
  copyRepairCommand: 'Copy repair command',
  copyContinueCommand: 'Copy continue command',
  copyRevertCommand: 'Copy revert command',
  copied: 'Copied',
  copyFailed: 'Copy failed. Copy the command manually.',
  repairHint: 'Run this outside DSH. The command validates the real installation and loader version again before asking for confirmation.',
  sourceHint: 'This is a development source checkout, so no installation repair command is offered. Fix the loader source or verify against a matching packaged installation.',
  unresolvedHint: 'Repair the DSH dependency fallback link or reinstall DSH first. No command is generated until the real installation can be located.',
  versionMismatchHint: 'This repair applies only to the target version shown above. Use that version or wait for a newly generated and verified patch for this loader.',
  restartHint: 'Restart DSH. This page reports verified only after a new process loads the repair.',
  verifiedHint: 'The repair is active. To remove it, copy the revert command and run it outside DSH.',

  readOnly: 'The settings document is read-only.',
  expand: 'Expand',
  collapse: 'Collapse',
  unsaved: 'Unsaved',
  save: 'Save',
  saving: 'Saving',
  discard: 'Discard',
  reset: 'Reset',
  saveFailed: 'Save did not land',
  invalidSave: 'Cannot save as typed',
}
