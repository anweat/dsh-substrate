import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {resolvePatchTarget} from '../src/patch-target.mjs'
import {patchFor,stage} from '../src/stage-patch.mjs'
import {status,apply,PATCH_MARKER} from '../src/patch-rpc.mjs'
let count=0
const check=(name,fn)=>{fn();count++;console.log(`PASS ${name}`)}
for(const version of [
 '0.1.2-alpha.2','0.1.2-alpha.3','0.1.2-alpha.4','0.1.2-alpha.5',
 '0.1.2-rc.1','0.1.3-alpha.2','0.1.5-alpha.1',
 // This Git tag was never published as an installable app-boot package.
 '0.1.3-alpha.1',
]){
 const root=mkdtempSync(join(tmpdir(),'substrate-alpha-target-')),home=join(root,'home')
 for(const [name,v] of [['dsh-app-boot',version],['cordis-plugin-include','1.0.7']]){
  const dir=join(root,'node_modules/@deepseek-ai',name),link=join(home,'profiles/node_modules/@deepseek-ai',name)
  mkdirSync(join(dir,'lib'),{recursive:true});mkdirSync(join(link,'..'),{recursive:true})
  writeFileSync(join(dir,'package.json'),JSON.stringify({name:`@deepseek-ai/${name}`,version:v}))
  writeFileSync(join(dir,'lib/index.js'),'unpatched');symlinkSync(dir,link,'junction')
 }
 const found=resolvePatchTarget(home)
 check(`${version}: prefer actual bundled boot over unused include`,()=>assert.equal(found.version,version))
 if(!patchFor(version)){
  check('unknown boot cannot fall back to a misleading supported include patch',()=>{assert.equal(status(home).state,'version-mismatch');assert.equal(apply(home).ok,false)})
  continue
 }
 check(`${version}: target and available state match the boot artifact`,()=>{assert.equal(status(home).target,`@deepseek-ai/dsh-app-boot@${version}`);assert.equal(status(home).state,'available')})
 const written=apply(home)
 check(`${version}: declared until real code is patched`,()=>{assert.ok(written.ok);assert.equal(status(home).state,'install-required')})
 writeFileSync(join(found.packageDir,'lib/index.js'),'function resolveDuplicateEntryIds(data, log) {}\n// dsh-substrate entry-id repair v3')
 check(`${version}: obsolete repair does not count as installed`,()=>assert.equal(status(home).state,'install-required'))
 writeFileSync(join(found.packageDir,'lib/index.js'),PATCH_MARKER)
 check(`${version}: disk and process states remain separate`,()=>{assert.equal(status(home,{bootApplied:false}).state,'restart-required');assert.equal(status(home,{bootApplied:true}).state,'verified')})
 const patch=patchFor(version),path=join(root,'patches',patch.file)
 writeFileSync(path,'older patch contents')
 check(`${version}: reinstall updates an older declared patch`,()=>{assert.equal(stage(root,undefined,version).changed,true);assert.ok(readFileSync(path,'utf8').includes(PATCH_MARKER));assert.equal(stage(root,undefined,version).changed,false)})
}
console.log(`${count} assertions`)
