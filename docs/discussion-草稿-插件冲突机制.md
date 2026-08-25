# Discussion 草稿(未发布 · 待你确认)

- **目标仓库**:`deepseek-ai/deepseek-harness`(issues 关闭、不接受 PR,**Discussions 是唯一渠道**)
- **分类**:Ideas
- **发布前请确认**:这是以你的账号对外发言,我不会未经你明确同意就发出去

---

## 标题

> 生态实测:9,873 个插件里 553 起工具名冲突会导致启动失败,以及三个可以消除它们的小改动

---

## 正文

### 背景

我扫描了 GitHub 上 12,630 个 dsh 相关仓库,其中 **9,873 个是真实插件**(带 `package.json#dsh` 声明、`cordis.patch.yml` 或实际注册调用)。分析方法是静态的:用与 dsh 相同的 `applyEntryPatches` 算法重放各插件的补丁,再从源码/构建产物里提取注册调用点。

结果里有一个结构性问题,我想先确认理解是否正确,再提三个具体的小改动。

### 一、生态整体站在了 host 平面

```
插入到根的 entry 行:9,216    插入到分组下:0
```

**没有任何一个第三方插件挂在分组下。** 而 `standard` 预设文件写得很清楚,模型可见的东西属于 agent 平面;`agent-presets` 也会对未加入预设的 agent 告警"其工具、提示段、技能目录都解析自空的全局层"。

定量佐证:**web-app 在根上禁用的 24 行,22 行在 standard 预设里重新挂上**(例外只有 `hmr` 和 `tool-str-replace-editor`)。

也就是说全局层设计上应该是空的,而整个生态都挤在里面。我理解这不是生态不守规矩,而是**两个平面的存在没有被插件作者感知到**。

### 二、由此产生的冲突(按运行时后果分类)

| 类型 | 数量 | 牵涉包 | 后果 |
|---|---|---|---|
| 工具名撞车 | 553 | 855 | `tools.register` 抛错 → **启动失败** |
| 撞官方工具名 | 28 | 77 | 同上 |
| entry id 撞车 | 452 | 1042 | 上层补丁只能定位到其中一个 |
| 孤儿补丁 | 89 | 87 | 一行 stderr 后跳过 → **插件静默失效** |
| 配置行争用 | 77 | 381 | 补丁整体替换 config,静默丢字段 |
| single 槽争用 | 24 | 303 | UI 不可见 |

最挤的工具名:`country_info` 84 个包、`element_info` 55、`bash` 44、`memory_search` 37。
最挤的 entry id **全是基础设施**:`storage` 29、`storage-json` 29、`storage-domain` 29、`agent-presets` 26、`code-runtime` 25 —— 插件在各自重新插入宿主本该提供的东西。

### 三、大部分可以在插件侧解决

我在一个独立克隆里验证了(实验可复现):

- `isolate` 是 loader 的一等 entry 选项,`cordis:group` + `isolate` 能让 shim 拦在消费者和真服务之间,**纯配置声明,零上游改动**
- 工具名冲突可以靠 scope 分层解决,`view()` 已有"近的遮蔽远的"语义,**不需要改名**,链序即优先级
- `tools.guard()` 免疫 waterfall 短路,所以底座策略是顺序无关的

所以我不打算请求大的架构改动。**但有三处配置层确实够不到**,想提出来讨论。

### 四、三个具体的小改动

#### 1. 事件监听的数值优先级

`EventOptions` 目前只有 `prepend?: boolean`(二元),而 **1,951 个插件在干预回合或工具管线**(`agent/pre-step` 513、`tools/pre-execute` 349、`llm/stream` 256)。顺序 = 注册顺序 = 激活顺序,配置层不可声明。

更麻烦的是 waterfall 的短路语义:任何监听器不调 `next()` 就静默截断整条链,349 个包共用 `tools/pre-execute`,其中任一个早注册并短路,下游全废。

**建议**:`EventOptions` 增加 `priority?: number`,派发前稳定排序。`register()` 现在已经在 `unshift`/`push` 二选一,改成有序插入即可。

#### 2. 短路可观测(改动最小)

不改变任何语义,只在监听器短路时发一个诊断信号(或 dev 模式记录)。现在这类失效**没有任何痕迹**,插件作者无从排查。

#### 3. `BootPluginRow` 携带 priority

客户端槽位本身有完整的 priority 遮蔽语义,但 `BootPluginRow` 只有 `{ id, inject, immediately }`,客户端 `loader.create({ name })` 没有配置缝。结果是前端冲突只能"二选一禁掉一个",而不是分层让位。

**建议**:`BootPluginRow` 扩展 `priority?: number`,主机侧清单生成时写入,客户端透传。改动集中在 `packages/client/modules`。

### 五、我可以提供的

- 完整数据集(9,873 个插件的贡献目标、冲突分组、来源链)
- 可复现的机制验证脚本
- 如果第 3 项有兴趣,我可以先做一个本地原型验证可行性

主要想先确认:**上面对两个平面的理解是否正确**?如果我理解错了,后面的结论都要重来。

---

## English summary

I analyzed 12,630 dsh-related repositories, of which **9,873 are real plugins**. Static analysis (replaying each plugin's patches through the same `applyEntryPatches` algorithm, plus extracting registration call sites).

**Structural finding**: 9,216 entry rows insert at the root, **zero** insert under a group. The shipped design puts model-facing rows on the agent plane (22 of the 24 rows web-app disables at root are re-mounted in the `standard` preset), so the global layer is meant to be empty — yet the whole ecosystem registers there.

**Consequences**: 553 tool-name collisions + 28 against shipped tools (both throw at registration → boot failure), 452 entry-id collisions, 89 orphan patches that fail silently, 77 contended config rows.

**Most of this is fixable plugin-side** — `isolate` as a loader entry option lets a shim sit between consumer and service with no upstream change, and scope layering resolves tool names without renaming.

**Three things the config layer cannot reach**:
1. `EventOptions` numeric `priority` (currently binary `prepend`; 1,951 plugins intervene in the turn/tool pipeline, and any waterfall listener can silently cut the chain)
2. Observability when a waterfall listener short-circuits (no semantic change, diagnostics only)
3. `BootPluginRow` carrying `priority` so client-side slot conflicts can shadow instead of forcing an all-or-nothing disable

Happy to share the dataset and the reproducible verification scripts. Mainly want to confirm the two-plane reading is correct before building on it.
