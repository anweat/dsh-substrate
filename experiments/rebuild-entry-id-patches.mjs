/** Regenerate all shipped patches from pristine npm pack extraction directories. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
const repo=resolve(import.meta.dirname,'..'), artifacts=process.argv[2], loaders=process.argv[3]
const old=readFileSync(`${repo}/patches/@deepseek-ai__cordis-plugin-include@1.0.7.patch`,'utf8')
const additions=old.split(/\r?\n/).filter(l=>l.startsWith('+')&&!l.startsWith('+++')).map(l=>l.slice(1)).join('\n')
const fn=additions.match(/function resolveDuplicateEntryIds\(data, log\) \{[\s\S]*?\n\}/)?.[0]
if(!fn)throw Error('Missing resolver')
for(const [name,versions] of [['cordis-plugin-include',['1.0.6','1.0.7']],['dsh-app-boot',['0.1.2-alpha.2','0.1.2-alpha.3','0.1.2-alpha.4','0.1.2-alpha.5']]])for(const version of versions){
 const input=name==='dsh-app-boot'?`${artifacts}/build-${version}`:`${loaders}/${version}`
 const original=readFileSync(`${input}/package/lib/index.js`,'utf8').replaceAll('\r\n','\n')
 const hook=/\tapplyPatches\(data, patches\) \{\n\t\treturn applyEntryPatches\(data, patches, \(message, \.\.\.args\) => \{\n\t\t\tthis.ctx.root.logger\?\.\("loader"\).warn\(message, \.\.\.args\);\n\t\t\}\);\n\t\}/
 if(!hook.test(original))throw Error(`Unexpected layout ${name}@${version}`)
 const code=original.replace('function applyEntryPatches(',`${fn}\nfunction applyEntryPatches(`).replace(hook,`\tapplyPatches(data, patches) {
\t\t// dsh-substrate entry-id repair v4
\t\tconst log = message => this.ctx.root.logger?.("loader").info(message);
\t\tconst warn = (message, ...args) => this.ctx.root.logger?.("loader").warn(message, ...args);
\t\tlet result = structuredClone(data);
\t\tresolveDuplicateEntryIds(result, log);
\t\t// Normalize each overlay before the next overlay can address its rows.
\t\tfor (const patch of patches ?? []) {
\t\t\tconst next = structuredClone(patch);
\t\t\t// Existing claimants retain their IDs even when a group is earlier in tree order.
\t\t\tif (next.insert) resolveDuplicateEntryIds([...result, ...next.insert], log);
\t\t\telse if (Array.isArray(next.config)) {
\t\t\t\tconst reserved = structuredClone(result);
\t\t\t\tconst find = rows => { for (const row of rows) { if (row.id === next.id) return row; if (row.group && Array.isArray(row.config)) { const found = find(row.config); if (found) return found; } } };
\t\t\t\tconst target = find(reserved);
\t\t\t\tif (target?.group && (!next.name || next.name === target.name)) {
\t\t\t\t\ttarget.config = [];
\t\t\t\t\tresolveDuplicateEntryIds([...reserved, ...next.config], log);
\t\t\t\t}
\t\t\t}
\t\t\tresult = applyEntryPatches(result, [next], warn);
\t\t\tresolveDuplicateEntryIds(result, log);
\t\t}
\t\treturn result;
\t}`)
 const dir=`${artifacts}/release-patches/${name}-${version}`
 for(const part of ['original','patched'])mkdirSync(`${dir}/${part}/lib`,{recursive:true})
 writeFileSync(`${dir}/original/lib/index.js`,original);writeFileSync(`${dir}/patched/lib/index.js`,code)
 const diff=spawnSync('git',['-c','core.autocrlf=false','diff','--no-index','--','original/lib/index.js','patched/lib/index.js'],{cwd:dir,encoding:'utf8'})
 if(diff.status!==1)throw Error(diff.stderr)
 for(const dest of ['patches','plugin/patches'])writeFileSync(`${repo}/${dest}/@deepseek-ai__${name}@${version}.patch`,diff.stdout.replaceAll('a/original/','a/').replaceAll('b/patched/','b/'))
 console.log(`${name}@${version}`)
}
