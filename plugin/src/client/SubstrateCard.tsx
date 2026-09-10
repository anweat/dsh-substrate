/**
 * The settings card: one diagnostic setting and a read-only repair handoff.
 *
 * Its chrome is rebuilt rather than reused — `ui-settings-plugins` exports
 * `PluginCardProps` as a type but keeps the component internal — from that
 * package's own values, so the card sits in a stack with three native ones
 * without reading as a different kind of object. See `styles.ts`.
 *
 * Every repair state comes from the Host. The browser never modifies or
 * reinstalls the DSH process hosting it; it hands a validated command to an
 * external runner and reports the resulting install/restart lifecycle.
 */
import { useState } from 'react'
import type { SubstrateCardProps } from './index.js'
import type { PatchState } from './patch-controller.js'
import type { ConflictState } from './conflict-controller.js'
import { css } from './styles.js'

const REPAIR_STATE_COPY = {
  available: 'repairAvailable',
  'install-required': 'repairInstallRequired',
  'restart-required': 'repairRestartRequired',
  verified: 'repairVerified',
  'removal-install-required': 'repairRemovalInstallRequired',
  'removal-restart-required': 'repairRemovalRestartRequired',
} as const

/**
 * Fill `{name}` placeholders in a locale string.
 * @param text - the template.
 * @param values - substitutions by placeholder name.
 * @returns the filled string.
 */
function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole)
}

/**
 * Render the card.
 * @param props - locale accessor, the settings form face, and the patch face.
 * @returns the card, or nothing while the Host does not serve the namespace.
 */
