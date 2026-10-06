import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve('.');
const evidence = path.resolve(process.env.EVIDENCE_DIR || '.battle-browser-evidence');
await fs.mkdir(evidence, { recursive: true });
const clone = value => structuredClone(value);
const privateValues = ['PRIVATE-CREATOR-ALPHA', 'PRIVATE-PLAYER-ID', 'PRIVATE-PROMPT-TEXT', 'PRIVATE-ASSET-ID', 'https://private.invalid/PRIVATE-ASSET-URL'];
const question = { id:'q1', type:'single_choice', prompt:'Ordinary question remains usable', options:[{id:'a',label:'One'},{id:'b',label:'Two'}], correctOptionIds:['a'], round:1, totalRounds:2, roundTitle:'Ordinary round', questionInRound:1, questionsInRound:1 };
const definition = { title:'Acceptance Quiz', rounds:[{title:'Ordinary round',questions:[question]}, {type:'prompt_battle',title:'Fixture Battle', questions:[],engine:{maxSessionSpendUsd:9.5}}] };
function fixture() {
  const entrants = [
    {entryId:'e1',playerId:privateValues[1],playerName:privateValues[0],logoKey:'spark',attemptsUsed:2,submitted:true,submittedAssetId:privateValues[3],generations:[{attemptIndex:1,status:'complete',assetIds:[privateValues[3],privateValues[4]],playerPrompt:privateValues[2]}]},
    {entryId:'e2',playerId:'p2',playerName:'Pending Person',attemptsUsed:1,submitted:false,generations:[{attemptIndex:1,status:'pending',playerPrompt:privateValues[2],assetIds:[]}]},
    {entryId:'e3',playerId:'p3',playerName:'New Person',attemptsUsed:0,submitted:false,generations:[]}
  ];
  const battle = {roundIndex:1,phase:'battle_prompt',revision:41,opened:true,sessionSpendUsd:1.25,maxSessionSpendUsd:9.5,matchups:[{matchupId:'m1',matchupIndex:0,promptText:privateValues[2],entrants}]};
  const state = {phase:'battle_prompt',presentationScreen:'battle_prompt',questionId:'q1',question:{...question,round:2,roundTitle:'Fixture Battle'},battleRoundIndex:1,battleMatchupIndex:0,battleMatchupCount:1,players:[{id:'spectator',name:'Late Spectator',points:0}],presenterOverride:'Preserved credit',submitted:{}};
  return { definition:clone(definition), battle, saved:{phase:'battle_prompt',revision:41,roundIndex:1,questionIndex:0,state}, calls:[],broadcasts:[],mode:'normal',hold:false };
}
const hook = `\nwindow.__acceptance = {
 get state(){return structuredClone(state)}, get panel(){return structuredClone(battleRoundPanel)},
 projection:()=>publicRoomState(), payload:()=>hostStatePayload(),
 seed:(value,privatePayload)=>{state={...state,...value}; if(privatePayload) battleRoundPanel={...battleRoundPanel,state:privatePayload}; render()},
 refresh:()=>refreshBattlePairing(), render:()=>render(),
};\n`;
const fakeModule = `export function createClient(){return {
 channel(){const c={on(){return c},subscribe(fn){fn('SUBSCRIBED');return c},send(message){window.__fixture.broadcasts.push(structuredClone(message));return Promise.resolve()},unsubscribe(){}};return c},
 async rpc(name,args){const f=window.__fixture;f.calls.push({name,args:structuredClone(args)});
 if(name==='get_host_quiz_definition')return {data:structuredClone(f.definition)};
 if(name==='get_host_live_room_state')return {data:structuredClone(f.saved)};
 if(name==='get_host_battle_state'){
  if(f.hold)await new Promise(resolve=>window.__release=resolve);
  if(f.mode==='fail-refresh')return {error:{message:'Fixture transport failure',code:'P0001'}};
  return {data:structuredClone(f.battle)};
 }
 if(name==='lock_battle_prompt'){
  if(f.hold)await new Promise(resolve=>window.__release=resolve);
  if(f.mode==='reject-lock')return {error:{message:'Fixture lock rejected',code:'P0001'}};
  f.saved.phase='battle_review';f.saved.revision=42;f.saved.state.phase='battle_review';f.saved.state.presentationScreen='battle_review';
  f.battle.phase='battle_review';f.battle.revision=42;
  if(f.mode==='lost-lock')return {error:{message:'Fixture lost lock response',code:'P0001'}};
  return {data:{...structuredClone(f.battle),locked:true}};
 }
 if(name==='set_live_room_state'){ f.saved.phase=args.p_phase;f.saved.state=structuredClone(args.p_state);return {data:{revision:++f.saved.revision}}; }
 if(name==='get_live_leaderboard')return {data:structuredClone(f.saved.state.players)};if(name==='get_host_score_events')return {data:[]};
 return {data:[]};
 }} }`;
