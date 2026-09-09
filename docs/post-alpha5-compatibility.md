# alpha.5 之后的兼容性验收

验收日期：2026-09-09。范围从 `@deepseek-ai/dsh-app-boot@0.1.2-alpha.5` 之后开始，只把 npm 实际发布、可以安装的精确版本列入支持矩阵。

| DSH app-boot | npm 状态 | 安装修复 | 真实启动与修复闭环 |
|---|---|---|---|
| `0.1.2-rc.1` | 已发布 | 支持 | 通过 |
| `0.1.3-alpha.1` | 未发布；只有 Git tag | 不可安装 | 仅源码对照，不列入支持 |
| `0.1.3-alpha.2` | 已发布 | 支持 | 通过 |
| `0.1.5-alpha.1` | 已发布 | 支持 | 通过 |

每个可安装版本都使用精确 pin 的隔离 profile 和本次打包出的 `@anweat/dsh-substrate@0.1.2` 验证，覆盖：真实 app boot、Host 报告器、设置卡注册、CLI apply、平铺/嵌套/disabled entry-id、15 组重复 ID、5 组修复前后启动计时、`verified` 状态、幂等重跑、CLI revert。三个版本全部通过。

## 0.1.5 的 Connection 变化

DSH 0.1.5 不再让 Connection 强依赖 WebServer。插件在 WebServer 出现前调用专用 `connection.rpc.handle` 时，注册对象可以存在，但物理 HTTP 路由不会出现。

`0.1.2` 将状态接口和 panel scaffold 迁到 Connection 的精确 Fetch 注册表：

- 状态接口固定为 `POST /api/dsh-substrate/status`；
- panel 的每个 endpoint 使用 `/api/<package>.<panel>.<endpoint>` 精确路径；
- 路由归属仍取自调用插件的 Context，插件卸载会撤销路径；
- 所有请求继续经过 Connection 的 Host/Origin 检查和浏览器会话认证；
- 插件不注册 apply/revert 写接口，安装变更仍只能由外部 CLI 完成。

真实 `dsh-v0.1.5-alpha.1` 源码实验通过 207 条断言，包含面板 HTTP、未认证拒绝、路由冲突、卸载清理和 entry-id 修复。

## 工具冲突边界

0.1.5 的源码仍会拒绝同一全局 ToolRuntime 中的重复工具名；上游没有自动替插件选择 scope。以下机制继续有效：

- 显式 scope 链按配置顺序解析同名工具；
- tools shim 可在注册时把插件映射到 scope；
- ToolRuntime 自适应补丁可让未改造插件进入各自 scope，并在 fiber 卸载时清理其工具；
- entry-id 修复只解决 loader 地址冲突，不等于自动解决 service/tool 冲突。

对应的官方 0.1.5 源码实验中，真实 registry、完整 substrate 链、自适应 shim、ToolRuntime 补丁和卸载更新全部通过。安装补丁继续只负责 entry-id；service realm 与 tool scope 仍由宿主组合层显式启用。

## 安装

```powershell
dsh plugin --profile web add @anweat/dsh-substrate@^0.1.2
npx --yes @anweat/dsh-substrate@0.1.2 repair --home "<DSH_HOME>"
npx --yes @anweat/dsh-substrate@0.1.2 repair --home "<DSH_HOME>" --apply --yes
```

应用后重启 DSH，由新 Host 报告 `verified`。撤销时执行：

```powershell
npx --yes @anweat/dsh-substrate@0.1.2 repair --home "<DSH_HOME>" --revert --yes
```

未知 app-boot 版本会在写文件前被拒绝。每次 DSH 发布新版本都需要生成精确补丁并重新跑完整矩阵，不能跨版本回退或套用相邻版本补丁。
