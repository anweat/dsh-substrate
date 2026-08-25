# Discussion 草稿 —— 10 处悬空设计令牌(含插件设置面板的错误态)

> 拟发到 Discussion #4253 下,或作为独立主题。以下是正文。

---

外壳把设计令牌定义在 `body` 与 `body[data-ds-dark-theme]` 上,所以每个插件的 CSS 都免费继承整套词表。我在给这套词表做一份可校验的契约时,拿它先扫了一遍官方自己的 `packages/client`,发现 **10 处引用了仓库中根本不存在的令牌,且没有回退值**。

`var()` 引用未定义的自定义属性且无回退,该声明在 *invalid at computed-value time* 阶段失效:继承型属性退回继承值,非继承型退回 initial。所以这些声明不是"用了默认色",而是**静默不生效**。

## 最重的一处:插件设置面板的校验错误不是红色

`--dsw-alias-label-error` 在整个仓库**没有任何定义**,被裸用了三处:

```
packages/client/ui-settings-plugins/src/client/fields.module.css:98    border-color
packages/client/ui-settings-plugins/src/client/fields.module.css:105   color
packages/client/ui-settings-plugins/src/client/PluginCard.module.css:116  color
```

```css
.inputInvalid {
  composes: input;
  border-color: var(--dsw-alias-label-error);
}
.invalid {
  color: var(--dsw-alias-label-error);
}
```

把这两条规则原样放进浏览器,和同一份规则、令牌存在时对比:

```
error text   今天         rgb(26, 26, 26)     <- 正文黑
error text   令牌存在时    rgb(220, 38, 38)    <- 该有的红
input border 今天         rgb(0, 0, 0)        <- currentColor
input border 令牌存在时    rgb(220, 38, 38)
```

也就是说,**插件配置填错时,错误文案用正文颜色渲染,失效输入框的边框也不是红的**。校验仍在工作,只是没有视觉指示。

## 全部 10 处

| 令牌 | 位置 |
|---|---|
| `--dsw-alias-label-error` | `ui-settings-plugins/fields.module.css:98,105` · `PluginCard.module.css:116` |
| `--dsw-alias-label-quaternary` | `ui-agent-preset/AgentPresetSeat.module.css:31` · `ui-tool/ToolRow.module.css:118` |
| `--dsw-alias-fill-tsp-secondary` | `ui-agent-preset/AgentPresetLabel.module.css:11` |
| `--dsw-alias-line-secondary` | `ui-conversation/chat/ContextBody.module.css:19` |
| `--dsw-alias-separator-primary` | `ui-conversation/chat/StatsLine.module.css:23` |
| `--dsw-alias-fill-l2` | `ui-jobs/JobListAction.module.css:91` |
| `--dsw-font-mono` | `ui-jobs/JobListAction.module.css:101` |

另有 3 处 `var(--dsw-font-mono, ui-monospace, …)` **带回退值**,行为正常,不在此列 —— 区分这两者正是这条规则唯一判定为缺陷的依据。

看命名,前六个像是随主题重构改过名的 `alias` 令牌,引用点没跟上。

## 顺带:词表本身没有导出面

做这份契约时的起因是另一件事。`design-platform.css` 里 **350 个令牌**、三层结构(73 `static` / 78 `alias` / 11 `specific`,另有 181 个 markdown 排版令牌),`alias` 层 78 个里有 66 个在暗色下翻转,`static` 层 73 个里只有 1 个。

这个分层正是插件作者需要知道、而今天无从发现的:**`alias` 命名角色并随主题翻转,`static` 命名固定色值不翻转**;主题相关的属性该取 `alias`。

但 `ui-theme` 不是平台种子词,`design-platform.css` 也没有具名导出路径 —— 这 350 个令牌只能从 `./src/*` 这个原始逃生口够到。**有效但无契约**:能用,但没有东西告诉你有什么,也没有东西在令牌改名时接住漂移 —— 上面那 10 处正是漂移的结果。

如果有兴趣,把词表生成成一个 TS 联合类型是很小的一件事(从外壳自己的样式表生成,不手工维护),漂移就会变成类型错误而不是运行时的空规则。

## 工具

扫描器和它的 43 条断言在这里:
https://github.com/anweat/dsh-ecosystem-conflicts/blob/master/arbitration/tokens.mjs

