/** Regression for #11: groups share EntryTree IDs; exercise the shipped patch. */
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {boot} from './packages/boot/app-boot/src/index.ts'
import Include from './vendor/include/src/index.ts'

const source=process.env.DSH_SUBSTRATE!
const patch=readFileSync(resolve(source,'../../patches/@deepseek-ai__cordis-plugin-include@1.0.7.patch'),'utf8')
const additions=patch.split(/\r?\n/).filter(l=>l.startsWith('+')&&!l.startsWith('+++')).map(l=>l.slice(1)).join('\n')
const body=additions.match(/function resolveDuplicateEntryIds\(data, log\) \{[\s\S]*?\n\}/)![0]
const dedup=new Function(`${body}; return resolveDuplicateEntryIds`)()
const original=Include.prototype.applyPatches
const rewrites:string[]=[]
Include.prototype.applyPatches=function(data,patches) {
  dedup(data,(line:string)=>rewrites.push(line))
  return original.call(this,data,patches)
}
const dir=mkdtempSync(join(tmpdir(),'substrate-nested-id-'))
for(const owner of ['builtin','third','reserved'])writeFileSync(join(dir,`${owner}.mjs`),`export function apply(ctx){globalThis.__nestedOwners??=[];globalThis.__nestedOwners.push('${owner}');}`)
const config=[
 {id:'browser',name:'./builtin.mjs'},
 {id:'outer',name:'cordis:group',group:true,config:[
  {id:'inner',name:'cordis:group',group:true,config:[{id:'browser',name:'./third.mjs'}]},
 ]},
 {id:'third-mjs',name:'./reserved.mjs'},
]
writeFileSync(join(dir,'cordis.json'),JSON.stringify(config))
let count=0
const check=(name:string,fn:()=>void)=>{fn();count++;console.log(`PASS ${name}`)}
try {
 const ctx=await boot('nested-id',join(dir,'cordis.json'))
 try {
  const entries=[...ctx.loader.entries()]
  check('both conflicting owners and the reserved owner really mounted',()=>assert.deepEqual((globalThis as any).__nestedOwners.sort(),['builtin','reserved','third']))
  check('first claimant keeps its entry',()=>assert.equal(entries.find(e=>e.id==='include:browser')?.options.name,'./builtin.mjs'))
  check('nested loser uses its package slug without stealing a later explicit ID',()=>assert.equal(entries.find(e=>e.id==='include:third-mjs-2')?.options.name,'./third.mjs'))
  check('all entries are unique across nested groups',()=>assert.equal(new Set(entries.map(e=>e.id)).size,entries.length))
  check('rewrite is reported once',()=>assert.equal(rewrites.length,1))
 } finally {await ctx.fiber.dispose()}
} finally {Include.prototype.applyPatches=original}
console.log(`${count} assertions`)
