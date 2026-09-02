/**
 * The settings card.
 *
 * Built from `ui-primitives` and the ambient design tokens rather than the
 * card components `ui-settings-plugins` uses, which are internal to that
 * package. Every colour here comes from an `alias` token, because those are the
 * ones a theme redefines — a `static` token or a literal would pin the light
 * appearance into dark mode.
 */
import { useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubstrateCardFace } from './controller.js'

/** Props the slot binds: the injected face. */
export type SubstrateCardProps = SubstrateCardFace

/**
 * Render the card.
 * @param props - the injected store and toggle.
 * @returns the card.
 */
export function SubstrateCard(props: SubstrateCardProps) {
  const state = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  const on = state.applyLoaderPatch

  return (
    <section
      style={{
        display: 'flex', flexDirection: 'column', gap: 12,
        padding: 16, borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>插件冲突底座</strong>
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
          两个插件抢同一个 loader entry id 时,整个 profile 起不来。打开这个开关会把一份
          去重补丁写进本 profile,让后来者改用它的包名派生 id。
        </span>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button
          onClick={props.toggle}
          disabled={state.saving || !state.writable}
        >
          {on ? '关闭 loader 补丁' : '启用 loader 补丁'}
        </Button>
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
          {state.saving ? '写入中…' : on ? '已写入本 profile' : '未启用'}
        </span>
      </div>

      {on ? (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
          补丁已写入,但还没进 <code>node_modules</code>。跑一次
          {' '}<code>dsh plugin --profile &lt;profile&gt; install</code>{' '}
          再重启才会生效。关掉这个开关会把写入的内容原样撤回。
        </p>
      ) : undefined}

      {state.writable ? undefined : (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
          设置文档当前不可写,开关已禁用。
        </p>
      )}

      {state.error === undefined ? undefined : (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-static-red-500)' }}>
          写入失败:{state.error}
        </p>
      )}
    </section>
  )
}
