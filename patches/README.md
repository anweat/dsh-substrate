# 补丁

当前精确支持 npm 发布的 `@deepseek-ai/dsh-app-boot@0.1.2-alpha.2`、`.3`、`.4`、`.5`，另保留独立 include `1.0.6` 和 `1.0.7` 的补丁。**alpha 发布包内嵌 Include，真实启动优先修复 app-boot；只修独立 include 不能证明启动已修好。** 修复器根据 DSH home 的实际依赖回退链接识别目标，不用源码版本代替安装版本。详见 [pnpm 插件验收矩阵](../docs/pnpm-plugin-compatibility.md)。下面 `1.0.7` 的清单仅是独立 include 示例，不用于替代 alpha 的 app-boot 补丁。

## 为什么是 `pnpm patch` 而不是别的形态

自动去掉重复 entry id 这件事,必须发生在 `mountRootInclude` 之前——插件是被那一步挂载的,所以插件不可能是做这件事的人。剩下几种形态里,只有一种既能做到、又不会让人怀疑:

| 形态 | 能做到 | 问题 |
|---|---|---|
| **`pnpm patch`** | ✅ | 无。这是 pnpm 的一等功能,产物是一份纯文本 diff |
| Node `--import` 预加载 | ✅ | 运行时猴子补丁。不透明,`NODE_OPTIONS` 在一些安全工具的观察名单上,而且**上游一升级就静默失效** |
| 自己分发一版改过的 DSH | ✅ | 信任负担最大。让人装你的构建而不是官方的,**这正是供应链攻击的形状**,所以也是最像的形状 |
| postinstall 脚本改文件 | ✅ | 扫描器直接盯这个模式 |

`pnpm patch` 之所以干净,是因为它把改动摊开:

- 产物是**一份 unified diff**,能在 PR 里逐行审、能 grep、没有任何动态代码
- **声明写在工作区清单里**(`pnpm-workspace.yaml`),装了什么补丁一目了然,而且是根工作区的一次明确选择
- **锁版本**。目标包版本一变,pnpm 会**报错拒绝**,而不是像猴子补丁那样悄悄不生效
- **没有 postinstall,没有运行时注入** —— 扫描器真正会标记的那两样,一样都没有

## 投放点:必须是安装 DSH 的工作区

本目录的补丁能干净应用、能让四个真包共存;真正困难的是把它交给**实际安装 loader 的 pnpm 工作区**,而不是看起来最像的 profile。

`patchedDependencies` 只对声明它的那个工作区自己的依赖生效,而 loader 不是任何 profile 的依赖:

```
<home>/profiles/node_modules/@deepseek-ai/cordis-plugin-include
  → 符号链接 → dsh 自身安装目录下的那一份
```

`healProfilesModuleFallback` 把 DSH 自己的依赖软链进 profiles 目录。`@deepseek-ai/cordis-plugin-include` 是 `@deepseek-ai/dsh` 的直接依赖,所以声明必须在**装 DSH 的那个工作区**里。

实测:把声明写进 `<profile>/pnpm-workspace.yaml`,`pnpm install` **照常成功、零警告**,而补丁一行都没生效。这是最坏的一种失败——看起来完全正常。

插件里的“启用补丁”开关已经被安装级修复事务取代。浏览器只读出真实路径和状态;外部 CLI 沿 fallback 链接定位工作区,无法证明目标时拒绝写入。

## 推荐用法

```bash
dsh-substrate repair --apply
```

它依次完成目标定位、精确版本校验、确认、写入、`pnpm install` 和磁盘验证。结束后仍需重启 DSH,因为磁盘上的新 loader 不会替换当前进程已经加载的模块。撤销使用:

```bash
dsh-substrate repair --revert
```

## 手工等价步骤

