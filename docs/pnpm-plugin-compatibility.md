# pnpm 安装插件的版本验收

发布验收补充：[最终 0.1.0 验收与耗时差分矩阵](release-0.1.0-verification.md)。最终包覆盖 60 个重复 ID 场景、415 条断言、四版真实 Chrome 操作；以下保留前序定位过程。

2026-09-07。对象是打包后的 `@anweat/dsh-substrate`：启动前诊断、随包 pnpm 补丁、外部修复 CLI、Host 报告、设置命名空间、只读 RPC、客户端状态控制器与卸载。遵循现有“裁决 → 适配 → 契约”设计；未把服务/工具仲裁擅自加入 npm 插件的自动启动路径。

## 版本结论

| DSH 版本 | npm 发布 | 安装后真实 boot / 修复与撤销 | Host、设置、认证 RPC、客户端状态 |
|---|---|---|---|
| 0.1.2-alpha.1 | registry 查询 404 | 未声称通过 npm 验收 | 保留此前 Git 源码测试证据 |
| 0.1.2-alpha.2 | 有 | 通过 | 通过 |
| 0.1.2-alpha.3 | 有 | 通过 | 通过 |
| 0.1.2-alpha.4 | 有 | 通过 | 通过 |
| 0.1.2-alpha.5 | 有 | 通过 | 通过 |
| 0.1.3-alpha.1 | registry 查询 404 | 未声称通过 npm 验收 | 保留此前 Git 源码测试证据 |

npm registry 为 `https://registry.npmjs.org/`。Git 标签存在不代表同版本已发布到 npm；未发布、自行打包或未知 app-boot 版本不会退回到独立 include 补丁冒充支持。此矩阵不扩大到未测 RC/未来版本。

## 本轮发现并修复

1. **修复目标不等于源码 import 的包。** npm alpha 的 app-boot/lib/index.js 内嵌 Include，原先只改 cordis-plugin-include 会漏掉实际 boot 路径。新增四个 app-boot 精确版本补丁，并优先通过 home/profiles/node_modules/dsh-app-boot 的真实链接选目标；源码环境仍拒绝写入。
2. **group 内 ID 与父树共享命名空间。** 保留递归去重修复；第一认领者保持原 ID，后来者采用模块名派生 ID，预留所有显式 ID，普通插件配置数据不改写。
3. **已声明补丁也可能需要更新。** stage 对比随包与目标补丁内容，不再仅因已有声明就跳过新版补丁。
4. **CI 下不能冻结修复事务的 lockfile。** 外部执行器使用 pnpm install --no-frozen-lockfile，应用和撤销才能更新 patchedDependencies 对应锁定信息。
5. **状态、界面与真实目标一致。** Host/CLI/RPC 返回实际 app-boot 版本和补丁文件；客户端已有 target 字段展示它。声明、磁盘安装、进程重启仍分态，没有添加网页写入端点。

## 真实安装测试做了什么

四个隔离目录分别安装官方 `@deepseek-ai/dsh`、对应 app-boot，以及同一份插件 tgz。使用 pnpm 11.7.0、Node 24.14.0、Windows x64。官方 DSH 依赖使用 caret 预发布范围，为防止旧 alpha 偷偷解析到新 RC，测试 hook 将 DSH 的 0.1.x 依赖/peer 固定在被测 alpha；安装的 lockfile 与日志保留。未使用 tsx、源码路径映射或运行时猴子补丁来验证 entry ID。

每版实际执行：

- 原始双 browser ID 启动失败；无冲突控制组成功，并挂载真正的 substrate Host 和 settings-file。
- 运行安装后的 `pnpm exec dsh-substrate repair --apply --yes --home ...`，实际 pnpm 重链。
- 新 Node 进程调用发布包真实 boot：顶层、嵌套 group 均成功，两笔 recorder 注册都保留；按原 ID 禁用只影响第一认领者。
- 状态为 verified；再次 apply 保持幂等；真实 CLI revert 后新进程重新触发原始 duplicate ID 异常。
- 安装后的 check CLI 返回一个重复 ID 诊断和退出码 1。
- 发布包真实 WebServer/Connection 上完成 HTTP RPC：认证状态查询、401 拒绝未认证、无 apply 写端点；Host 设置保存与恢复默认；卸载清理命名空间和路由。
- 随包客户端 PatchController 接入真实 HTTP 返回的 Connection result，核对实际目标与加载状态。Node 不在 node_modules 内剥离 TS，因此仅将随包 controller 原文复制到 fixture 后执行；没有改其逻辑。

独立 include 1.0.6/1.0.7 的 pnpm apply/revert 也重跑通过，覆盖嵌套、ID 预留与幂等。现有测试 411 条通过，客户端 tsc/tsdown 构建通过。四版各 11 条 RPC/设置/控制器断言通过。

## 可复跑证据与限制

目录：`D:\codeproject\dsh-pnpm-matrix-20260907`。最终交付 tgz 又在 `delivery-verified/results.json` 完整复跑通过；每版 before/after/nested/disabled/reverted.json、安装与修复日志、rpc-result.json 均保留，check CLI 记录在前一轮 `verified/*/check.log`。汇总与 tgz/lockfile 哈希见 [机器可读收据](pnpm-plugin-compatibility.json)。先前安装 fixture 中的失败也保留，不作为最终通过证据。

```powershell
node experiments/verify-pnpm-plugin.mjs <新的输出目录> <插件tgz绝对路径>
node experiments/verify-published-loaders.mjs <新的输出目录>
node substrate/run-tests.mjs
```

安装测试跳过第三方依赖构建脚本，但未跳过 patchedDependencies 的应用；Host、设置和 HTTP 验证均实际执行。使用最小配置定位 ID 问题，不把 recorder 说成完整 browser 插件业务。发布验收已补齐四版 Chrome 设置卡片与操作；真实第三方浏览器工具动作另在 alpha.5 源码 Host 验证，完整边界见发布验收记录。

没有改动日常 DSH 安装或 GitHub issue。npm 发布状态见机器可读收据。未知版本继续明确拒绝写入；上游消除对应缺口后应撤掉该版本补丁，符合底座逐步退出的宗旨。
