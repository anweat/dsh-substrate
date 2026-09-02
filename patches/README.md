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
- **`pnpm.patchedDependencies` 写在 `package.json` 里**,装了什么补丁一目了然
- **锁版本**。目标包版本一变,pnpm 会**报错拒绝**,而不是像猴子补丁那样悄悄不生效
- **没有 postinstall,没有运行时注入** —— 扫描器真正会标记的那两样,一样都没有

## 用法

```bash
pnpm patch @deepseek-ai/cordis-plugin-include@1.0.7
# pnpm 打开一个临时目录;把本目录的 .patch 应用进去,或直接改 lib/index.js
pnpm patch-commit <pnpm 给出的临时目录>
```

或者手动在 `package.json` 里声明:

```json
{
  "pnpm": {
    "patchedDependencies": {
      "@deepseek-ai/cordis-plugin-include@1.0.7": "patches/@deepseek-ai__cordis-plugin-include@1.0.7.patch"
    }
  }
}
```

## 这份补丁做什么

在 `Include.prototype.applyPatches` 里,补丁读到行列表之前,把**后来认领同一个 id 的行**改成它的包名派生 id:

```
entry id "browser" already taken; @anweat/dsh-browser mounted as "anweat-dsh-browser"
```

第一个认领者保住原 id,所以既有的定位不受影响;后来者拿到确定的、可被补丁定位的新 id。

**同一个包被列两次时不改写**,让 loader 照常报错——那是配置错误,不是共存问题。派生是包名的函数,所以这一点是自然落下的,不需要额外判断。用序号后缀就会把这类真错误一起静音。

## 它是临时的

`ADAPTATION.md` 的宗旨在这里同样适用:**这份补丁存在的目的是被上游取代。** 规则本身很小,收进 loader 后这个目录就该清空。

实测:[`experiments/lab-auto-dedup.ts`](../experiments/lab-auto-dedup.ts)(11 断言,对着源码)。本目录的 diff 是对**发布版 `lib/index.js`** 生成的,并单独验证过对报告场景的效果。