补丁写在**安装 DSH 的工作区**的 `pnpm-workspace.yaml` 里——不是 profile,也不是 `package.json`。pnpm 11 起,`package.json` 里的 `pnpm` 字段不再被读取,它会打印一条 WARN 然后忽略设置:

```
[WARN] The "pnpm" field in package.json is no longer read by pnpm.
```

正确的写法(实测于 pnpm 11.7.0,即 DSH 锁定的版本):

```yaml
# <dsh-install-workspace>/pnpm-workspace.yaml —— 追加,不要覆盖已有内容
patchedDependencies:
  '@deepseek-ai/cordis-plugin-include@1.0.7': patches/@deepseek-ai__cordis-plugin-include@1.0.7.patch
```

把 `.patch` 放到 `<dsh-install-workspace>/patches/` 下,在同一工作区运行 `pnpm install`,然后重启 DSH。

DSH 自己也管理这个文件(它会写 `nodeLinker`、`autoInstallPeers`、`strictDepBuilds`),但它只替换这三行、其余内容原样保留,所以你加的这一段会活下来。

## 为什么不能跟插件一起自动装上

**pnpm 不读依赖包里的 `patchedDependencies`。** 这是实测的,不是推测:

```
声明在依赖的 package.json      未应用
声明在根 package.json          未应用(pnpm 11 已废弃这个位置)
声明在 pnpm-workspace.yaml     已应用 ✓
```

对照组用的是同一份补丁文件,所以差别来自位置,不是补丁本身。

也就是说,**一个插件无法在安装时悄悄给宿主的依赖打补丁** —— 这是 pnpm 有意的设计,而且正是它让这件事可信的原因。一个装上就改别人依赖的插件,和一个被扫描器标记的插件,是同一个东西。

补丁的采用必须是安装工作区的一次明确选择。外部 CLI 可以把多步手工操作缩成一条命令,但仍会展示目标并要求确认;浏览器插件不会从宿主进程内部执行安装。

## 这份补丁做什么

在 `Include.prototype.applyPatches` 里,补丁读到行列表之前,把**后来认领同一个 id 的行**改成它的包名派生 id:

```
entry id "browser" already taken; @anweat/dsh-browser mounted as "anweat-dsh-browser"
```

第一个认领者保住原 id,所以既有的定位不受影响;后来者拿到确定的、可被补丁定位的新 id。

派生 id 本身被占时(**一个包合法地贡献多行**——出厂 browser bundle 就插三行)退回序号。

我最初的规则是"同一个 name 出现多次就不改写,让重复安装照常报错"。那条在真包上是错的:`dsh-builtin-browser` 一个包插 `browser`/`browser-electron`/`tool-browser` 三行,规则把它误判成重复安装、拒绝改写,**真启动里它就一直修不好**。是拿四个真包跑启动才发现的。

## 真启动验证

从 npm 装了四个真包(`@anweat/dsh-browser@0.1.10`、`dsh-builtin-browser@0.1.20`、`dsh-browser@0.1.0`、`dsh-plugin-browser@0.1.0`),用它们**各自真实的 `cordis.patch.yml`** 组合出 6 行,`browser` 被抢 4 次:

```
A. 无补丁   FAILED: duplicate loader entry id
B. 有补丁   [dedup] browser -> dsh-builtin-browser
            [dedup] browser -> dsh-browser
            [dedup] browser -> dsh-plugin-browser
            BOOTED — 挂载 6 行
```

插件本体用了替身(真本体要装浏览器),受测的是 loader 与注册表;**id 与包名都是它们自己的**。

## 它是临时的

`ADAPTATION.md` 的宗旨在这里同样适用:**这份补丁存在的目的是被上游取代。** 规则本身很小,收进 loader 后这个目录就该清空。

实测:[`experiments/lab-auto-dedup.ts`](../experiments/lab-auto-dedup.ts)(11 断言,对着源码)。本目录的 diff 是对**发布版 `lib/index.js`** 生成的,并单独验证过对报告场景的效果。
