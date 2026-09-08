import {boot} from '@deepseek-ai/dsh-app-boot'
import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import assert from 'node:assert/strict'
const dir=join(import.meta.dirname,'edge-cases');mkdirSync(dir,{recursive:true})
for(const owner of ['a','b','c'])writeFileSync(join(dir,`${owner}.mjs`),`export function apply(ctx,config){globalThis.__edge.push(config?.owner??'${owner}')}`)
const row=(id,name='a',extra={})=>({...(id===undefined?{}:{id}),name:`./${name}.mjs`,...extra})
const group=(id,config)=>({id,name:'cordis:group',group:true,config})
const cases=[
 {name:'unique',rows:[row('a'),row('b','b')],owners:['a','b']},
 {name:'flat',rows:[row('browser'),row('browser','b')],owners:['a','b']},
 {name:'deep',rows:[row('browser'),group('outer',[group('inner',[row('browser','b')])])],owners:['a','b']},
 {name:'sibling-groups',rows:[group('g1',[row('browser')]),group('g2',[row('browser','b')])],owners:['a','b']},
 {name:'duplicate-groups',rows:[group('g',[row('browser')]),group('g',[row('browser','b')])],owners:['a','b']},
 {name:'reserved-slug',rows:[row('browser'),row('browser','b'),row('b-mjs','c')],owners:['a','b','c']},
 {name:'same-module',rows:[row('browser','a',{config:{owner:'first'}}),row('browser','a',{config:{owner:'second'}})],owners:['first','second']},
 {name:'disabled',rows:[row('browser','a',{disabled:true}),row('browser','b')],owners:['b']},
 {name:'missing-ids',rows:[row(undefined),row(undefined,'b')],owners:['a','b']},
 {name:'insert',rows:[row('browser')],patches:[{insert:[row('browser','b')]}],owners:['a','b']},
 {name:'insert-addressing',rows:[row('browser')],patches:[{insert:[row('browser','b')]},{id:'browser',disabled:true}],owners:['b']},
 {name:'insert-group',rows:[group('g',[row('browser')])],patches:[{id:'g',insert:[row('browser','b')]}],owners:['a','b']},
 {name:'replace-group',rows:[group('g',[])],patches:[{id:'g',config:[row('browser'),row('browser','b')]}],owners:['a','b']},
 {name:'early-group-insert-addressing',rows:[group('g',[]),row('browser')],patches:[{id:'g',insert:[row('browser','b')]},{id:'browser',disabled:true}],owners:['b']},
 {name:'early-group-replace-addressing',rows:[group('g',[]),row('browser')],patches:[{id:'g',config:[row('browser','b')]},{id:'browser',disabled:true}],owners:['b']},
]
const results=[]
for(const test of cases){
 globalThis.__edge=[];const path=join(dir,'cordis.json');writeFileSync(path,JSON.stringify(test.rows))
 const original=JSON.stringify(test.patches);let ctx;const start=performance.now()
 try{
  ctx=await boot('entry-id-stress',path,test.patches)
  assert.deepEqual(globalThis.__edge.sort(),test.owners.slice().sort())
  const entries=[...ctx.loader.entries()];assert.equal(new Set(entries.map(e=>e.id)).size,entries.length)
  assert.equal(JSON.stringify(test.patches),original,'patch inputs must not be mutated')
  results.push({name:test.name,ok:true,bootMs:performance.now()-start,entries:entries.map(e=>({id:e.id,name:e.options.name}))})
 }catch(e){results.push({name:test.name,ok:false,error:String(e.message),bootMs:performance.now()-start})}
 finally{await ctx?.fiber.dispose()}
}
writeFileSync(join(import.meta.dirname,process.argv[2]??'entry-id-stress.json'),JSON.stringify(results,null,2))
console.log(JSON.stringify(results.map(({name,ok,error})=>({name,ok,error}))))
process.exitCode=results.every(r=>r.ok)?0:1
