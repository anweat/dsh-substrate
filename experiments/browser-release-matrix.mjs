/** Real Chrome against packed npm alpha CLI installations; no browser RPC doubles. */
import {createRequire} from 'node:module'
import {mkdirSync,writeFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
import {join,resolve} from 'node:path'
import assert from 'node:assert/strict'
const out=resolve(process.argv[2]),{chromium}=createRequire(resolve(process.argv[3],'package.json'))('playwright')
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
const results=[]
try{for(const version of ['0.1.2-alpha.2','0.1.2-alpha.3','0.1.2-alpha.4','0.1.2-alpha.5']){
 const root=join(out,version),home=join(root,'home'),profile=join(home,'profiles/web');mkdirSync(profile,{recursive:true})
 writeFileSync(join(profile,'package.json'),JSON.stringify({name:'dsh-profile-web',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@anweat/dsh-substrate'],patchReload:'live'}}}))
 let log='';const start=performance.now()
 const server=spawn(process.execPath,['--expose-internals','node_modules/@deepseek-ai/dsh/lib/bin.js','web','--no-open','--port','18765'],{cwd:root,env:{...process.env,DSH_HOME:home},stdio:['ignore','pipe','pipe'],windowsHide:true})
 server.stdout.on('data',b=>log+=b);server.stderr.on('data',b=>log+=b)
 const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']})
 try{
  while(!log.includes('dsh web:')){if(server.exitCode!==null||performance.now()-start>45000)throw Error(log);await new Promise(r=>setTimeout(r,100))}
  const readyMs=performance.now()-start,url=log.match(/dsh web: (\S+)/)[1]
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)))
  const open=async(url)=>{await page.goto(url,{waitUntil:'networkidle'});for(const name of ['继续','稍后配置']){const button=page.getByRole('button',{name,exact:true});try{await button.waitFor({state:'visible',timeout:1500});await button.click()}catch(e){if(!String(e).includes('Timeout'))throw e}}await page.getByRole('button',{name:'设置',exact:true}).click();const later=page.getByRole('button',{name:'稍后配置',exact:true});if(await later.isVisible())await later.click();await page.getByRole('button',{name:'插件',exact:true}).click();await page.getByRole('button',{name:/插件兼容性/}).click()}
  await open(url)
  const field=page.getByLabel('启动检测静默窗口',{exact:true}),save=page.getByRole('button',{name:'保存',exact:true})
  assert.equal(await field.inputValue(),'250');await field.fill('-1');assert.equal(await save.isDisabled(),true)
  await page.getByRole('button',{name:'放弃',exact:true}).click();assert.equal(await field.inputValue(),'250')
  await field.fill('800');await save.click();await page.waitForFunction(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='保存')?.disabled)
  await open('http://127.0.0.1:18765/');assert.equal(await field.inputValue(),'800')
  await page.getByRole('button',{name:'恢复默认',exact:true}).click();await save.click();await page.waitForFunction(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='保存')?.disabled)
  await open('http://127.0.0.1:18765/');assert.equal(await field.inputValue(),'250')
  assert.ok((await page.locator('body').innerText()).includes(`@deepseek-ai/dsh-app-boot@${version}`))
  await page.getByRole('button',{name:'复制修复命令',exact:true}).click();assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/repair --apply --home/)
  await page.screenshot({path:join(root,'browser-settings.png'),fullPage:true});assert.deepEqual(errors,[])
  results.push({version,ok:true,readyMs,checks:['real Chrome card','validation','discard','save/reload','reset/reload','exact target','clipboard','no page errors']})
 }catch(e){results.push({version,ok:false,error:String(e)})}
 finally{await context.close();server.kill();await new Promise(r=>{if(server.exitCode!==null)r();else server.once('exit',r)});writeFileSync(join(root,'web-log.txt'),log.replace(/\?token=\S+/g,'?token=[redacted]'))}
 writeFileSync(join(out,'browser-results.json'),JSON.stringify(results,null,2));console.log(results.at(-1))
}}finally{await browser.close()}
process.exitCode=results.every(r=>r.ok)?0:1
