# 实测记录

2026-09-09 的 [alpha.5 后续版本验收](../docs/post-alpha5-compatibility.md) 使用 npm 精确版本 `0.1.2-rc.1`、`0.1.3-alpha.2`、`0.1.5-alpha.1` 分别安装打包插件，并完成真实启动、CLI apply/revert、15 组重复 ID、5 组配对计时、Host/设置/RPC 与重启后 verified 闭环。Git tag `0.1.3-alpha.1` 没有对应 npm app-boot 包，因此只作源码对照。另在官方 `dsh-v0.1.5-alpha.1` 源码上通过 207 条机制断言，确认工具 scope/自适应运行时仍有效，并把 panel 后端迁到共享认证 `/api` 的精确 Fetch 路由。

2026-09-07 的交付验收以 [真实 pnpm 插件矩阵](../docs/pnpm-plugin-compatibility.md) 为准：npm alpha.2～.5 的 app-boot 内嵌 Include，需修复实际启动包；四版安装后的 CLI、Host、设置、RPC 与客户端状态控制器均已验证。下面的源码/独立 include 测试保留为分层证据，不再作为 npm 全插件支持的替代。

2026-09-07 对 [dsh-browser #11 的真实包复验](../docs/browser-issue11-verification.md) 定位并修正了 group 内 ID 漏扫。修正后的 ID 去重 + browser 服务隔离 + 已有 tools scope shim 已通过两组真实包 Host 共存验证，65 笔工具注册归属完整。仅安装本插件仍不会自动生成服务 realm/工具 scope；以下历史 ID 去重结果不能单独视为完整兼容结论。

2026-09-07 的 alpha 适配见 [逐版本矩阵](../docs/alpha-compatibility.md) 与 [机器可读证据](../docs/alpha-compatibility.json)。该记录区分真实 Host/面板机制、400 包 Tools/Scope 组合、完整 profile 和 npm loader 修复,不把其中一个层面的通过推广成全部通过。下文原始测试数量和旧版浏览器记录保留为历史。

对照 `dsh-v0.1.1-rc.2-5-g50854a854f`(`0.1.1-rc.2`)。

## 1. 启动前检查 vs 真实报告的冲突

复现 [anweat/dsh-browser#11](https://github.com/anweat/dsh-browser/issues/11) 的组合——内置 browser bundle 与第三方插件都插入 `id: browser`:

```
$ dsh-substrate-check repro.yml
读入 5 行

1 处会让整个 profile 起不来:

  entry id "browser" 被 2 行认领
      @deepseek-ai/dsh-builtin-browser
      @anweat/dsh-browser

    · EntryGroup.update rejects the id list before it reads `disabled`,
      so switching a row off leaves it holding the id
    · applyEntryPatches skips `id` when copying overrides,
      so a patch cannot rename a row

    出路(后续补丁层不在其列):
      · 拥有其中一行的插件,在它自己的 cordis.patch.yml 里改掉那个 id
      · 或者干脆不写 id:ensureId 会生成一个空闲的
      · 或者把 id 做成配置项

退出码 1
```

它把 `TypeError: duplicate loader entry id: browser` 换成了一份说明谁在抢、为什么补丁修不了、以及唯一出路的报告。**它没有假称能修。**

## 2. 插件本体挂在真 profile 上

`examples/headless-agent/cordis.yml`(25 个出厂行)+ 底座那一行,真 `boot()`:

```
dsh-substrate: 15 个工具在全局命名空间,0 个重名
  基于 38 次 fiber 状态变化后的静默窗口 —— 这是启发式,不是"全部就绪"的保证。
  entry id / 路由 / 槽位的争用发生在本插件挂载之前,这里看不到;
  用 dsh-substrate-check 在启动前查。
```

15 与直接读注册表得到的出厂工具数一致。

## 3. 五个真实 browser 插件的实测

从 npm 拉下五个已发布的包(`@anweat/dsh-browser@0.1.10`、`dsh-builtin-browser@0.1.20`、`dsh-browser-playwright@0.1.1`、`dsh-browser@0.1.0`、`dsh-plugin-browser@0.1.0`),读它们真实的 `cordis.patch.yml`:

```
五个包全部写死 id: browser        —— 组合后 9 行,重复 id: browser × 5
```

补丁施加后:

```
browser                          @anweat/dsh-browser        (第一个认领者保住)
dsh-browser                      dsh-browser
dsh-browser-playwright-service   dsh-browser-playwright/service
dsh-builtin-browser-browser      dsh-builtin-browser/browser
dsh-plugin-browser               dsh-plugin-browser
… 另外 4 行本来就唯一

还有重复吗:没有 —— 五个 browser 插件可以同装
```

**但这只过了第一关。** 同一批包里还有 **11 个工具名撞车**(`browser_click`/`browser_type`/`browser_screenshot` 各 4 家),那属于注册期,补丁不管。分层处理后 agent 看到 53 个工具(加前缀会是 72 个,多出 19 个近义工具)。

## 4. 机制断言

| | |
|---|---|
| [`lab-duplicate-entry-id.ts`](../experiments/lab-duplicate-entry-id.ts) | 14 —— 复现、`disabled` 无效、补丁改不了 id、**不写 id 则永不撞车**、id 唯一后正常、**抛错时零插件挂载** |
| [`plugin/test/check.spec.mjs`](test/check.spec.mjs) | 23 —— 含真实案例;被停的行仍算数;结论限定在自己看得见的范围;修复建议不再要求用户猜 profile 或安装路径 |
| [`plugin/test/stage-patch.spec.mjs`](test/stage-patch.spec.mjs) | 20 —— 写进 pnpm-workspace.yaml;不破坏 DSH 与用户各自的键;关闭后清单逐字还原;幂等 |
| [`plugin/test/repair.spec.mjs`](test/repair.spec.mjs) | 17 —— 声明/重链/重启/验证分态;撤销双等待态;版本不匹配先于写入拒绝;外部执行器只在真实安装根运行;CLI 不暴露内部状态码 |
| [`lab-auto-dedup.ts`](../experiments/lab-auto-dedup.ts) | 11 —— 写死的重复 id 零作者改动自动解决;同包装两次照样响亮报错 |
| [`lab-derived-entry-id.ts`](../experiments/lab-derived-entry-id.ts) | 13 —— 包名派生的 id 跨启动一致;派生必须早于 applyEntryPatches |
| [`lab-id-injection.ts`](../experiments/lab-id-injection.ts) | 6 —— 内核那段检查可从外部替换且可逆;但插件不能是替换它的人 |

## 5. 设置卡片与安装级修复

浏览器里跑的,不是构建通过:

```
未装插件启动   插件配置页没有本插件的痕迹;
              settings.yaml 里留着的孤儿 dsh-substrate 段落不影响启动
已装插件启动   列表出现“插件兼容性”,收起态、有 chevron,与相邻卡片同一套 chrome
改设置        250 → 800 → 保存 → settings.yaml 里出现 settleMs: 800
恢复默认      → 保存 → 该字段从用户层消失,输入框回到 250
重启          存储的 800 回来,"恢复默认"链接在(已覆盖)
浅色主题       整张卡片跟着翻,与官方卡片无缝
```

旧版浏览器按钮曾走过以下四态;这段是问题复现记录,**不是当前交互契约**:

```
source       本机 dsh 从源码跑,卡片说明原因,不给按钮   ← 这台机器的真实状态
writable     "未写入。" + 写入声明                       ← 用合成安装目录验证
按下         2431 字节补丁文件落地,声明追加进
             pnpm-workspace.yaml,nodeLinker: hoisted 仍在;
             提示给出目录与"跑 pnpm install 再重启"
declared     按钮变"撤销"
撤销          清单还原到写入前的字节,补丁文件删除
```

这个按钮把“声明已写入”压成一个类似设置开关的状态,容易被读成“当前 DSH 已经修好”,因此已经移除。当前卡片只读 Host 状态并复制外部修复命令;写入、`pnpm install` 与磁盘验证由 `dsh-substrate repair` 在进程外完成。

新状态机的自动验证:

```
available → install-required → restart-required → verified
verified  → removal-install-required → removal-restart-required → available
```

`version-mismatch`、`source`、`unresolved` 都在写文件之前拒绝。`repair.spec.mjs` 用真实临时目录和 junction 验证外部执行器只在解析出的安装根运行;`patch-target.spec.mjs` 继续覆盖 pnpm 嵌套 store 取最外层工作区。

配套断言:[`plugin/test/controller.spec.mjs`](test/controller.spec.mjs) 32 条,[`plugin/test/patch-target.spec.mjs`](test/patch-target.spec.mjs) 27 条,[`plugin/test/repair.spec.mjs`](test/repair.spec.mjs) 17 条。

2026-09-07 又在专用的真实 DSH `0.1.2-alpha.4` 源码部署上验证了新版只读卡片:Host 正常挂载,插件配置列表出现“插件兼容性”,展开后的暗色主题布局与相邻卡片一致;状态精确显示源码 loader 目录,不显示命令按钮,并明确说明源码工作区为什么不提供安装级修复。修正状态专用提示后重新加载,浏览器控制台为 0 条 warning/error。对应 CLI 也输出同一结论,不再把 `source` 这类内部枚举直接交给用户。

这次真机只能覆盖 `source` 分支,因为源码 checkout 正是修复器主动拒绝的环境。复制按钮与实际 pnpm 注入仍需一套 loader 恰为 `1.0.7` 的**打包安装版**做最终交互/重启闭环;自动测试已经覆盖命令生成、真实安装根、磁盘 marker 和全部状态迁移,但不能冒充那次尚未具备条件的正式安装验证。

## 开发中被真机否掉的六处

**`ctx.on('ready', …)` 不存在。** 我按直觉写了这个事件,Cordis 里根本没有——插件静默注册了一个永不触发的监听,什么都不做。第一次真跑就发现:零输出。改用 `internal/status`,并且现在明说它是静默窗口启发式,不是"全部就绪"的保证。

**`emit-patch` 的 rename 补救有结构性盲区。** 它的 `rows` 输入是 `Map<id, row>`,而 Map 放不下两个同 id 的行——正是冲突本身。所以它会为一个它看不见的冲突发出一份照样起不来的补丁。现已改为需要显式告知哪些 id 被多行认领,遇到就拒绝发射并说明(5 条断言)。

**`pnpm` 字段的位置写错了。** 我按印象把用法写成 `package.json` 里的 `pnpm.patchedDependencies`,还发布了出去。pnpm 11 **不再读那个位置**——它打一条 WARN 然后忽略你的设置,所以照着做的人会以为配好了其实什么都没配。做对照实验(同一份补丁文件,三个位置)才发现,正解是 `pnpm-workspace.yaml`。

**卡片注册成功但不渲染。** 卡片一度渲染正常,改成只读版后消失了——`apply` 跑了、槽就绪了、`slots.register` 调用了、零报错、bundle 也正常送达。我连着换了四轮配置去猜,全落空。真正的原因在 `ui-settings-plugins/tab-store.ts`:插件配置页发布的是 **Host 服务的命名空间** 与 **注册进槽的卡片** 的交集,键匹配不上的卡片被无声丢弃。我删掉那个开关时连命名空间注册一起删了,卡片就再也没有落脚点。**教训不是"少删了一行",是我该先读那个包的取数逻辑,而不是照着参照实现逐个换字段试。**

**按钮写进 profile 是第二次犯同一个错。** 删掉旧开关时我判定"补丁没法从插件投放",这个判断错了 —— 错的只是目标目录。重做时按钮第一版仍然差点写进 profile,是写 `patch-target.mjs` 时顺着 `healProfilesModuleFallback` 读下去才发现真实位置。**而且同一个坑还有第二层:源码 checkout 里 pnpm 根本不给工作区包打补丁**,那种情况下写下去照样是无声空转。两层都不产生任何可观察的区别,所以分类器四种情况逐个钉死。

**把安装修复画成设置开关,语义仍然是错的。** 写完 `patchedDependencies` 不等于 pnpm 已经重链,重链完成也不等于当前进程加载了新模块。现在把这三道边界拆开,浏览器只报告和复制命令,外部进程执行安装,重启后的 Host 才能给出 `verified`。

前四处合成语料都测不出来:我生成的每个 id 都唯一,而我自己写的实验从不检查一个我发明的事件是否存在。**是这个真实 issue 找出来的。** 后两处则说明“文件写成功”从来不能替代安装与运行时验证。