export function SubstrateCard(props: SubstrateCardProps) {
  const { t } = props
  const state = props.useSubstrateCard(snapshot => snapshot)
  const patch = props.useSubstratePatch(snapshot => snapshot)
  const conflicts = props.useSubstrateConflicts(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  if (!state.available) return null
  const disabled = !state.writable || state.saving
  const blocked = !state.dirty || state.invalid || state.saving || !state.writable
  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('title')}</span>
          <span className={css.description}>{t('description')}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{t('unsaved')}</span> : null}
        <svg
          className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron}
          viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"
        >
          <path d="M3.5 5.5 7 9l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open
        ? (
          <div className={css.body}>
            {state.writable ? null : <p className={css.hint} role="status">{t('readOnly')}</p>}

            <div className={css.field}>
              <div className={css.head}>
                <label className={css.label} htmlFor="dsh-substrate-settle-ms">{t('settleMs')}</label>
                {state.settleMs.overridden
                  ? <button type="button" className={css.reset} disabled={disabled} onClick={props.reset}>{t('reset')}</button>
                  : null}
              </div>
              <input
                id="dsh-substrate-settle-ms"
                className={state.settleMs.invalid ? `${css.input} ${css.inputInvalid}` : css.input}
                value={state.settleMs.text}
                disabled={disabled}
                inputMode="numeric"
                aria-invalid={state.settleMs.invalid || undefined}
                onChange={(event) => { props.edit(event.currentTarget.value) }}
              />
              <p className={state.settleMs.invalid ? css.invalid : css.hint}>
                {state.settleMs.invalid ? t('invalidNumber') : t('settleMsHint')}
              </p>
            </div>

            <ConflictRow {...props} conflicts={conflicts} />
            <PatchRow {...props} patch={patch} />

            <div className={css.footer}>
              <p className={state.failed ? `${css.status} ${css.failed}` : css.status} role="status" aria-live="polite">
                {state.failed ? t('saveFailed') : state.invalid ? t('invalidSave') : null}
              </p>
              <button type="button" className={css.discard} disabled={!state.dirty || state.saving} onClick={props.discard}>
                {t('discard')}
              </button>
              <button type="button" className={css.save} disabled={blocked} onClick={props.save}>
                {t(state.saving ? 'saving' : 'save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}

function ConflictRow(props: SubstrateCardProps & { conflicts: ConflictState }) {
  const { t, conflicts } = props
  if (!conflicts.loaded) return null
  if (conflicts.error !== undefined) {
    return <p className={css.invalid}>{fill(t('conflictsFailed'), { message: conflicts.error })}</p>
  }
  if (conflicts.report === undefined) return null
  const { report } = conflicts
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor="dsh-substrate-conflict-mode">{t('conflictMode')}</label>
        <span className={css.version}>{fill(t('conflictCount'), { count: String(report.items.length) })}</span>
      </div>
      <select
        id="dsh-substrate-conflict-mode"
        className={css.input}
        value={report.mode}
        onChange={() => {}}
      >
        {report.modes.map(mode => (
          <option key={mode.id} value={mode.id} disabled={!mode.available}>
            {mode.id === 'default-prefix'
              ? t('modeDefault')
              : mode.id === 'search-only' ? t('modeSearchOnly') : t('modeCollapsedSearch')}
          </option>
        ))}
      </select>
      <p className={css.hint}>{t('conflictModeHint')}</p>
      <ul className={css.conflictList}>
        {report.items.length === 0
          ? <li className={css.hint}>{t('noConflicts')}</li>
          : report.items.map(item => (
            <li key={item.id} className={css.conflictItem}>
              <code>{item.originalName}</code>
              <span aria-hidden>→</span>
              <code>{item.exposedName}</code>
              <span className={css.conflictOwner}>{item.owner}</span>
            </li>
          ))}
      </ul>
      <ul className={css.modeNotes}>
        {report.modes.slice(1).map(mode => (
          <li key={mode.id}>{mode.id === 'search-only' ? t('searchOnlyUnavailable') : t('collapsedSearchUnavailable')}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The patch row.
 * @param props - the card props plus the current patch snapshot.
 * @returns the row, or nothing until the Host has answered once.
 */
function PatchRow(props: SubstrateCardProps & { patch: PatchState }) {
  const { t, patch } = props
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  if (!patch.loaded) return null
  if (patch.error !== undefined) {
    return <p className={css.invalid}>{fill(t('repairStatusFailed'), { message: patch.error })}</p>
  }
  if (patch.status === undefined) return null
  const { status } = patch
  const message = status.state === 'source'
    ? fill(t('repairSource'), { dir: status.packageDir ?? '' })
    : status.state === 'unresolved'
      ? fill(t('repairUnresolved'), { link: status.link ?? '' })
      : status.state === 'version-mismatch'
        ? fill(t('repairVersionMismatch'), {
            actual: status.actualVersion ?? t('unknownVersion'),
            expected: status.expectedVersion,
          })
        : t(REPAIR_STATE_COPY[status.state as keyof typeof REPAIR_STATE_COPY])

  const commandKind = status.state === 'available' || status.state === 'install-required'
    ? 'apply'
    : status.state === 'verified' || status.state === 'removal-install-required' ? 'revert' : undefined
  const command = commandKind === undefined ? undefined : status.commands[commandKind]
  const buttonLabel = commandKind === 'revert'
    ? 'copyRevertCommand'
    : status.state === 'install-required' ? 'copyContinueCommand' : 'copyRepairCommand'

  const copy = async () => {
    if (command === undefined) return
    try {
      await navigator.clipboard.writeText(command)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  const showApplyProgress = ['available', 'install-required', 'restart-required', 'verified'].includes(status.state)
  const progress = showApplyProgress
    ? [
        { label: t('stepDetected'), done: true },
        { label: t('stepPrepared'), done: ['install-required', 'restart-required', 'verified'].includes(status.state) },
        { label: t('stepInstalled'), done: ['restart-required', 'verified'].includes(status.state) },
        { label: t('stepVerified'), done: status.state === 'verified' },
      ]
    : []
  const hint = copyState === 'failed'
    ? t('copyFailed')
    : status.state === 'source'
      ? t('sourceHint')
      : status.state === 'unresolved'
        ? t('unresolvedHint')
        : status.state === 'version-mismatch'
          ? t('versionMismatchHint')
          : status.state === 'restart-required' || status.state === 'removal-restart-required'
            ? t('restartHint')
            : status.state === 'verified'
              ? t('verifiedHint')
              : t('repairHint')
  return (
    <div className={css.field}>
      <div className={css.head}>
        <span className={css.label}>{t('repair')}</span>
        <span className={css.version}>{status.target}</span>
      </div>
      <p className={css.state}>{message}</p>
      {progress.length > 0
        ? (
          <ol className={css.steps} aria-label={t('repairProgress')}>
            {progress.map(step => (
              <li key={step.label} className={step.done ? css.stepDone : css.stepPending}>
                <span aria-hidden>{step.done ? '✓' : '○'}</span>{step.label}
              </li>
            ))}
          </ol>
          )
        : null}
      {command === undefined
        ? null
        : (
          <div className={css.commandBox}>
            <code className={css.command}>{command}</code>
            <button type="button" className={css.copy} onClick={() => { void copy() }}>
              {t(copyState === 'copied' ? 'copied' : buttonLabel)}
            </button>
          </div>
          )}
      <p className={copyState === 'failed' ? css.invalid : css.hint}>
        {hint}
      </p>
    </div>
  )
}
