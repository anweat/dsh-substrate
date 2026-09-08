/** Runs only from a prepared npm installation; no source aliases or monkeypatches. */
import {boot} from '@deepseek-ai/dsh-app-boot'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
const require=createRequire(import.meta.url),root=import.meta.dirname
const pluginDir=dirname(require.resolve('@anweat/dsh-substrate/package.json'))
const {status}=await import(pathToFileURL(join(pluginDir,'src/patch-rpc.mjs')).href)
const mode=process.argv[2],out=join(root,'cases',mode);mkdirSync(out,{recursive:true})
writeFileSync(join(out,'a.mjs'),"export function apply(){globalThis.owners??=[];globalThis.owners.push('a')}")
writeFileSync(join(out,'b.mjs'),"export function apply(){globalThis.owners??=[];globalThis.owners.push('b')}")
const base=[{id:'prompt',name:'@deepseek-ai/dsh-system-prompt'},{id:'tools',name:'@deepseek-ai/dsh-tools',config:{mode:'native'}},{id:'settings',name:'@deepseek-ai/dsh-settings-file'},{id:'substrate',name:'@anweat/dsh-substrate',config:{settleMs:10}}]
if(mode==='bare')base.pop()
const pair=[{id:'browser',name:'./a.mjs'},{id:['clean','bare'].includes(mode)?'browser-b':'browser',name:'./b.mjs'}]
const rows=mode==='nested'?[...base,pair[0],{id:'group',name:'cordis:group',group:true,config:[pair[1]]}]:[...base,...pair]
writeFileSync(join(out,'cordis.json'),JSON.stringify(rows))
const logs=[];const old=console.log;console.log=(...args)=>{logs.push(args.join(' '));old(...args)}
let result
try{
 const start=performance.now()
 const ctx=await boot('pnpm-substrate',join(out,'cordis.json'),mode==='disabled'?[{id:'browser',disabled:true}]:[])
 const bootMs=performance.now()-start
 await new Promise(r=>setTimeout(r,60))
 result={ok:true,mode,bootMs,owners:globalThis.owners??[],entries:[...ctx.loader.entries()].map(e=>({id:e.id,name:e.options.name,state:e.fiber?.state})),status:status(process.env.DSH_HOME),logs}
 await ctx.fiber.dispose()
}catch(e){result={ok:false,mode,error:String(e.stack??e),owners:globalThis.owners??[],status:status(process.env.DSH_HOME),logs}}
writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));old(JSON.stringify(result))
