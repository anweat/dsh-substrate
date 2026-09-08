import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join,resolve} from 'node:path'
import assert from 'node:assert/strict'
const out=resolve(process.argv[2]),repo=resolve(import.meta.dirname,'..'),matrix=join(out,'final-matrix')
const json=p=>JSON.parse(readFileSync(p,'utf8')),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex')
const median=xs=>xs.slice().sort((a,b)=>a-b)[Math.floor(xs.length/2)]
const browsers=json(join(matrix,'browser-results.json')),results=json(join(matrix,'results.json'))
assert.equal(results.length,4);assert.equal(browsers.length,4)
const versions=results.map(r=>{
 const dir=join(matrix,r.version),edges=json(join(dir,'entry-id-stress.json')),boots=json(join(dir,'boot-timings.json')),browser=browsers.find(b=>b.version===r.version),rpc=json(join(dir,'rpc-result.json'))
 assert.ok(r.ok&&browser.ok&&rpc.ok&&edges.length===15&&edges.every(e=>e.ok)&&boots.every(b=>b.ok))
 const off=median(boots.filter(b=>b.mode==='bare').map(b=>b.bootMs)),on=median(boots.filter(b=>b.mode==='clean').map(b=>b.bootMs))
 return {version:r.version,passed:true,installedCliVersion:json(join(dir,'node_modules/@deepseek-ai/dsh/package.json')).version,target:r.target,edgeScenarios:edges.map(e=>e.name),rpc,browser,lockfileSha256:hash(join(dir,'pnpm-lock.yaml')),timingMs:{install:r.timings['install.log'],repair:r.timings['apply.log'],reapply:r.timings['reapply.log'],revert:r.timings['revert.log'],bootDisabledMedian:off,bootEnabledMedian:on,bootDeltaMedian:on-off},evidence:dir}
})
const artifact=join(out,'final/anweat-dsh-substrate-0.1.0.tgz')
const receipt={checkedAt:new Date().toISOString(),artifact,sha256:hash(artifact),versions,unitAssertions:415,published:false,method:'Windows x64, Node 24.14.0, pnpm 11.7.0; cached dependencies; five fresh-process paired boot samples per version; quiet-window wait excluded; no LLM requests'}
writeFileSync(join(repo,'docs/pnpm-plugin-compatibility.json'),JSON.stringify(receipt,null,2))
const row=v=>{const t=v.timingMs;return `| ${v.version} | ${(t.install/1000).toFixed(2)} | ${(t.repair/1000).toFixed(2)} | ${(t.reapply/1000).toFixed(2)} | ${(t.revert/1000).toFixed(2)} | ${t.bootDisabledMedian.toFixed(1)} | ${t.bootEnabledMedian.toFixed(1)} | ${t.bootDeltaMedian.toFixed(1)} |`}
writeFileSync(join(repo,'docs/release-0.1.0-verification.md'),`# 0.1.0 发布验收与耗时矩阵\n\n2026-09-07。最终 tgz SHA256：\`${receipt.sha256}\`。发布状态见机器可读收据。\n\n415 条本地断言、4 × 15 个真实 boot 重复 ID 场景、4 × 11 条认证 RPC/设置断言均通过。4 个 npm alpha 均通过真实 Google Chrome 设置卡片、非法值拦截、放弃、保存后刷新、重置后刷新、目标版本和剪贴板检查，无 pageerror。Include 1.0.6/1.0.7 的真实 pnpm 应用/撤销通过。\n\n## 差分时间矩阵\n\n| 版本 | 安装 s | 修复 s | 再次修复 s | 撤销 s | 未启用 boot ms | 启用 boot ms | 差值 ms |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${versions.map(row).join('\n')}\n\n环境：Windows x64 / Node 24.14.0 / pnpm 11.7.0。依赖使用已有缓存，安装包含整套 DSH 与插件，修复含 pnpm 重链；不是单个插件冷下载耗时。boot 为最小真实 Host，每版启用/未启用各五次新进程，中位数之差；双方均已打 ID 补丁。仅计 boot()，不含进程/模块前置加载和人为等待的 60 ms。并发测试与机器负载会影响数值，负差值也不能解释为提速。静默窗口是启发式，不能宣称“所有组件就绪”。原始五组记录为各目录 boot-timings.json。\n\n## 新增回归与边界\n\n除了平铺、深层和兄弟组、组本身重名、显式派生名预留、同模块、disabled 和缺省 ID，覆盖 insert、连续 insert 后寻址、组内 insert、整组替换，以及前置组插入/替换后按既有 ID 禁用。每层覆盖前保留既有认领者，覆盖后重新去重，输入 patches 不被改写。修复标记 v4 与旧实现区分，已有声明也会刷新补丁内容。\n\nChrome 的安装状态链另在 alpha.4 验证 available → restart-required → verified。dsh-browser 当前本地包与 builtin 同装的显式 realm + tools scope 组合，在 alpha.5 源码 Host 通过真实 ToolRuntime.execute 调用了五个重名工具：打开本地 HTTP 页面、输入、点击并验证页面回显、滚动、截图；全局 builtin schema 未变。该业务用例没有模型请求，也没有启动 builtin Electron 窗口。它证明既有组合方案能调用第三方工具，不声称 npm 插件会自动做服务 realm 或 Agent scope 绑定。\n\n完整 npm 安装支持 alpha.2–alpha.5；alpha.1 与 0.1.3-alpha.1 的 npm 404 边界保持不变，源码矩阵单独保留。未知 app-boot 版本拒绝写入。\n\n## 证据\n\n- \`${matrix}\`：最终包安装、15 场景、RPC、每次 boot 与 Chrome 截图。\n- \`${join(out,'final-loaders')}\`：两版独立 loader。\n- \`D:/codeproject/dsh-browser-issue11-20260907/local-scoped-release-actions/result.json\`：五个工具的真实返回与截图路径。\n- [机器可读收据](pnpm-plugin-compatibility.json)。\n\n复跑：\n\n\`node experiments/verify-pnpm-plugin.mjs <新目录> <最终tgz>\`\n\n\`node experiments/browser-release-matrix.mjs <上述目录> D:/codeproject/dsh-browser\`\n`)
console.log(versions.map(row).join('\n'))
