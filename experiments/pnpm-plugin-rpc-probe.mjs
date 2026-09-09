/** Packaged services and client controller over real authenticated loopback HTTP. */
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as connection from '@deepseek-ai/dsh-client-connection'
import * as substrate from '@anweat/dsh-substrate'
import Tools from '@deepseek-ai/dsh-tools'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Settings from '@deepseek-ai/dsh-settings-file'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {writeFileSync,copyFileSync} from 'node:fs'
const require=createRequire(import.meta.url),dir=dirname(require.resolve('@anweat/dsh-substrate/package.json'))
// Node refuses TS stripping in node_modules; copy the shipped source byte-for-byte.
copyFileSync(join(dir,'src/client/patch-controller.ts'),join(import.meta.dirname,'patch-controller.ts'))
const {PatchController}=await import(pathToFileURL(join(import.meta.dirname,'patch-controller.ts')).href)
const root=new Context();let assertions=0;const check=(label,fn)=>{fn();assertions++;console.log(`PASS ${label}`)}
try{
 await root.plugin(Prompt);await root.plugin(Tools,{mode:'native'});await root.plugin(Settings,{watch:false})
 await root.plugin(WebServer,{host:'127.0.0.1',port:0})
 // The same in-memory credential record seam as upstream auth tests. Transport/auth are real.
 let record;root.provide('credentials',{readRecord:async()=>record,modifyRecord:async(_key,fn)=>(record=await fn(record)),deleteRecord:async()=>{record=undefined}})
 await root.plugin(connection,{trustedHosts:[]})
 const fiber=await root.plugin(substrate,{settleMs:10})
 check('Host registers the settings namespace',()=>assert.ok(root.get('settings').describe().some(d=>d.ns==='dsh-substrate')))
 await root.get('settings').update('dsh-substrate',{settleMs:20})
 check('settings edits commit through the real provider',()=>assert.equal(root.get('settings').describe().find(d=>d.ns==='dsh-substrate').user.settleMs,20))
 await root.get('settings').replace('dsh-substrate',{})
 check('reset removes the user override',()=>assert.equal(root.get('settings').describe().find(d=>d.ns==='dsh-substrate').user?.settleMs,undefined))
 const transport=root.get('connection'),port=root.get('webServer').port,base=`http://127.0.0.1:${port}`
 const headers={'content-type':'application/json',connection:'close'}
 transport.authorizeIndex({method:'GET',url:transport.authenticatedUrl(`${base}/`),headers:{host:`127.0.0.1:${port}`}},{writeHead(_s,h){if(h['set-cookie'])headers.cookie=h['set-cookie'].split(';')[0]},end(){}})
 check('real authentication issues a browser session',()=>assert.ok(headers.cookie))
 const request=(method,signed=true)=>fetch(`${base}/api/dsh-substrate/${method}`,{method:'POST',headers:signed?headers:{'content-type':'application/json',connection:'close'},body:JSON.stringify({type:'client-request',rpcId:'probe',method:`dsh-substrate/${method}`,payload:{}})})
 const response=await request('status'),body=await response.json()
 check('status route returns a successful RPC envelope',()=>{assert.equal(response.status,200);assert.equal(body.result.ok,true)})
 const business=body.result
check('business status names the actual audited app-boot patch',()=>{assert.equal(business.ok,true);assert.match(business.value.target,/@deepseek-ai\/dsh-app-boot@0.1.[235]-(?:alpha|rc)/);assert.equal(business.value.state,'available')})
 const controller=new PatchController({call:async(_channel,method)=>{const r=await request(method.split('/').at(-1));return (await r.json()).result}})
 await new Promise(r=>setTimeout(r,80))
 check('packaged client controller decodes the live status',()=>{const view=controller.inject().hooks.substratePatch.getSnapshot();assert.equal(view.loaded,true);assert.equal(view.status.target,business.value.target);assert.equal(view.error,undefined)})
 controller.dispose()
 const unsigned=await request('status',false)
 check('unsigned requests are rejected',()=>assert.equal(unsigned.status,401))
 const denied=await request('apply')
 check('RPC exposes no installation write operation',()=>assert.equal(denied.status,404))
 await fiber.dispose()
 check('unload removes settings registration',()=>assert.ok(!root.get('settings').describe().some(d=>d.ns==='dsh-substrate')))
 const unloaded=await request('status')
 check('unload removes the HTTP route',()=>assert.equal(unloaded.status,404))
 writeFileSync(join(import.meta.dirname,'rpc-result.json'),JSON.stringify({ok:true,assertions,target:business.value.target}))
}finally{await root.fiber.dispose()}
