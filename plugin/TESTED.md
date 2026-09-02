# 实测记录

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

## 3. 机制断言

| | |
|---|---|
| [`lab-duplicate-entry-id.ts`](../experiments/lab-duplicate-entry-id.ts) | 14 —— 复现、`disabled` 无效、补丁改不了 id、**不写 id 则永不撞车**、id 唯一后正常、**抛错时零插件挂载** |
| [`plugin/test/check.spec.mjs`](test/check.spec.mjs) | 22 —— 含真实案例;被停的行仍算数;结论限定在自己看得见的范围;补丁只在有冲突时才提 |
| [`plugin/test/stage-patch.spec.mjs`](test/stage-patch.spec.mjs) | 20 —— 写进 pnpm-workspace.yaml;不破坏 DSH 与用户各自的键;关闭后清单逐字还原;幂等 |
| [`lab-auto-dedup.ts`](../experiments/lab-auto-dedup.ts) | 11 —— 写死的重复 id 零作者改动自动解决;同包装两次照样响亮报错 |
| [`lab-derived-entry-id.ts`](../experiments/lab-derived-entry-id.ts) | 13 —— 包名派生的 id 跨启动一致;派生必须早于 applyEntryPatches |
| [`lab-id-injection.ts`](../experiments/lab-id-injection.ts) | 6 —— 内核那段检查可从外部替换且可逆;但插件不能是替换它的人 |

## 4. 设置开关的三态

```
ON    已写入 <profile>/pnpm-workspace.yaml 与 patches/...;跑一次安装后重启生效
再 ON  loader 补丁已在本 profile 就位          (幂等,不重复写)
OFF   已撤回;跑一次安装让它离开 node_modules  (清单逐字还原)
```

## 开发中被真机否掉的三处

**`ctx.on('ready', …)` 不存在。** 我按直觉写了这个事件,Cordis 里根本没有——插件静默注册了一个永不触发的监听,什么都不做。第一次真跑就发现:零输出。改用 `internal/status`,并且现在明说它是静默窗口启发式,不是"全部就绪"的保证。

**`emit-patch` 的 rename 补救有结构性盲区。** 它的 `rows` 输入是 `Map<id, row>`,而 Map 放不下两个同 id 的行——正是冲突本身。所以它会为一个它看不见的冲突发出一份照样起不来的补丁。现已改为需要显式告知哪些 id 被多行认领,遇到就拒绝发射并说明(5 条断言)。

**`pnpm` 字段的位置写错了。** 我按印象把用法写成 `package.json` 里的 `pnpm.patchedDependencies`,还发布了出去。pnpm 11 **不再读那个位置**——它打一条 WARN 然后忽略你的设置,所以照着做的人会以为配好了其实什么都没配。做对照实验(同一份补丁文件,三个位置)才发现,正解是 `pnpm-workspace.yaml`。

前两处合成语料都测不出来:我生成的每个 id 都唯一,而我自己写的实验从不检查一个我发明的事件是否存在。**是这个真实 issue 找出来的。** 第三处则是不实测就会一直错下去的那种。
