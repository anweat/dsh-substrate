/**
 * Token-contract tests.
 *
 * The rules only earn their place if they stay quiet on correct code, so the
 * negative assertions carry the weight here: a reference with a fallback is not
 * dangling, a locally defined token is in scope, a `static` token on an
 * unthemed property is fine, and a low-alpha scrim is a deliberate choice
 * rather than a missing token. A lint that flags those would be discarded by
 * its first user.
 *
 * Run: node test/tokens.spec.mjs
 */
import { parseTokens, lintCss, summarize, renderDeclaration, tierOf, THEMED_PROPERTIES } from '../src/tokens.mjs'

let ok = 0, fail = 0
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/** A vocabulary shaped like the shell's: a fixed palette plus flipping roles. */
const SHELL = [{
  name: 'design-platform.css',
  css: `
    body {
      --dsw-static-blue-500: rgb(59, 130, 246);
      --dsw-static-white: rgb(255, 255, 255);
      --dsw-alias-bg-base: var(--dsw-static-white);
      --dsw-alias-label-primary: rgb(20, 20, 20);
      --dsw-alias-radius-card: 8px;
    }
    body[data-ds-dark-theme] {
      --dsw-static-blue-500: rgb(59, 130, 246);
      --dsw-static-white: rgb(255, 255, 255);
      --dsw-alias-bg-base: rgb(18, 18, 20);
      --dsw-alias-label-primary: rgb(240, 240, 240);
      --dsw-alias-radius-card: 8px;
    }
  `,
}]

const vocabulary = parseTokens(SHELL)
const lint = (css, file) => lintCss(css, { tokens: vocabulary.tokens, ...(file === undefined ? {} : { file }) })
const rules = findings => findings.map(f => f.rule)

console.log('\n=== 解析:层、明暗两值、是否翻转 ===')
{
  const { tokens, order } = vocabulary
  check('收齐 5 个令牌', tokens.size === 5, String(tokens.size))
  check('order 与定义顺序一致', order[0] === '--dsw-static-blue-500', order[0])
  check('层从名字第三段取', tierOf('--dsw-alias-bg-base') === 'alias', tierOf('--dsw-alias-bg-base'))
  check('前缀外的名字没有层', tierOf('--other-thing') === undefined)

  const bg = tokens.get('--dsw-alias-bg-base')
  check('alias 记下两套值', bg.light !== undefined && bg.dark !== undefined)
  check('两值不同即为翻转', bg.flips === true)
  check('两值相同不算翻转', tokens.get('--dsw-static-blue-500').flips === false)
  check('只在浅色定义的令牌不算翻转', parseTokens([{ name: 'x', css: 'body { --dsw-alias-only: red; }' }]).tokens.get('--dsw-alias-only').flips === false)
  check('记住来源文件', bg.source === 'design-platform.css', bg.source)
}

console.log('\n=== dangling:引用不存在的令牌 ===')
{
  const found = lint('.a { color: var(--dsw-alias-label-error); }')
  check('裸引用不存在的令牌被报', rules(found).includes('dangling'), JSON.stringify(rules(found)))
  check('报出的是那个令牌', found[0].token === '--dsw-alias-label-error', found[0].token)
  check('带上属性名', found[0].property === 'color', found[0].property)

  check('有回退值就不算悬空',
    lint('.a { font-family: var(--dsw-font-mono, monospace); }').length === 0,
    JSON.stringify(lint('.a { font-family: var(--dsw-font-mono, monospace); }')))
  check('同文件内自定义的令牌在作用域内',
    lint('.a { --dsw-local-x: red; color: var(--dsw-local-x); }').length === 0,
    JSON.stringify(rules(lint('.a { --dsw-local-x: red; color: var(--dsw-local-x); }'))))
  check('命名空间外的变量不归本契约管',
    lint('.a { color: var(--their-own-var); }').length === 0)
  check('已知令牌不报', lint('.a { color: var(--dsw-alias-label-primary); }').length === 0)
}

console.log('\n=== static-on-themed:把一套主题钉进两套 ===')
{
  const found = lint('.a { background: var(--dsw-static-white); }')
  check('主题属性上用 static 层被报', rules(found).includes('static-on-themed'), JSON.stringify(rules(found)))
  check('用 alias 层不报', lint('.a { background: var(--dsw-alias-bg-base); }').length === 0)
  check('非主题属性上用 static 不报',
    lint('.a { border-radius: var(--dsw-static-blue-500); }').length === 0,
    JSON.stringify(rules(lint('.a { border-radius: var(--dsw-static-blue-500); }'))))
  check('非颜色的 alias 用在非主题属性上不报',
    lint('.a { border-radius: var(--dsw-alias-radius-card); }').length === 0)
  check('主题属性清单含 box-shadow 与 fill',
    THEMED_PROPERTIES.includes('box-shadow') && THEMED_PROPERTIES.includes('fill'))
}

