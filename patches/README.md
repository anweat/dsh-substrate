# 补丁

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

## 用法

补丁写在 **profile 目录的 `pnpm-workspace.yaml`** 里 —— 不是 `package.json`。pnpm 11 起,`package.json` 里的 `pnpm` 字段**不再被读取**,它会打印一条 WARN 然后忽略你的设置:

```
[WARN] The "pnpm" field in package.json is no longer read by pnpm.
```

正确的写法(实测于 pnpm 11.7.0,即 DSH 锁定的版本):

```yaml
# <profile>/pnpm-workspace.yaml —— 追加,不要覆盖已有内容
patchedDependencies:
  '@deepseek-ai/cordis-plugin-include@1.0.7': patches/@deepseek-ai__cordis-plugin-include@1.0.7.patch
```

把 `.patch` 放到 `<profile>/patches/` 下,然后 `pnpm install`。

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

补丁的采用必须是**根工作区的一次明确选择**。`dsh-substrate-check` 检测到冲突时会把这段 YAML 直接打出来,让它离你只有一次复制粘贴——但按下去的那一下,是你按的。

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
