# dsh-browser #11 真实包复现

后续发布验收已补充五个重名工具的真实 Chrome 动作，见 [0.1.0 发布验收](release-0.1.0-verification.md)。下文的 `browserActionsTested: false` 是前序启动实验的历史边界，新增证据位于 `local-scoped-release-actions/result.json`，没有覆盖或篡改原始结果。

2026-09-07，复核 [anweat/dsh-browser#11](https://github.com/anweat/dsh-browser/issues/11)（查询时 open，无评论）。**修正 group 内 ID 漏扫后，ID 去重 + 服务 realm + 已有 tools scope shim 已验证 Host 共存。安装级 ID 补丁单独使用仍不解决服务和工具冲突。**

## 版本与边界

| 组 | DSH Host | browser | web-search-pro | builtin-browser |
|---|---|---|---|---|
| 已发布包 | 本地 `dsh-lab` 源码快照，manifest `0.1.1-rc.2`，include `1.0.6`；未声称是精确 release commit | npm `@anweat/dsh-browser@0.1.10` | npm `dsh-web-search-pro@0.1.11` | npm `dsh-builtin-browser@0.1.20` |
| 当前本地包 | 临时 checkout `dsh-v0.1.2-alpha.5`，`db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5` | 本地 `0.1.11-alpha.4`，commit `3c86a061d5d9cd2f78e180c5eaa1205b6d6b231d` | 本地 `0.1.12-alpha.4` | 同上 |

下载 npm tarball 后执行真实发布入口，复用本地 browser/web-search-pro 的第三方依赖；不是严格冻结全部传递依赖的安装复现。DSH 依赖由对应 checkout 的 tsx 路径映射提供。没有改动这三个插件的源码。

配置来自各包真实 `cordis.patch.yml`（包括 builtin 的三个条目），用上游 `entryListSchema` 读取。测试通过真实 `boot()` 启动最小 SystemPrompt + ToolRuntime Host，不启动完整 web UI，也不发模型请求、搜索请求或打开浏览器页面。数据落在独立目录。

## 实测结果

两组均得到以下结果：

| 场景 | 结果 |
|---|---|
| 原始配置同时安装 | 失败：`duplicate loader entry id: browser` |
| 后续 patch 设置 `browser.disabled: true` | 同样失败，无法释放 ID |
| 在 Include 预补丁钩子执行 substrate 随包 resolver | ID 改为 `anweat-dsh-browser`；随后失败：`service "browser" has been registered at <BrowserRuntime>` |
| builtin 单独启动 | 成功，注册 33 个工具 |
| browser + web-search-pro 单独启动 | 成功，共注册 32 个工具 |
| 递归修复组内 ID，再给两套 browser 服务配置不同 realm | 越过服务冲突，随后真实触发 `tool "browser_open" is already registered` |
| 上述隔离再加 substrate tools scope shim | 成功：全局保留 builtin 的 33 个工具，第三方 scope 可见 60 个工具，两方合计 65 笔注册均验证归属 |

真实独立启动注册表的交集恰好是 issue 列出的五个工具：`browser_open`、`browser_click`、`browser_type`、`browser_scroll`、`browser_screenshot`。`web_*` 已存在于第三方栈注册表且不与内置工具重名。全局仍是内置版本，第三方 scope 中同名工具覆盖为第三方版本；两个视图逐项对照独立启动的完整名称/描述，而非只检查数量。

这说明有三个需要分别验收的边界：entry ID、`browser` 服务接口/隔离、工具命名空间。内置 BrowserRuntime 的 provider/session 接口与第三方 BrowserService 不能直接互换。成功启动确认内置条目得到 BrowserRuntime，第三方 browser 和 web-search-pro 均得到 BrowserService。

### 上次 pending 的根因及修复

`cordis:group` 与父组共用 EntryTree.store；组内 ID 并不自动产生新命名空间。原 resolver 只扫描顶层，把第三方 browser 移进 group 后遗漏了其 `id: browser`。诊断捕获到同一个 `include:browser` 的 options 已变成第三方模块，但 fiber 仍是 BrowserRuntime，其服务被移进第三方 realm，内置消费者因而 pending。这是未完成 ID 去重造成的 entry 复用，不能归咎于工具 scope 机制。

现在 1.0.6/1.0.7 两份随包补丁都递归扫描 `group: true` 的 config，并预留全树已显式指定的 ID，避免派生名抢占后面已有的条目。普通插件的 config 数据不会被递归改写。上次报告的“隔离失败、原因未明”被这次定位和成功复跑取代。

工具处理本来位于 `substrate/src/tools-shim.mjs` 和组合器中，本次未修改 shim：已有机制确实能处理五个真实重名。但可安装 `plugin/src/index.mjs` 当前仅报告与提供只读修复状态，没有自动调用组合器或注入 realm/scope。**实验配置成功不等于仅安装 npm 插件就自动完成全部适配。** Agent 需要绑定对应 scope 才能选择第三方工具视图；本次没有运行 Agent 或浏览器业务动作。

ID resolver 从随包 patch 的新增函数原文提取，在独立测试进程中替换对应源码 Include 钩子，**没有向源码 checkout 执行安装级 repair**。新版补丁另在两套 npm fixture 中完成 pnpm apply/revert 和新进程验证，证据在 `published-nested-loader/results.json`，覆盖嵌套 group、显式 ID 预留、普通 config 不改写及幂等性。

## 复跑与证据

保留目录：`D:\codeproject\dsh-browser-issue11-20260907`。

```powershell
pwsh -NoProfile -File D:\codeproject\dsh-browser-issue11-20260907\run.ps1
```

- `probe.mjs`：真实 Host、包入口和逐场景配置。
- `verify.mjs`：24 条回归断言，校验预期失败、独立成功、五个重名、组合启动、工具归属和服务身份。
- `summary.json`：汇总，`coexistenceVerified: true`、`browserActionsTested: false`。
- `published-*/result.json`、`local-*/result.json`：每次启动的错误或完整工具 schema 名称/描述。
- 同名目录的 `cordis.yml` 与根目录日志：可审查配置和原始输出。

该 runner 使用现有临时 checkout 和已准备好的依赖，不能脱离这些目录直接运行。browser/web-search-pro 源码、用户日常 DSH 安装和 GitHub issue 均未修改；substrate 补丁和回归测试已修正，没有发布或回复 issue。

本记录补充并限制历史 TESTED.md 中“ID 唯一后可以同装”的描述：ID 列表通过只能证明第一关，不能证明真实插件服务、工具或浏览器业务同时可用。
