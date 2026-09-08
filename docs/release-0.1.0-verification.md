# 0.1.0 发布验收与耗时矩阵

已发布 [@anweat/dsh-substrate@0.1.0](https://www.npmjs.com/package/@anweat/dsh-substrate/v/0.1.0)。registry 重新下载的 tarball 与下述验收包 SHA256 完全一致。npm 二次身份验证由用户完成后，交互发布成功；首次非交互 EOTP 记录保留，不作为发布成功收据。

2026-09-07。最终 tgz SHA256：`73ca3434a7e860babdfbdf74b9e6e76ed621d6951912eb63f90c458d4b593d1f`。发布状态见机器可读收据。

415 条本地断言、4 × 15 个真实 boot 重复 ID 场景、4 × 11 条认证 RPC/设置断言均通过。4 个 npm alpha 均通过真实 Google Chrome 设置卡片、非法值拦截、放弃、保存后刷新、重置后刷新、目标版本和剪贴板检查，无 pageerror。Include 1.0.6/1.0.7 的真实 pnpm 应用/撤销通过。

## 差分时间矩阵

| 版本 | 安装 s | 修复 s | 再次修复 s | 撤销 s | 未启用 boot ms | 启用 boot ms | 差值 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| 0.1.2-alpha.2 | 14.28 | 7.03 | 1.74 | 6.83 | 183.5 | 192.6 | 9.0 |
| 0.1.2-alpha.3 | 13.92 | 6.87 | 1.84 | 6.75 | 187.2 | 199.0 | 11.8 |
| 0.1.2-alpha.4 | 13.56 | 7.62 | 1.76 | 6.72 | 185.5 | 200.1 | 14.6 |
| 0.1.2-alpha.5 | 21.60 | 7.40 | 1.87 | 6.86 | 197.8 | 208.7 | 10.8 |

环境：Windows x64 / Node 24.14.0 / pnpm 11.7.0。依赖使用已有缓存，安装包含整套 DSH 与插件，修复含 pnpm 重链；不是单个插件冷下载耗时。boot 为最小真实 Host，每版启用/未启用各五次新进程，中位数之差；双方均已打 ID 补丁。仅计 boot()，不含进程/模块前置加载和人为等待的 60 ms。并发测试与机器负载会影响数值，负差值也不能解释为提速。静默窗口是启发式，不能宣称“所有组件就绪”。原始五组记录为各目录 boot-timings.json。

## 新增回归与边界

除了平铺、深层和兄弟组、组本身重名、显式派生名预留、同模块、disabled 和缺省 ID，覆盖 insert、连续 insert 后寻址、组内 insert、整组替换，以及前置组插入/替换后按既有 ID 禁用。每层覆盖前保留既有认领者，覆盖后重新去重，输入 patches 不被改写。修复标记 v4 与旧实现区分，已有声明也会刷新补丁内容。

Chrome 的安装状态链另在 alpha.4 验证 available → restart-required → verified。dsh-browser 当前本地包与 builtin 同装的显式 realm + tools scope 组合，在 alpha.5 源码 Host 通过真实 ToolRuntime.execute 调用了五个重名工具：打开本地 HTTP 页面、输入、点击并验证页面回显、滚动、截图；全局 builtin schema 未变。该业务用例没有模型请求，也没有启动 builtin Electron 窗口。它证明既有组合方案能调用第三方工具，不声称 npm 插件会自动做服务 realm 或 Agent scope 绑定。

完整 npm 安装支持 alpha.2–alpha.5；alpha.1 与 0.1.3-alpha.1 的 npm 404 边界保持不变，源码矩阵单独保留。未知 app-boot 版本拒绝写入。

## 证据

- `D:\codeproject\dsh-release-20260907\final-matrix`：最终包安装、15 场景、RPC、每次 boot 与 Chrome 截图。
- `D:\codeproject\dsh-release-20260907\final-loaders`：两版独立 loader。
- `D:/codeproject/dsh-browser-issue11-20260907/local-scoped-release-actions/result.json`：五个工具的真实返回与截图路径。
- [机器可读收据](pnpm-plugin-compatibility.json)。

复跑：

`node experiments/verify-pnpm-plugin.mjs <新目录> <最终tgz>`

`node experiments/browser-release-matrix.mjs <上述目录> D:/codeproject/dsh-browser`
