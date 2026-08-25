# 实验工作流

冷启动读这一份就够。**不要重新推导机制**——结论在 `D:\codeproject\dsh-plugin\docs\插件冲突底座-机制调研.md`,证据已公开在 https://github.com/anweat/dsh-ecosystem-conflicts

## 环境

```
本仓库    D:\codeproject\dsh-lab            dsh 独立克隆(分支 codex/dsh-0.1.1-rc.2-adaptation)
上游对照  D:\codeproject\deepseek-harness   用户的工作仓库,不要改
设计文档  D:\codeproject\dsh-plugin\docs\插件冲突底座-机制调研.md
生态管线  <scratchpad>/dsh-eco             采集/分析/报告(9,873 个真插件的数据)
```

依赖已装(pnpm 11.7.0)。实验用 `node --import tsx/esm` 直接跑 TS 源码,不需要 build。

## 常用命令

```bash
node run-experiments.mjs           # 跑全部,每个实验一行
node run-experiments.mjs isolate   # 只跑名字含 isolate 的
node run-experiments.mjs --list    # 看注册表 + 上次结果,不执行
```

结果写进 `STATUS.json`。**先读 STATUS.json,不要盲目重跑。**

## 进度

### P0 机制验证 —— 完成(33/33)

| 实验 | 断言数 | 结论 |
|---|---|---|
| `lab-isolate-proxy.ts` | 10 | isolate 给子树独立实例;`ctx.root` 从 realm 内可达真实现;**一个 realm 只能一个实例**,归属从调用方上下文推断 |
| `lab-real-registry.ts` | 12 | 真 `ToolRuntime` 下两个 scope 可 claim 同名;**链序即优先级,不是激活顺序**;不改名 |
| `lab-loader-isolate.ts` | 6 | `cordis:group` + `isolate` **纯配置声明**即可拦截,零上游改动 |
| `lab-event-order.ts` | 5 | `prepend` 稳拿头位;哨兵对可检测短路;**`tools.guard()` 免疫短路** |

### P1 裁决层(L2)—— 完成

