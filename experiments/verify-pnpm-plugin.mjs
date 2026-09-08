/** Full CLI + packed plugin installs, exact alpha core pins, real boot and CLI repair. */
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,symlinkSync,existsSync,openSync,closeSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const out=resolve(process.argv[2]),tarball=resolve(process.argv[3]);mkdirSync(out,{recursive:true})
const results=[]
let timings={}
function run(cmd,args,cwd,log){const start=performance.now();const fd=openSync(join(cwd,log),'w');let result;try{result=spawnSync(cmd,args,{cwd,shell:cmd.endsWith('.cmd'),stdio:['ignore',fd,fd],timeout:240000,env:{...process.env,CI:'true',DSH_HOME:join(cwd,'home')}})}finally{closeSync(fd);timings[log]=performance.now()-start}if(result.status!==0)throw Error(`${log} failed: ${result.status} ${result.error??''} ${readFileSync(join(cwd,log),'utf8').slice(-600)}`)}
for(const version of ['0.1.2-alpha.2','0.1.2-alpha.3','0.1.2-alpha.4','0.1.2-alpha.5']){
 const root=join(out,version);if(existsSync(root)){
   if(!process.argv.includes('--resume')||JSON.parse(readFileSync(join(root,'package.json'),'utf8')).dependencies['@deepseek-ai/dsh']!==version)throw Error(`Refusing existing fixture ${root}`)
 }else mkdirSync(root)
 try{
 timings={}
 writeFileSync(join(root,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'@deepseek-ai/dsh':version,'@deepseek-ai/dsh-app-boot':version,'@deepseek-ai/dsh-tools':version,'@deepseek-ai/dsh-system-prompt':version,'@deepseek-ai/dsh-settings':version,'@anweat/dsh-substrate':`file:${tarball.replaceAll('\\','/')}`}},null,2))
 writeFileSync(join(root,'pnpm-workspace.yaml'),"packages:\n  - '.'\nnodeLinker: hoisted\nautoInstallPeers: true\nignoreScripts: true\n")
 // Official packages use caret prereleases. Pin the DSH family to avoid testing a newer RC accidentally.
 writeFileSync(join(root,'.pnpmfile.cjs'),`module.exports={hooks:{readPackage(pkg){for(const key of ['dependencies','optionalDependencies','peerDependencies'])for(const [name,value] of Object.entries(pkg[key]||{})){if(name.startsWith('@deepseek-ai/dsh-')&&/^[~^]?0\\.1\\./.test(value))pkg[key][name]='${version}';}return pkg;}}};`)
 run('pnpm.cmd',['install','--ignore-scripts','--no-frozen-lockfile'],root,'install.log')
 const profileModules=join(root,'home/profiles/node_modules/@deepseek-ai');mkdirSync(profileModules,{recursive:true})
 for(const name of ['dsh-app-boot','cordis-plugin-include'])if(!existsSync(join(profileModules,name)))symlinkSync(join(root,'node_modules/@deepseek-ai',name),join(profileModules,name),'junction')
 copyFileSync(join(import.meta.dirname,'pnpm-plugin-probe.mjs'),join(root,'probe.mjs'))
 const probe=(mode,label)=>{run(process.execPath,['probe.mjs',mode],root,`${label}.log`);const value=JSON.parse(readFileSync(join(root,'cases',mode,'result.json'),'utf8'));writeFileSync(join(root,`${label}.json`),JSON.stringify(value,null,2));return value}
 const before=probe('flat','before');assert.equal(before.ok,false);assert.match(before.error,/duplicate loader entry id/)
 const clean=probe('clean','clean');assert.equal(clean.ok,true);assert.equal(clean.status.actualVersion,version)
 run('pnpm.cmd',['exec','dsh-substrate','repair','--apply','--yes','--home',join(root,'home')],root,'apply.log')
 const after=probe('flat','after'),nested=probe('nested','nested'),disabled=probe('disabled','disabled')
 for(const p of [after,nested]){assert.equal(p.ok,true);assert.deepEqual(p.owners.sort(),['a','b']);assert.equal(p.status.state,'verified');assert.ok(p.logs.some(l=>l.includes('启发式')))}
 assert.equal(disabled.ok,true);assert.deepEqual(disabled.owners,['b'])
 copyFileSync(join(import.meta.dirname,'pnpm-entry-id-stress.mjs'),join(root,'stress.mjs'))
 run(process.execPath,['stress.mjs'],root,'stress.log')
 const bootTimings=[]
 for(let iteration=0;iteration<5;iteration++)for(const mode of ['bare','clean'])bootTimings.push({iteration,mode,...probe(mode,`timing-${iteration}-${mode}`)})
 writeFileSync(join(root,'boot-timings.json'),JSON.stringify(bootTimings.map(({iteration,mode,bootMs,ok})=>({iteration,mode,bootMs,ok})),null,2))
 run('pnpm.cmd',['exec','dsh-substrate','repair','--apply','--yes','--home',join(root,'home')],root,'reapply.log')
 run('pnpm.cmd',['exec','dsh-substrate','repair','--revert','--yes','--home',join(root,'home')],root,'revert.log')
 const reverted=probe('flat','reverted');assert.equal(reverted.ok,false);assert.match(reverted.error,/duplicate loader entry id/)
 copyFileSync(join(import.meta.dirname,'pnpm-plugin-rpc-probe.mjs'),join(root,'rpc-probe.mjs'))
 run(process.execPath,['--experimental-transform-types','rpc-probe.mjs'],root,'rpc.log')
 results.push({version,ok:true,target:after.status.target,timings,checks:['packed plugin install','real app boot','Host reporter','settings registration','CLI apply','flat IDs','nested IDs','disabled addressing','15 duplicate ID scenarios','5 paired enable timings','verified status','idempotent apply','CLI revert']})
 }catch(e){results.push({version,ok:false,error:String(e)})}
 writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results.at(-1)))
}
process.exitCode=results.every(r=>r.ok)?0:1

