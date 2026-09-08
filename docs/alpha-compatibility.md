# DSH alpha 适配记录（2026-09-07）

后续的 [pnpm 全插件验收](pnpm-plugin-compatibility.md) 发现 alpha 发布产物内嵌 Include，并完成实际 app-boot 补丁适配。以下六版本数据为 Git 源码矩阵，不能替代 npm 安装结论；其中两个标签在查询时没有对应 npm 发布。

范围为本次 `git ls-remote --tags` 核对到的全部 6 个 alpha 标签。适配按精确 commit 与 loader 包版本记录,不推断未来 alpha 兼容。机器可读结果见 [alpha-compatibility.json](alpha-compatibility.json)。

## 版本与覆盖

| DSH 标签 | commit 前缀 | loader | 机制与 Host 入口 | 400 包内核组合 | 完整 profile |
|---|---|---|---|---|---|
| 0.1.2-alpha.1 | cd5ef8148158 | 1.0.6 | 202/202;跳过 2 | 7/7;5,298 次归属全部正确 | 7/7 通过 |
| 0.1.2-alpha.2 | 0a53fb55bea1 | 1.0.7 | 202/202;跳过 2 | 7/7;5,298 次归属全部正确 | 7/7 通过 |
| 0.1.2-alpha.3 | dd6322d604e0 | 1.0.7 | 202/202;跳过 2 | 7/7;5,298 次归属全部正确 | 7/7 通过 |
| 0.1.2-alpha.4 | 4e84901e6471 | 1.0.7 | 202/202;跳过 2 | 7/7;5,298 次归属全部正确 | 7/7 通过 |
| 0.1.2-alpha.5 | db6bdc3576c2 | 1.0.7 | 202/202;跳过 2 | 7/7;5,298 次归属全部正确 | 7/7 通过 |
| 0.1.3-alpha.1 | d347e703908d | 1.0.7 | 202/202;跳过 2 | 7/7;5,298 次归属全部正确 | 7/7 通过 |

验证环境为 Windows x64、Node 24.14.0、pnpm 11.7.0。每次切换前检查临时 checkout 干净,按对应标签的锁文件重新安装依赖。为避免无关 CLI 二进制下载阻塞,安装使用 `--ignore-scripts --no-optional`,另行提供 esbuild 0.28.1、Koffi 3.1.1、sharp 0.35.3 的 Windows 二进制,并在独立安装目录编译 fs-ext 2.1.1 后供测试 checkout 加载。

首轮完整 bundle 启动因缺少 sharp/fs-ext 原生依赖失败;补齐真实二进制后重新验证,原始失败日志保留为 `*-before-native-e2e.log`。没有修改上游源码或用假实现绕过失败。这也说明安装使用 `--ignore-scripts --no-optional` 时,不能把漏装依赖直接归类为插件不兼容。

“400 包内核组合”使用真实 Cordis、SystemPrompt、ToolRuntime、Scope 和 400 个语料包的 5,298 次注册。先验证无底座确实因工具重名失败,再验证裁决后启动成功,并逐包逐名称核对注册的归属,不再用“保留了约一半工具”作为未丢失的证据。它不覆盖这些第三方插件的业务逻辑。

每版明确跳过两项:需要未公开 `out/records.jsonl` 的全语料实验,以及需要上游提案补丁的 `lab-client-priority`。这些跳过不计入通过。

本地测试 **389/389 通过**,插件构建通过。六版本共完成 **1,212 条机制断言**、**42 条内核组合断言**与 **42 条完整 profile 组合断言**。两个发布 loader 的真实安装修复/撤销检查均通过。

## 已实施适配