代码在 `D:\codeproject\dsh-plugin\plugins\dsh-conflict-substrate\`,测试用 `node run-tests.mjs`。

关键结果(`bin/baseline.mjs`,语料 9,617 条记录 / 8,540 去重包名 / 52,301 贡献):

| | |
|---|---|
| 现状全部同装 | **581 个格会让注册表抛错,牵涉 896 包(10.5%)**,任一个即启动失败 |
| 裁决后 | intact 77.4% · adapted 13.1% · degraded 9.4% → **共存 90.6%** |
| 成对共存 | 今天会互相炸的 4,000 对里,**98.5% 裁决后可共存** |
| 关键结论 | 581 起工具名冲突**全部解为 layer,没有一个需要改模型可见的名字**;剩余损失 100% 在前端 |

### P2 适配层(L3)—— 完成

| 适配器 | 状态 | 断言 |
|---|---|---|
| `emit-patch` | ✅ 完成 | 26 —— 建组 / 重新安家 / 撤下前端半,并用 `applyEntryPatches` 镜像重放验证 |
| `scope-chain` | ✅ 完成 | 24 —— 传递顺序、**环检测与降级**、绑定顺序 |
| `realm-proxy` | ✅ 完成 | 17 —— 路由改写:去掉重复路径抛错、只改写落败者、归属取自调用方 |
| `emit-preset` | ✅ 完成 | 24 —— agent 平面组合;**一个预设一个 scope,故争用者不可同处** |
| `client-gate` | ✅ 并入 `emit-patch` | 主机行 `disabled` 即撤下前端半,不需要独立发射器 |

### P3 集成与两种模式 —— 完成

| 实验 | 断言 | 结论 |
|---|---|---|
| `lab-substrate-e2e` | 18 | 裁决→排链→挂载在真 `ToolRuntime` 上成立;名字不变,落败者其它工具仍可见 |
| `lab-gatekeeper-timing` | 9 | **冲突发生在 loader 应用期,早于任何 agent**;但 entry list 那时已完整且可预测冲突 |
| `lab-gate-ordering` | 7 | 文件位置零保证;**`inject` 是 entry 选项**,补丁层可让第三方行依赖底座,依赖图强制顺序 |
| `lab-gatekeeper-plugin` | 13 | 真启动里 veto/report/clean 三态正确 |
| `lab-preset-host` | 18 | `standingKeyFor` 组合预设而不绑 agent,底座在其上建链并自己绑定 |
| `lab-scale` | 18 | 全语料 896 scope 同链、7,164 次注册、零抛错 |

### P4 规模 —— 完成

```
裁决 71ms | 排链 48ms | 铸 896 scope 114ms | 7,164 次注册 1,188ms
注册抛错 0 | agent 可见 5,589 | 重名 0 | 争用工具 553 全部解析到赢家
共存 7,740/8,544 (90.6%)
```

**规模测试发现的产品缺口**:`run_code` 是无条件保留名,scope 分层对它无效,已在裁决中单列为 `drop`。这个类别只有把全语料灌进真注册表才会暴露。

**scope 链的实测结论**:链长 896、顺序约束 1,492、**100% 可满足、零环**。线性链的限制在真实生态里不构成问题(约束只在两个 scope 争同名时产生,成环需要两个包在两个名字上互为胜负)。环检测仍留在实现里并有断言覆盖。

**`emit-patch` 的契约**:发射器整体拥有自己的补丁文件,**重新生成而非追加**——补丁行没有条件守卫(方言不支持),叠加会重复建组。这一点写进了 JSDoc,并有断言把该失败模式钉住。

### P3.5 前端专项 —— E3 完成

| 实验 | 断言 | 结论 |
|---|---|---|
| `lab-client-priority` | 12 | **原型两文件 37 行**:`BootPluginRow.priority` + `SlotRegistry.seedPriorities`。争用座位由"撤下整个插件前端半"变为普通遮蔽;落败者其它条目照常渲染;显式 priority 压过清单默认;未 seed 时行为逐字节不变 |

`bin/whatif-client-priority.mjs` 在全语料上量化:降级 **804 → 1**(803 包,9.4%),共存 **90.6% → 100.0%**。剩下 1 例是保留名,任何 rank 都救不了。已发 Discussion #4253。

- [ ] E1 代价量化 —— E3 的 803 已回答同一问题,价值低
- [ ] E2 A/B 启动成功率 —— 规模测试的零抛错已覆盖大半

### P4.5 设计令牌契约(L4)—— 完成

外壳把令牌定义在 `body` 与 `body[data-ds-dark-theme]` 上,插件 CSS **环境继承**整套词表。所以令牌可用但未发布:没有导出面告诉作者有哪些名字、哪些会随主题翻转、哪些引用已经失效。

实现在 `dsh-plugin/plugins/dsh-conflict-substrate/src/tokens.mjs`,49 条断言。

| | |
|---|---|
| 词表 | **350 个令牌** / 7 层。`alias` 78 个中 66 个暗色翻转;`static` 73 个中仅 1 个 |
| 规则 | `dangling`(**缺陷**)· `static-on-themed`(建议)· `pinned-literal`(建议) |
| 官方代码首跑 | **10 缺陷 + 13 建议** |

**只有 `dangling` 自证是缺陷**——令牌无定义且无回退,声明在运行时 invalid at computed-value time。另两条有正当例外:品牌色在两色下故意一致,两色都深的浮层(tooltip `--dsw-alias-tooltip-bg` 浅色 850 / 暗色 750)上白字是对的。误把它们判成错会让 lint 在第一个用户手里就被丢掉,所以它们只建议、不决定退出码。

首跑找到的最重的一处:`--dsw-alias-label-error` 在仓库中**无任何定义**,被 `ui-settings-plugins` 的 `fields.module.css:98,105` 与 `PluginCard.module.css:116` 裸用。浏览器实测:错误文案渲染为 `rgb(26,26,26)` 正文黑而非 `rgb(220,38,38)`,失效输入框边框退回 `currentColor`。**插件设置面板的校验错误今天不显示红色。**

```bash
node bin/tokens.mjs emit <dsh-root> [out.d.ts]   # 发射 TS 声明
node bin/tokens.mjs lint <dsh-root> [scan-root]  # 对照检查,仅缺陷决定退出码
```

### P4.6 面板脚手架(L4)—— 完成

面板(槽条目 + 喂它的后端)是生态最重复的形态,**2,155 个包两样都注册**,路径写三遍、无人校对。实现在 `src/panel.mjs`(44 断言)+ `lab-panel.ts`(11 断言,打真服务)。

两条实测的运行时事实定了它的形状:

**后端侧没有任何一条接缝是相加的。** `webServer.register` 撞路径抛错;`connection.rpc.handle` 最终也落成 prefix 路由,同样抛错;`intercept('/api')` 全进程只有一个座位。所以路径不是插件可以自由取的名字。

**身份取自调用方 fiber。** `SlotRegistry` 从 `this.ctx.fiber.name` 盖 `registrant`,`connection.rpc` 捕获 `owner = this.ctx`。真注册表上实测:

```
mountPanelClient(pluginCtx,   …)   registrant = plugin-a       身份保住
mountPanelClient(scaffoldCtx, …)   registrant = the-scaffold   包裹式的失败态
```

所以脚手架是插件**用自己的 ctx 调用的函数**,发射注册而不包裹注册。包裹会把整个生态盖成同一个名字,priority 仲裁再也分不出谁是谁。

`channelFor('@scope/thing','main')` → `/scope-thing.main`。用 `.` 连接而非嵌套,因为真文法 `^\/[A-Za-z0-9._~-]+$` **只认一段**——这条是打真服务才发现的,我最初派生的 `/a-plugin/data` 被直接拒绝。

`bin/whatif-panel-channels.mjs` 在 503 仓库路由样本上量化:争用路径 **49 → 0**,牵涉的 32 个包全部无需让位。争用方是同源分叉(`/sidebar/*` 四个包、`/dsh-market/*` 四个包),但分叉改了包名,所以按包名派生确实能分开;分开后两者共存,而今天同装是启动失败。

脚手架**不掩盖真冲突**:同一个包挂两次仍然抛错,handler 与声明不符在挂载期就失败。

### P3.6 免重启 —— 完成(21 断言,`lab-no-restart.ts`)

**主机侧:改补丁层不重启,且爆炸半径就是改动的那一行。**

`hmr.registerConfig(file, …)` → 重读补丁 → `entry.update({config:{patches}})`。实测:

| 编辑 | 代价 |
|---|---|
| 停掉一行 | 只有那一行 dispose,其它插件既不 dispose 也不重新 apply |
| 清空补丁 | 只有被停的那行重新 apply |
| **整体重写补丁文件** | 未变的行不动 —— 发射器"重新生成而非追加"的契约代价是一行,不是整棵树 |
| 改一行的 config | 那一行 dispose + apply,同文件里其它行不动 |
| 写入坏补丁 | 树不被拆,进程存活,之后的好补丁照常生效 |

第三行是这个实验存在的理由:如果重写整份文件等于重建整棵树,底座每改一次决定都要全体重启,没人会交互式地用它。

**浏览器侧:名册变更没有通道,需要刷新页面。**

`/plugins/events` 上只有两种帧:`graph` 与 `rebuilt`。实测三条:

```
PASS  主机确实订阅了图变化 —— onGraphChanged 会触发
PASS  主机收到了图变化通知,却没有往通道上写任何东西
PASS  同一条通道上 rebuilt 帧照常到达 —— 沉默不是通道坏了
```

主机侧 `graph` 帧**只在连接建立那一刻写一次**(`packages/client/hmr/src/index.ts:160`),之后唯一的订阅是 `onRebuilt`。`onGraphChanged` 确实被订阅了,但只用来重新同步 bundle 文件监视(`:138`),不转发。客户端则显式忽略:

```js
case 'graph':
  // Connect-time snapshot, unused.
  break
```

**所以底座的交互式故事是:主机平面的决定即时生效,前端平面的决定需要刷新页面。**

这是第 4 项上游请求的位置,与 `BootPluginRow.priority` 同构:能力都在,只差转发。但它不像 priority 那样是纯增量——客户端要做名册对账(`loader.create` / 移除),涉及 loader 的增删语义,不是几行。**未做原型,不做半个修复。**

## 加新实验

1. 写 `lab-<名字>.ts`,用 `check(label, cond, detail)` 打 `PASS`/`FAIL`,失败时 `process.exit(1)`
2. 在 `run-experiments.mjs` 的 `REGISTRY` 里加一行,写清**它回答什么问题**
3. `node run-experiments.mjs --list` 会提示未注册的 `lab-*.ts`

## 对外

- Discussion #4253:https://github.com/deepseek-ai/deepseek-harness/discussions/4253
- 证据仓库:https://github.com/anweat/dsh-ecosystem-conflicts

上游 issues 关闭、不接受 PR,**Discussions 是唯一渠道**。数据更新后记得同步证据仓库(`<scratchpad>/dsh-eco/12-package.mjs` 重新打包)。