const server = http.createServer(async(req,res)=>{
 try {
  const pathname = new URL(req.url,'http://localhost').pathname;
  if(pathname==='/__fake-supabase.js'){res.setHeader('content-type','text/javascript');res.end(fakeModule);return}
  if(pathname==='/config.js'){res.setHeader('content-type','text/javascript');res.end(`window.QUIZ_PLATFORM_CONFIG={supabaseUrl:location.origin,supabasePublishableKey:'FAKE-PUBLISHABLE',workerOrigin:location.origin}`);return}
  if(pathname.startsWith('/host-')){res.setHeader('content-type','application/json');res.end(JSON.stringify({submissions:[],answers:[],guesses:[]}));return}
  const file = path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep))throw new Error('Invalid path');
  let body = await fs.readFile(file);
  if(pathname==='/app.js')body=body.toString()+hook;
  res.setHeader('content-type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':pathname.endsWith('.html')||pathname==='/'?'text/html':pathname.endsWith('.svg')?'image/svg+xml':'application/octet-stream');res.end(body);
 }catch(error){res.statusCode=404;res.end('Fixture file not found')}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
const results=[];
async function open(view='host',f=fixture(),existingContext=null) {
 const context = existingContext || await browser.newContext({viewport:{width:1440,height:1100}});
 await context.route('**/*',async route=>{
  const url=route.request().url();
  if(url.startsWith('https://esm.sh/@supabase/supabase-js'))return route.fulfill({contentType:'text/javascript',body:`export {createClient} from '${origin}/__fake-supabase.js'`});
  if(url.startsWith(origin+'/'))return route.continue();
  return route.abort('blockedbyclient');
 });
 await context.addInitScript(value=>{window.__fixture=value;localStorage.setItem('quiz-host-secret:ACPT','FIXTURE-AUTH');window.alert=message=>{window.__lastAlert=message}},f);
 const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install({time:new Date('2026-10-06T12:00:00Z')});
 await page.clock.pauseAt(new Date('2026-10-06T12:00:00Z'));
 await page.goto(origin+`/?view=${view}&room=ACPT`);
 await page.waitForFunction(()=>window.__acceptance&&window.__fixture.calls.some(c=>c.name==='get_host_live_room_state'));
 await settle(page);
 return {page,context,errors};
}
async function settle(page){await page.evaluate(async()=>{for(let i=0;i<12;i++)await Promise.resolve()});await page.waitForTimeout(30)}
async function run(id,label,fn){let env;try{env=await open();await fn(env);results.push({id,label,status:'passed'})}catch(error){results.push({id,label,status:error.code==='ERR_ASSERTION'?'assertion-failed':'harness-error',message:error.message,stack:error.stack})}finally{console.log(id+': '+results.at(-1).status);if(env){results.at(-1).pageErrors=env.errors;results.at(-1).rpcCalls=await env.page.evaluate(()=>window.__fixture.calls.map(c=>c.name)).catch(()=>[]);try{await env.page.screenshot({path:path.join(evidence,id+'.png'),fullPage:true})}catch{}await env.context.close()}}}
const body=page=>page.locator('body').innerText();
const progress=page=>page.evaluate(()=>window.__acceptance.projection().battleProgress);
function assertProgress(value,submitted,total){assert.deepEqual(value,{submitted,total},'server-confirmed paired progress')}
async function clickRefresh(page){const control=page.getByRole('button',{name:/refresh|retry/i}).first();assert.ok(await control.count(),'manual refresh/retry control exists');await control.click();await settle(page)}
async function lockControl(page){const control=page.getByRole('button',{name:/lock.*submission|lock.*prompt|close.*submission/i}).first();assert.ok(await control.count(),'submission lock button exists');return control}
// No projection injection: the second tab receives the host's real BroadcastChannel message.
await run('broadcast', 'Presentation receives confirmed counts and recovered lock', async ({page, context}) => {
 const presentation = await open('presenter', fixture(), context);
 await page.evaluate(() => { window.__fixture.battle.matchups[0].entrants[1].submitted = true; });
 await clickRefresh(page);
 await settle(presentation.page);
 assert.deepEqual(await presentation.page.evaluate(() => window.__acceptance.state.battleProgress), {submitted:2,total:3});
 assert.match(await body(presentation.page), /2 of 3 submissions in/);
 await page.evaluate(() => { window.__fixture.battle.phase='battle_review';window.__fixture.battle.revision=42; });
 await clickRefresh(page);
 await settle(presentation.page);
 assert.equal(await presentation.page.evaluate(() => window.__acceptance.state.phase), 'battle_review');
 assert.match(await body(presentation.page), /The judges are checking the entries/);
 assert.equal(await presentation.page.locator('.presentation-card img').count(), 0, 'locked judging card has no battle images');
 const remote = await page.evaluate(() => window.__fixture.broadcasts.filter(m=>m.event==='state').at(-1));
 assert.equal(remote.payload.state.phase,'battle_review');
 for (const secret of privateValues) assert.ok(!JSON.stringify(remote).includes(secret),'private roster must stay host-only');
 await presentation.page.screenshot({path:path.join(evidence,'broadcast-presentation.png'),fullPage:true});
 assert.deepEqual(presentation.errors,[]);
});
await run('focus', 'five-second polling preserves manual score inputs, selection and focus', async ({page}) => {
 const points = page.locator('[data-score-points]');
 const reason = page.locator('[data-score-reason]');
 const player = page.locator('[data-score-player]');
 await player.selectOption('spectator');
 await points.fill('12.5');
 await reason.fill('A typed draft');
 await reason.focus();
 await reason.evaluate(el => { window.__focusedBeforePoll=el;el.setSelectionRange(2,7); });
 const calls = await page.evaluate(() => window.__fixture.calls.filter(c=>c.name==='get_host_battle_state').length);
 await page.clock.runFor(5000);
 await settle(page);
 assert.ok(await page.evaluate(n=>window.__fixture.calls.filter(c=>c.name==='get_host_battle_state').length>n,calls),'poll actually ran');
 assert.equal(await points.inputValue(),'12.5');
 assert.equal(await reason.inputValue(),'A typed draft');
 assert.equal(await player.inputValue(),'spectator');
 assert.ok(await reason.evaluate(el=>el===window.__focusedBeforePoll && document.activeElement===el),'same focused DOM control survives');
 assert.deepEqual(await reason.evaluate(el=>[el.selectionStart,el.selectionEnd]),[2,7]);
 // Pending, failed and manual refreshes preserve the same controls too.
 await page.evaluate(() => { window.__fixture.mode='fail-refresh'; });
 await page.clock.runFor(5000);await settle(page);
 assert.equal(await reason.inputValue(),'A typed draft');
 assert.ok(await reason.evaluate(el=>document.activeElement===el));
 await page.evaluate(() => { window.__fixture.mode='normal'; });
 await clickRefresh(page);
 assert.equal(await reason.inputValue(),'A typed draft');
});
await run('contrast', 'battle Presentation supporting text remains readable', async ({page,context}) => {
 const presentation=await open('presenter',fixture(),context);
 const ratio=async()=>presentation.page.locator('.presentation-card > p').last().evaluate(el=>{
   const rgb=value=>value.match(/[0-9.]+/g).slice(0,3).map(Number);
   const luminance=values=>values.map(v=>{const n=v/255;return n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4;}).reduce((sum,n,i)=>sum+n*[0.2126,0.7152,0.0722][i],0);
   const text=luminance(rgb(getComputedStyle(el).color));
   const background=luminance(rgb(getComputedStyle(el.parentElement).backgroundColor));
   return (Math.max(text,background)+0.05)/(Math.min(text,background)+0.05);
 });
 const promptRatio=await ratio();
 assert.ok(promptRatio>=4.5,`prompt supporting text contrast ${promptRatio.toFixed(2)} must be at least 4.5:1`);
 await page.evaluate(()=>{window.__fixture.battle.phase='battle_review';window.__fixture.battle.revision=42;});
 await clickRefresh(page);await settle(presentation.page);
 const reviewRatio=await ratio();
 assert.ok(reviewRatio>=4.5,`review supporting text contrast ${reviewRatio.toFixed(2)} must be at least 4.5:1`);
 assert.equal(await presentation.page.locator('.presentation-card img').count(),0,'locked judging card has no battle images');
});
await browser.close();await new Promise(resolve=>server.close(resolve));
await fs.writeFile(path.join(evidence,'results.json'),JSON.stringify({results},null,2));
assert.ok(results.every(result=>result.status==='passed'),JSON.stringify(results.filter(result=>result.status!=='passed'),null,2));
console.log(`${results.length}/${results.length} browser regressions passed`);
