/**
 * Card styling, transcribed from `ui-settings-plugins`' own stylesheets.
 *
 * A third-party card cannot import them: `PluginCard.module.css` and
 * `fields.module.css` are internal to that package, and only their prop types
 * are exported. So the values are copied — radius, padding, type scale, the
 * two-layer background that marks an open card — because a card that merely
 * looks similar reads as a different kind of object in a stack with three
 * native ones.
 *
 * Injected as a stylesheet rather than inline props so the `:hover`,
 * `:focus-visible` and `:disabled` states exist at all; inline styles cannot
 * carry them, and dropping them would make this card the only one in the stack
 * with no focus ring.
 *
 * Every colour is an `alias` token, the tier a theme redefines. A `static`
 * token here would keep its light value in dark mode.
 */

/** Class names, prefixed so nothing here can collide with the host page. */
export const css = {
  card: 'dsh-substrate-card',
  cardOpen: 'dsh-substrate-card-open',
  header: 'dsh-substrate-header',
  headText: 'dsh-substrate-head-text',
  name: 'dsh-substrate-name',
  description: 'dsh-substrate-description',
  pending: 'dsh-substrate-pending',
  chevron: 'dsh-substrate-chevron',
  chevronOpen: 'dsh-substrate-chevron-open',
  body: 'dsh-substrate-body',
  field: 'dsh-substrate-field',
  head: 'dsh-substrate-field-head',
  label: 'dsh-substrate-label',
  reset: 'dsh-substrate-reset',
  input: 'dsh-substrate-input',
  inputInvalid: 'dsh-substrate-input-invalid',
  hint: 'dsh-substrate-hint',
  invalid: 'dsh-substrate-invalid',
  row: 'dsh-substrate-row',
  state: 'dsh-substrate-state',
  version: 'dsh-substrate-version',
  steps: 'dsh-substrate-steps',
  stepDone: 'dsh-substrate-step-done',
  stepPending: 'dsh-substrate-step-pending',
  commandBox: 'dsh-substrate-command-box',
  command: 'dsh-substrate-command',
  copy: 'dsh-substrate-copy',
  footer: 'dsh-substrate-footer',
  status: 'dsh-substrate-status',
  failed: 'dsh-substrate-failed',
  discard: 'dsh-substrate-discard',
  save: 'dsh-substrate-save',
} as const

const SHEET = `
.${css.card} {
  list-style: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color .16s, background .16s;
}
.${css.card}:hover { border-color: var(--dsw-alias-label-dimmed); }
.${css.cardOpen} {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
.${css.header} {
  width: 100%;
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
}
.${css.header}:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.${css.headText} { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.${css.name} {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}
.${css.description} {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.${css.pending} {
  flex: none;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.${css.chevron} { flex: none; color: var(--dsw-alias-label-tertiary); transition: transform .16s; }
.${css.chevronOpen} { transform: rotate(180deg); }
.${css.body} {
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin: 0 16px;
  padding-bottom: 8px;
}
.${css.field} { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.${css.field} + .${css.field} { border-top: 1px solid var(--dsw-alias-border-l2); }
.${css.head} { display: flex; align-items: center; gap: 8px; }
.${css.label} {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.${css.reset} {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.${css.reset}:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.${css.reset}:disabled { cursor: default; }
.${css.input} {
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.${css.input}:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.${css.input}:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.${css.inputInvalid} { border-color: var(--dsw-alias-state-error-primary); }
.${css.hint} { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.${css.invalid} { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.${css.row} { display: flex; align-items: center; gap: 8px; }
.${css.state} {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.${css.version} {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
.${css.steps} {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px 12px;
  margin: 2px 0;
  padding: 0;
  font-size: 12px;
}
.${css.stepDone}, .${css.stepPending} { display: flex; align-items: center; gap: 6px; }
.${css.stepDone} { color: var(--dsw-alias-label-secondary); }
.${css.stepPending} { color: var(--dsw-alias-label-tertiary); }
.${css.commandBox} {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  border: 1px solid var(--dsw-alias-border-l2);
}
.${css.command} {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.${css.copy} {
  flex: none;
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  padding: 4px 10px;
  background: none;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.${css.copy}:hover { border-color: var(--dsw-alias-label-dimmed); }
.${css.copy}:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.${css.footer} {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 4px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.${css.status} {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.${css.failed} { color: var(--dsw-alias-state-error-primary); }
.${css.discard}, .${css.save} {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
.${css.discard} {
  border-color: var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-secondary);
}
.${css.discard}:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
.${css.save} { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.${css.discard}:disabled, .${css.save}:disabled { opacity: 0.4; cursor: default; }
.${css.discard}:focus-visible, .${css.save}:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
`

const MARKER = 'data-dsh-substrate-styles'

/**
 * Put the stylesheet in the document once.
 *
 * Idempotent by marker attribute rather than by module state: the client
 * bundle can be evaluated again across a reconnect, and a second `<style>`
 * with identical rules is invisible until someone reads the DOM.
 *
 * @returns nothing.
 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[${MARKER}]`) !== null) return
  const style = document.createElement('style')
  style.setAttribute(MARKER, '')
  style.textContent = SHEET
  document.head.append(style)
}
