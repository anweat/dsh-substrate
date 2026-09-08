import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const root = process.env.DSH_ROOT
const here = 'D:/codeproject/dsh-browser-issue11-20260907'
const mode = process.argv[2] ?? 'original'
const load = p => import(pathToFileURL(join(root, p)).href)
const { boot } = await load('packages/boot/app-boot/src/index.ts')
const { Context } = await load('vendor/cordis/src/index.ts')
const { default: Include, entryListSchema } = await load('vendor/include/src/index.ts')
const yaml = createRequire(join(root, 'package.json'))('js-yaml')
const substrate = 'D:/codeproject/dsh-substrate'
const local = process.env.LOCAL_BROWSER === '1'
const browserDir = local ? 'D:/codeproject/dsh-browser' : join(here, 'anweat-dsh-browser-0.1.10/package')
const builtinDir = join(here, 'dsh-builtin-browser-0.1.20/package')
const webDir = local ? 'D:/codeproject/dsh-web-search-pro' : join(here, 'dsh-web-search-pro-0.1.11/package')
const readRows = dir => yaml.load(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), {schema: entryListSchema}).flatMap(p => p.insert ?? [])
const builtin = readRows(builtinDir), third = readRows(browserDir), web = readRows(webDir)
const out = join(here, `${local ? 'local' : 'published'}-${mode}-release-actions`)
mkdirSync(out, {recursive:true})
third[0].config = {...third[0].config, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, snapshotDir: join(out, 'snapshots'), automationAssets: {directory:join(out,'assets')}}
web[0].config = {...web[0].config, dbPath:join(out, 'search.sqlite')}
const rewrites = []
// Execute exactly the resolver shipped in the patch at its intended pre-patch hook.
// This is an in-process source-checkout experiment, not an installation repair.
if (mode !== 'original' && mode !== 'disabled') {
  const additions = readFileSync(join(substrate,'patches/@deepseek-ai__cordis-plugin-include@1.0.6.patch'),'utf8').split(/\r?\n/).filter(l=>l.startsWith('+')&&!l.startsWith('+++')).map(l=>l.slice(1)).join('\n')
  const body = additions.match(/function resolveDuplicateEntryIds\(data, log\) \{[\s\S]*?\n\}/)[0]
  const resolve = new Function(`${body}; return resolveDuplicateEntryIds`)()
  const original = Include.prototype.applyPatches
  Include.prototype.applyPatches = function(data,patches) {resolve(data,m=>rewrites.push(m)); return original.call(this,data,patches)}
}
const dependencies = [
  {id:'system-prompt',name:'@deepseek-ai/dsh-system-prompt'},
  {id:'tools',name:'@deepseek-ai/dsh-tools',config:{mode:'native'}},
]
const group = (rows, tools) => ({id:'third-party-realm',name:'cordis:group',group:true,isolate:tools?{tools:true}:{},config:rows})
let rows = [...dependencies, ...builtin, ...third, ...web]
if (mode === 'builtin') rows=[...dependencies,...builtin]
if (mode === 'third') rows=[...dependencies,...third,...web]
if (mode === 'services' || mode === 'scoped') {
  builtin.forEach(r=>r.isolate={browser:'builtin-browser'})
  ;[...third,...web].forEach(r=>r.isolate={browser:'anweat-browser'})
  const children = [...third, ...web]
  if (mode === 'scoped') {
    writeFileSync(join(out,'shim.mjs'), `import {createScope} from '@deepseek-ai/dsh-scope';\nimport {makeToolsShim} from '${pathToFileURL(join(substrate,'substrate/src/tools-shim.mjs')).href}';\nexport default makeToolsShim(createScope);\n`)
    children.unshift({id:'scope-shim',name:'./shim.mjs',config:{scope:'anweat-stack'}})
  }
  rows = [...dependencies,...builtin,group(children,mode==='scoped')]
}
// Resolve published entry points explicitly; the real YAML rows/configs stay intact.
mkdirSync(join(out,'node_modules/@anweat'),{recursive:true})
for (const [name,dir] of [['dsh-builtin-browser',builtinDir],['@anweat/dsh-browser',browserDir],['dsh-web-search-pro',webDir]]) {
 const link=join(out,'node_modules',name)
 if(!existsSync(link))symlinkSync(dir,link,'junction')
}
writeFileSync(join(out,'cordis.yml'),yaml.dump(rows,{schema:entryListSchema,noRefs:true}))
const leaves = e => e?.errors ? e.errors.flatMap(leaves) : e?.cause ? leaves(e.cause) : [String(e?.message??e)]
let result
try {
 const ctx = await boot('issue11',join(out,'cordis.yml'),mode==='disabled'?[{id:'browser',disabled:true}]:[], process.env.DIAG ? ctx=>{
   const dispose=ctx.fiber.dispose.bind(ctx.fiber)
   ctx.fiber.dispose=async()=>{
    const entries=[...ctx.get('loader')?.entries()??[]].map(e=>({id:e.id,name:e.options.name,state:e.fiber?.state,uid:e.fiber?.uid,browserKey:String(e.ctx[Context.isolate].browser),fiberBrowserKey:String(e.fiber?.ctx[Context.isolate].browser),browser:e.ctx.get('browser',false)?.constructor?.name,provided:e.fiber?.store?Object.keys(e.fiber.store):[]}))
    const services=Reflect.ownKeys(ctx.reflect.store).map(k=>({key:String(k),name:ctx.reflect.store[k].name,uid:ctx.reflect.store[k].fiber.uid,provider:ctx.reflect.store[k].fiber.name}))
    writeFileSync(join(out,'diagnostics.json'),JSON.stringify({entries,services},null,2))
    return dispose()
   }
 } : undefined)
 const runtime = ctx.get('tools')
 const global = runtime.schemas().map(t=>({name:t.name,description:t.description}))
 const ledger=ctx.root[Symbol.for('dsh-substrate: tools scopes')]
 const scopes = [...ledger??[]].map(([owner,{key}])=>({owner,tools:runtime.schemas(key).map(t=>({name:t.name,description:t.description}))}))
 result={ok:true,mode,root,local,rewrites,global,scopes,entries:[...ctx.loader.entries()].map(e=>({id:e.id,name:e.options.name,state:e.fiber?.state,browser:e.ctx.get('browser',false)?.constructor?.name}))}
 const {createServer}=await import('node:http')
 const assert=(await import('node:assert/strict')).default
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<title>DSH conflict acceptance</title><label>Name<input id="name"></label><button id="submit" onclick="document.querySelector('#result').textContent='Hello '+document.querySelector('#name').value">Submit</button><p id="result">Waiting</p><div style="height:1800px">Scroll fixture</div>`)})
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const actions=[];const key=ledger.get('anweat-stack').key
 try {
  const call=async(name,args)=>{const r=await runtime.execute({callId:String(actions.length),name,arguments:args,agent:key,signal:new AbortController().signal});assert.notEqual(r.isError,true,JSON.stringify(r));actions.push({name,result:r});return r}
  const opened=await call('browser_open',{url:'http://127.0.0.1:'+server.address().port});assert.match(JSON.stringify(opened),/DSH conflict acceptance/)
  // Selectors belong to the local fixture whose source is above.
  await call('browser_type',{selector:'#name',text:'Substrate'})
  const clicked=await call('browser_click',{selector:'#submit'});assert.match(JSON.stringify(clicked),/Hello Substrate/)
  await call('browser_scroll',{deltaY:500});await call('browser_screenshot',{})
  assert.deepEqual(runtime.schemas().map(t=>({name:t.name,description:t.description})),global)
  result.actions=actions;result.browserActionsTested=true
 } finally {server.close();await ctx.fiber.dispose()}
} catch(e) {result={ok:false,mode,root,local,rewrites,errors:leaves(e)}}
writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify(result,null,2))