1. **安装修复按 loader 精确选择。** alpha.1 使用 `1.0.6`,其余使用 `1.0.7`。两个 npm 发布包的 `lib/index.js` 相同,六个标签的 include 源码 Git blob 也相同。增加独立版本描述与补丁文件,未知版本仍在写入前拒绝。
2. **修复 pnpm 真安装失败。** 原裸 unified diff 带时间戳,可通过 `git apply --check`,但 pnpm 11.7.0 实际应用失败。改用 `pnpm patch-commit` 生成的 Git diff,并固定补丁 LF 换行。两版本均用真实 pnpm 应用/重链、新 Node 进程验证重复 id 已分离、撤销后验证原行为恢复。此处验证的是发布 loader,不是完整安装版 DSH 的浏览器/重启闭环。
3. **跟随 client-runtime 拆分。** 移除插件已不再使用的旧 client-runtime peer;浏览器 externals 改为当前平台的 `dsh-client-store`/ui-slots/ui-primitives。面板实验按源码能力选择旧 slots 或新的 ui-renderer registry。
4. **修正面板 RPC 协议与测试。** `panelClient` 原来直接发业务 JSON,现在发送包含 `type/rpcId/method/payload` 的信封,校验响应标识并返回业务值。真实通道实验同时检查 `result.ok`、回传值与未认证请求的 401;HTTP 200 不再足以判定成功。此问题也影响旧协议,不是为了 alpha 人为放宽断言。
5. **沿用 alpha 的认证边界。** Connection 新增 credentials 与浏览器认证。实验使用上游测试用 credential provider,其余认证与 HTTP 通道为真实实现。alpha 不再使用旧的通道 `authority` 参数,状态卡片继承 DSH 的已认证访问范围,仍没有安装写入 RPC。
6. **适配验证入口与 profile。** HMR 实验启用 `--expose-internals`,补齐新 `artifactBaseline` 测试依赖。alpha.1/.2 的旧 headless 配置已移动;alpha.3 起删除独立配置,改用上游 include 的真实解析/组合逻辑装配 base + headless bundle,仅停用会发起模型任务的 startup/runner 两行。
7. **分版本保存目录。** `DSH_EXPERIMENT_STATUS` 与 `DSH_BASELINE_OUT` 指定版本专属输出。六版目录均重新生成;默认的历史 `pipeline/data/baseline.json` 不被末次 alpha 测试覆盖。

## 哪些兜底仍不能删除

按 ADAPTATION 的原则检查了上游吸收情况:BootPluginRow 仍无 priority、ui-theme 仍无独立令牌导出/平台 seed、运行时名册变更仍未发送对应 dev-channel 帧;自动把争用插件的启动注册放入独立 scope 也尚非上游默认行为。保留相关适配,没有把这些缺口的断言改成无条件通过。

本次插件 TypeScript/客户端打包通过。历史上 alpha.4 的实际浏览器卡片验证仍见 [TESTED.md](../plugin/TESTED.md);**本次没有对六版逐一进行浏览器视觉与交互验证**。

## 复跑

先使用独立克隆,检出精确标签并安装该版本依赖,再从 substrate 根目录运行:

```powershell
$env:DSH_ROOT = 'D:\scratch\deepseek-harness'
$env:DSH_HOME = 'D:\scratch\dsh-test-home'
$env:DSH_EXPERIMENT_STATUS = 'D:\scratch\alpha-experiments.json'
$env:DSH_BASELINE_OUT = 'D:\scratch\alpha-baseline.json'
node experiments/run-experiments.mjs
node pipeline/00-baseline.mjs
$env:DSH_E2E_PROFILE = 'core'
node e2e/run.mjs 400
$env:DSH_E2E_PROFILE = 'shipped'
node e2e/run.mjs 400
npm test
npm run build --prefix plugin
node experiments/verify-published-loaders.mjs
```

新进程 loader 验证器只在新建目录运行;不会修改用户已有的安装。原始逐版本日志、目录 JSON 和安装 fixture 保留在本机 `D:\codeproject\dsh-alpha-compat-20260907-artifacts`;可复查的摘要与 SHA-256 写入本目录的 JSON 证据。
