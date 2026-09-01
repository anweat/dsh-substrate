# 适配方针

## 宗旨:目标是变得不必要

这个底座不是一个要长期存在的产品。DSH 还没有正式版本,它今天缺的东西——客户端槽位的 rank、令牌的导出面、名册变更的转发——**都是官方迟早会自己补上的**。每补上一样,这里就该少一块。

所以衡量它的标准不是"功能多完整",而是**还剩多少没被上游吸收**。

| 上游请求 | 落地后本仓库删掉什么 |
|---|---|
| `BootPluginRow.priority` | 前端争用的全部处理;`whatif-client-priority` 变成历史记录 |
| 令牌导出面 | `substrate/src/tokens.mjs` 的解析与发射,只留 lint |
| `ui-theme` 升为种子词 | 令牌契约剩下的那半 |
| 名册变更转发到 dev channel | P3.6 里"前端需刷新"这条限制 |
| 工具名的 scope 分层成为一等能力 | `tools-shim.mjs` 与 `scope-chain.mjs` |

**全部落地时,这个仓库应该只剩测量管线。** 那是它成功的样子,不是失败。

## 跟随哪个版本

**跟正式版本,不跟 alpha。** 上游同时存在 rc 与 alpha 标签;alpha 里的机制随时会变,对着它验证等于给自己找活干。

当前基线:

```
dsh-v0.1.1-rc.2-5-g50854a854f      0.1.1-rc.2 之后 5 个提交
分支 codex/dsh-0.1.1-rc.2-adaptation(上游默认分支)
```

选择这个点而不是标签本身,是因为那 5 个提交都是 `fix(...)`,且**一处都没碰**本仓库验证依赖的机制:

```
client/runtime/src/client/slots     0 处改动
core/tools/src                      0
client/connection/src               0
core/scope/src                      0
client/modules/src                  0
vendor/include                      0
client/hmr                          0
```

(`packages/boot/app-boot/src/index.ts` 有 +2 行,是两个 re-export,没碰 `boot()` 或 `watchUserPatches`。)

## 每次版本更新怎么做

不要凭感觉判断"应该还能用"。**这里的每条结论都是对一个特定 commit 的断言**,换 commit 就要重跑。

```bash
export DSH_ROOT=/path/to/a/dsh/checkout      # 独立克隆,不要用你的工作仓库
git -C "$DSH_ROOT" checkout <最新的非 alpha 标签>
node experiments/run-experiments.mjs          # 160 断言,对着真 harness
node e2e/run.mjs 400                          # 7 断言,真启动
npm run baseline -- "$DSH_ROOT"               # 重新生成已知组件目录
npm test                                      # 251 断言,不依赖 checkout
```

runner 会在开头打印它究竟对着哪个 checkout 跑,并写进 `STATUS.json`。**一次绿灯如果不知道对的是哪个 commit,就等于没跑。** 它也会提示 checkout 有未提交改动——那意味着结果不可复现。

两个细节值得知道:

- **实验是被暂存进 checkout 里跑的。** 它们按相对路径 import 产品(`./vendor/cordis/src/index.ts`),这正是它们碰的是真东西而不是构建产物的原因;而那只在 checkout 根解析得了。runner 拷进去、跑完删掉,并且拒绝覆盖同名文件。
- **`lab-client-priority` 测的是一个上游提案**,只在应用了 `experiments/bootpluginrow-priority.patch` 的 checkout 上有意义。runner 会检测补丁在不在:不在就跳过并说明原因,而不是报一条红线——红线会被读成"机制坏了",而真相是"这个 checkout 没打那个原型"。

当前基线上的结果:**148 通过、0 失败、跳过 1**(打上补丁后 12/12)。

### 用独立克隆

不要拿你日常工作的 harness 仓库当 `DSH_ROOT`。这些实验会写临时 profile、启监听端口、按 commit 判定结论;一个会被随手 `git pull` 的仓库会让"上次跑过了"这句话失去意义。

### 目录必须跟着重生成

`pipeline/data/baseline.json` 是从 checkout 生成的,DSH 一升级就过期。**过期的目录比没有目录更危险**:它会把一个已经被占用的名字报成空着,而那个方向的错误代价是整个组合起不来(见[开发指南 §10](https://github.com/anweat/dsh-plugin-dev-guide/blob/master/docs/native-behaviour.md))。

## 断言失败时读作什么

一条实验失败**不代表底座坏了**,先分清是哪一类:

| 现象 | 含义 | 该做什么 |
|---|---|---|
| 机制变了(如某个服务换了归属推导方式) | 上游改了实现 | 改这里的适配,更新断言,记下变更 |
| 缺口没了(如 `BootPluginRow` 有了 priority) | **上游吸收了** | 删掉对应的那块,别去修它 |
| 断言本身写错了 | 我们的问题 | 改断言,并在提交信息里说明原来错在哪 |

第二类是我们想要的结果。遇到它时**不要把测试改绿**——要把代码删掉。