```bash
node arbitration/tokens-cli.mjs lint <dsh-root>
```

它有三条规则,但**只有 `dangling` 决定退出码**。另两条(主题属性上用 `static` 层、写死不透明颜色)有正当例外 —— 品牌色渐变在两色下故意一致,`--dsw-alias-tooltip-bg` 浅色 850 / 暗色 750 两色都深所以浮层上白字是对的 —— 所以它们只建议,不失败构建。当前仓库上它们报 13 处,我看过的都是有意为之。

---

## English

The shell defines its design tokens on `body` and redefines them under `body[data-ds-dark-theme]`, so every plugin's CSS inherits the whole vocabulary for free. While building a checkable contract for that vocabulary I ran it over `packages/client` itself, and it found **10 references to tokens that exist nowhere in the repository, with no fallback**.

A `var()` reference to an undefined custom property with no fallback makes the declaration *invalid at computed-value time*: inherited properties fall back to the inherited value, non-inherited ones to initial. These declarations do not pick up a default colour — they silently do nothing.

### The heaviest: validation errors in the plugin settings panel are not red

`--dsw-alias-label-error` has **no definition anywhere in the repository** and is used bare in three places (`ui-settings-plugins/fields.module.css:98,105` and `PluginCard.module.css:116`). Those exact rules in a browser, against the same rules with the token defined:

```
error text    today        rgb(26, 26, 26)     <- body black
error text    if defined   rgb(220, 38, 38)    <- the intended red
input border  today        rgb(0, 0, 0)        <- currentColor
input border  if defined   rgb(220, 38, 38)
```

So when a plugin's config fails validation, the message renders in ordinary body colour and the invalid input's border is not red. Validation still works; it just has no visual indication.

### All ten

| token | where |
|---|---|
| `--dsw-alias-label-error` | `ui-settings-plugins/fields.module.css:98,105` · `PluginCard.module.css:116` |
| `--dsw-alias-label-quaternary` | `ui-agent-preset/AgentPresetSeat.module.css:31` · `ui-tool/ToolRow.module.css:118` |
| `--dsw-alias-fill-tsp-secondary` | `ui-agent-preset/AgentPresetLabel.module.css:11` |
| `--dsw-alias-line-secondary` | `ui-conversation/chat/ContextBody.module.css:19` |
| `--dsw-alias-separator-primary` | `ui-conversation/chat/StatsLine.module.css:23` |
| `--dsw-alias-fill-l2` | `ui-jobs/JobListAction.module.css:91` |
| `--dsw-font-mono` | `ui-jobs/JobListAction.module.css:101` |

Three further uses of `var(--dsw-font-mono, ui-monospace, …)` **carry a fallback** and behave correctly; they are excluded. Distinguishing those two is the whole basis on which this rule calls something a defect. From the naming, the first six look like `alias` tokens renamed during a theming pass whose reference sites did not follow.

### Incidentally: the vocabulary has no export surface

`design-platform.css` holds **350 tokens** in three tiers — 73 `static`, 78 `alias`, 11 `specific`, plus 181 markdown typography tokens. 66 of the 78 `alias` tokens are redefined under the dark theme; 1 of the 73 `static` ones is.

That tier split is exactly what a plugin author needs and cannot currently discover: `alias` names a role and flips with the theme, `static` names a fixed palette entry and does not. Anything theme-sensitive should reach for an alias.

But `ui-theme` is not a platform seed word and `design-platform.css` has no named export path, so those 350 tokens are reachable only through the `./src/*` raw escape hatch. Usable, but unpublished: nothing tells an author what exists, and nothing catches a rename — which is what the ten above are.

If there is interest, generating the vocabulary into a TypeScript union from the shell's own stylesheets is a small change, and it turns drift into a type error rather than a blank rule at runtime.

### Tooling

Scanner and its 43 assertions: https://github.com/anweat/dsh-ecosystem-conflicts/blob/master/arbitration/tokens.mjs

```bash
node arbitration/tokens-cli.mjs lint <dsh-root>
```

Three rules, but **only `dangling` decides the exit status**. The other two have legitimate exceptions — a brand gradient is deliberately identical in both themes, and `--dsw-alias-tooltip-bg` is `neutral-bluish-850` light and `-750` dark, both dark, so light text written as a literal on a tooltip is correct. They report 13 findings on the current tree and every one I looked at was intentional.