console.log('\n=== pinned-literal:该用令牌的地方写死了颜色 ===')
{
  check('不透明十六进制被报', rules(lint('.a { color: #fff; }')).includes('pinned-literal'))
  check('不透明 rgb() 被报', rules(lint('.a { background: rgb(255, 0, 0); }')).includes('pinned-literal'))
  check('报出的是那个字面量', lint('.a { color: #fff; }')[0].value === '#fff', lint('.a { color: #fff; }')[0].value)

  check('transparent 不报', lint('.a { background: transparent; }').length === 0)
  check('低透明度遮罩不报 —— 那是有意的与主题无关的叠加层',
    lint('.a { background: rgba(0, 0, 0, 0.24); }').length === 0,
    JSON.stringify(lint('.a { background: rgba(0, 0, 0, 0.24); }')))
  check('高透明度色值仍然报', rules(lint('.a { background: rgba(0, 0, 0, 0.9); }')).includes('pinned-literal'))
  check('八位十六进制按 alpha 判定',
    lint('.a { color: #0000003d; }').length === 0 && rules(lint('.a { color: #000000ee; }')).includes('pinned-literal'))
  check('三分量的 rgb() 是不透明的 —— 末位是蓝色通道,不是 alpha',
    rules(lint('.a { background: rgb(0, 0, 0); }')).includes('pinned-literal'),
    JSON.stringify(lint('.a { background: rgb(0, 0, 0); }')))
  check('斜杠语法的 alpha 也认',
    lint('.a { background: rgb(255 255 255 / 0); }').length === 0
    && rules(lint('.a { background: rgb(255 255 255 / 0.9); }')).includes('pinned-literal'))
  check('已经用了 var() 的声明不再挑字面量 —— 那是回退值',
    lint('.a { color: var(--dsw-alias-label-primary, #fff); }').length === 0)
  check('非主题属性上的数值不报', lint('.a { z-index: 100; }').length === 0)
}

console.log('\n=== 定位与汇总 ===')
{
  const css = '.a {\n  color: red;\n}\n.b {\n  color: var(--dsw-nope);\n}\n'
  const found = lint(css, 'x.css')
  check('带上文件名', found.every(f => f.file === 'x.css'))
  check('行号指向声明本身', found.find(f => f.rule === 'dangling').line === 5,
    String(found.find(f => f.rule === 'dangling').line))

  const s = summarize(found)
  check('汇总总数对得上', s.total === found.length, `${s.total} vs ${found.length}`)
  check('汇总按规则分组', s.byRule.dangling === 1, JSON.stringify(s.byRule))
  check('空输入汇总为零', summarize([]).total === 0)
}

console.log('\n=== 严重级:只有一条规则自证是缺陷 ===')
{
  check('dangling 是 error —— 解析为空,设计上不可能是故意的',
    lint('.a { color: var(--dsw-nope); }')[0].severity === 'error')
  check('static-on-themed 只是建议 —— 品牌色在两色下故意一致',
    lint('.a { background: var(--dsw-static-white); }')[0].severity === 'advisory')
  check('pinned-literal 只是建议 —— 两色都深的浮层上白字是对的',
    lint('.a { color: #fff; }')[0].severity === 'advisory')

  const mixed = lint('.a { color: var(--dsw-nope); background: #fff; }')
  const s = summarize(mixed)
  check('汇总分开数 error 与 advisory', s.errors === 1 && s.advisories === 1, JSON.stringify(s))
  check('error 数才是门禁该看的', s.errors < s.total, JSON.stringify(s))
  check('全是建议时 error 为零', summarize(lint('.a { color: #fff; }')).errors === 0)
}

console.log('\n=== 声明发射:契约可发布的那一半 ===')
{
  const dts = renderDeclaration(vocabulary)
  check('按层分出联合类型', dts.includes('export type AliasToken =') && dts.includes('export type StaticToken ='))
  check('DesignToken 合并所有层', /export type DesignToken = \w+Token \| \w+Token/.test(dts))
  check('每个令牌都在里面', [...vocabulary.tokens.keys()].every(t => dts.includes(`'${t}'`)))
  check('ThemedToken 只含翻转的', dts.split('ThemedToken =')[1].includes('--dsw-alias-bg-base')
    && !dts.split('ThemedToken =')[1].includes('--dsw-static-blue-500'))
  check('层注释报出翻转数', /`alias` tier: 3 tokens, 2 redefined/.test(dts),
    (dts.match(/`alias` tier[^*]*/) ?? [''])[0].trim())
  check('以单个换行收尾', dts.endsWith('\n') && !dts.endsWith('\n\n'))
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
