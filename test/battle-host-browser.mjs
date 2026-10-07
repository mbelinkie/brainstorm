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
  const battle = {roundIndex:1,phase:'battle_prompt',revision:41,opened:true,sessionSpendUsd:1.25,maxSessionSpendUsd:9.5,matchups:[{matchupId:'m1',matchupIndex:0,promptText:privateValues[2],viableEntryIds:[privateValues[3]],skipped:false,entrants}]};
  const state = {phase:'battle_prompt',presentationScreen:'battle_prompt',questionId:'q1',question:{...question,round:2,roundTitle:'Fixture Battle'},battleRoundIndex:1,battleMatchupIndex:0,battleMatchupCount:1,players:[{id:'spectator',name:'Late Spectator',points:0}],presenterOverride:'Preserved credit',submitted:{}};
  return { definition:clone(definition), battle, saved:{phase:'battle_prompt',revision:41,roundIndex:1,questionIndex:0,state}, calls:[],broadcasts:[],scoreAwards:0,mode:'normal',hold:false,failNextReviewRefresh:false };
}
const hook = `\nwindow.__acceptance = {
 get state(){return structuredClone(state)}, get panel(){return structuredClone(battleRoundPanel)}, startVoting:()=>startBattleVoting(), reveal:()=>revealBattleMatchup(), next:()=>nextBattleMatchup(),
 projection:()=>publicRoomState(), payload:()=>hostStatePayload(),
 seed:(value,privatePayload)=>{state={...state,...value}; if(privatePayload) battleRoundPanel={...battleRoundPanel,state:privatePayload}; render()},
 refresh:()=>refreshBattlePairing(), render:()=>render(),
};\n`;
const fakeModule = `export function createClient(){return {
 channel(){const c={on(){return c},subscribe(fn){fn('SUBSCRIBED');return c},send(message){window.__fixture.broadcasts.push(structuredClone(message));return Promise.resolve()},unsubscribe(){}};return c},
 async rpc(name,args){const f=window.__fixture;f.calls.push({name,args:structuredClone(args)});window.__persistFixture?.();
 if(name==='get_host_quiz_definition')return {data:structuredClone(f.definition)};
 if(name==='get_host_live_room_state')return {data:structuredClone(f.saved)};
 if(name==='get_host_battle_state'){
  if(f.hold)await new Promise(resolve=>window.__release=resolve);
  if(f.failNextReviewRefresh){f.failNextReviewRefresh=false;window.__persistFixture?.();return {error:{message:'Fixture review refresh failure',code:'P0001'}};}
  if(f.mode==='fail-refresh')return {error:{message:'Fixture transport failure',code:'P0001'}};
  return {data:structuredClone(f.battle)};
 }
 if(name==='lock_battle_prompt'){
  if(f.hold)await new Promise(resolve=>window.__release=resolve);
  if(f.mode==='reject-lock')return {error:{message:'Fixture lock rejected',code:'P0001'}};
  f.saved.phase='battle_review';f.saved.revision=42;f.saved.state.phase='battle_review';f.saved.state.presentationScreen='battle_review';
  f.battle.phase='battle_review';f.battle.revision=42;
  f.battle.matchups.forEach(m=>{m.entrants.forEach(e=>e.viable=Boolean(e.submittedAssetId&&!e.vetoed&&!e.forfeited));m.viableEntryIds=m.entrants.filter(e=>e.viable).map(e=>e.entryId);m.skipped=!m.entrants.some(e=>!e.vetoed&&!e.forfeited)});
  window.__persistFixture?.();
  if(f.mode==='lost-lock')return {error:{message:'Fixture lost lock response',code:'P0001'}};
  return {data:{...structuredClone(f.battle),locked:true}};
 }
 if(name==='veto_battle_entry'){
  const matchup=f.battle.matchups.find(m=>m.entrants.some(e=>e.entryId===args.p_entry_id));
  const entry=matchup?.entrants.find(e=>e.entryId===args.p_entry_id);
  if(!entry)return {error:{message:'Entry not found',code:'P0001'}};
  entry.vetoed=Boolean(args.p_veto);entry.vetoReason=args.p_veto?args.p_reason:null;
  entry.viable=Boolean(entry.submittedAssetId&&!entry.vetoed&&!entry.forfeited);
  matchup.viableEntryIds=matchup.entrants.filter(e=>e.submittedAssetId&&!e.vetoed&&!e.forfeited).map(e=>e.entryId);
  matchup.skipped=!matchup.entrants.some(e=>!e.vetoed&&!e.forfeited);
  f.battle.revision++;f.saved.revision=f.battle.revision;
  if(f.mode==='fail-review-refresh')f.failNextReviewRefresh=true;
  window.__persistFixture?.();
  return {data:structuredClone(f.battle)};
 }
 if(name==='resolve_battle_matchup'){
  const matchup=f.battle.matchups.find(m=>m.matchupId===args.p_matchup_id);
  if(!matchup)return {error:{message:'Matchup not found',code:'P0001'}};
  if(matchup.storedResult)return {data:{...structuredClone(matchup.storedResult),revision:f.saved.revision,phase:'battle_result',created:false}};
  const viable=matchup.entrants.filter(e=>e.viable&&e.submittedAssetId);
  const entries=matchup.entrants.filter(e=>e.submittedAssetId).map((e,index)=>({entryId:e.entryId,playerId:e.playerId,playerName:e.playerName,logoKey:e.logoKey||null,assetId:e.submittedAssetId,votes:e.votes||0,viable:Boolean(e.viable),vetoed:Boolean(e.vetoed),forfeited:Boolean(e.forfeited),winner:viable[0]?.entryId===e.entryId,points:viable[0]?.entryId===e.entryId?5:0}));
  matchup.resolvedAt=new Date().toISOString();matchup.votesCast=Number(matchup.votesCast)||0;
  matchup.storedResult={matchupId:matchup.matchupId,roundIndex:1,matchupIndex:matchup.matchupIndex,promptText:matchup.promptText,resolvedAt:matchup.resolvedAt,outcome:viable.length===0?'skipped':viable.length===1?'default':'winner',winnerPoints:5,voterPoints:1,votesCast:matchup.votesCast,voterCount:matchup.votesCast,entries};
  f.scoreAwards+=viable.length?1:0;f.saved.phase='battle_result';f.saved.state.phase='battle_result';f.battle.phase='battle_result';f.saved.revision++;f.battle.revision=f.saved.revision;
  window.__persistFixture?.();
  return {data:{...structuredClone(matchup.storedResult),revision:f.saved.revision,phase:'battle_result',created:true}};
 }
 if(name==='set_live_room_state'){ f.saved.phase=args.p_phase;f.saved.state=structuredClone(args.p_public_state);f.saved.revision++;f.battle.phase=args.p_phase;f.battle.revision=f.saved.revision;window.__persistFixture?.();return {data:{revision:f.saved.revision}}; }
 if(name==='get_live_leaderboard')return {data:structuredClone(f.saved.state.players)};if(name==='get_host_score_events')return {data:[]};
 return {data:[]};
 }} }`;
const mediaRequests=[];
const server = http.createServer(async(req,res)=>{
 try {
  const pathname = new URL(req.url,'http://localhost').pathname;
  if(pathname==='/__media-requests'){res.setHeader('content-type','application/json');res.end(JSON.stringify(mediaRequests));return}
  if(pathname.startsWith('/media/')){mediaRequests.push({assetId:decodeURIComponent(pathname.slice('/media/'.length)),room:req.headers['x-quiz-room'],hostSecret:req.headers['x-quiz-host-secret'],playerToken:req.headers['x-quiz-player-token']});res.setHeader('content-type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><rect width="16" height="12" fill="#503f8b"/></svg>');return}
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
 await context.addInitScript(value=>{const key='quiz-fixture-state';window.__fixture=JSON.parse(sessionStorage.getItem(key)||'null')||value;window.__persistFixture=()=>sessionStorage.setItem(key,JSON.stringify(window.__fixture));window.__persistFixture();localStorage.setItem('quiz-host-secret:ACPT','FIXTURE-AUTH');window.alert=message=>{window.__lastAlert=message}},f);
 const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install({time:new Date('2026-10-06T12:00:00Z')});
 await page.clock.pauseAt(new Date('2026-10-06T12:00:00Z'));
 await page.goto(origin+`/?view=${view}&room=ACPT`);
 await page.waitForFunction(()=>window.__acceptance&&window.__fixture.calls.some(c=>c.name==='get_host_live_room_state'));
 await settle(page);
 return {page,context,errors};
}
async function settle(page){await page.evaluate(async()=>{for(let i=0;i<12;i++)await Promise.resolve()});await page.waitForTimeout(30)}
async function run(id,label,fn,configure=()=>{}){let env;try{const f=fixture();configure(f);env=await open('host',f);await fn(env);results.push({id,label,status:'passed'})}catch(error){results.push({id,label,status:error.code==='ERR_ASSERTION'?'assertion-failed':'harness-error',message:error.message,stack:error.stack})}finally{console.log(id+': '+results.at(-1).status);if(env){results.at(-1).pageErrors=env.errors;results.at(-1).rpcCalls=await env.page.evaluate(()=>window.__fixture.calls.map(c=>c.name)).catch(()=>[]);try{await env.page.screenshot({path:path.join(evidence,id+'.png'),fullPage:true})}catch{}await env.context.close()}}}
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
await run('host-review', 'host review shows every entry, veto and undo survive reload, and voting selects the first viable matchup', async ({page,context,errors}) => {
 const presentation=await open('presenter',fixture(),context);
 await (await lockControl(page)).click();
 await page.waitForFunction(()=>window.__acceptance.state.phase==='battle_review');
 await settle(page);
 assert.equal(await page.locator('.battle-review-entry').count(),4,'all submitted entries across both matchups are in the review grid');
 assert.match(await body(page),/PRIVATE-CREATOR-ALPHA/);
 assert.match(await body(page),/PRIVATE-PROMPT-TEXT/);
 assert.match(await body(page),/Second Creator/);
 await page.screenshot({path:path.join(evidence,'host-review-grid.png'),fullPage:true});
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-battle-review-image]')].every(image=>image.src.startsWith('blob:')));
 assert.equal(await page.locator('.battle-review-image img').count(),4);
 await settle(presentation.page);
 assert.equal(await presentation.page.locator('.battle-review').count(),0,'Presentation never renders the host review grid');
 const publicPayload=await page.evaluate(()=>window.__fixture.broadcasts.filter(message=>message.event==='state').at(-1));
 for(const secret of privateValues)assert.ok(!JSON.stringify(publicPayload).includes(secret),'review entries and assets stay out of public state');
 assert.doesNotMatch(await body(presentation.page),/PRIVATE-CREATOR-ALPHA|PRIVATE-PROMPT-TEXT|PRIVATE-ASSET-ID/);
 const media=await page.evaluate(()=>fetch('/__media-requests').then(response=>response.json()));
 assert.ok(media.length>=4,'the host fetched every submitted image');
 assert.ok(media.every(request=>request.hostSecret&&request.room==='ACPT'&&!request.playerToken),'private image requests use the host secret');
 assert.ok(media.some(request=>request.assetId==='PRIVATE-ASSET-ID'));

 await page.evaluate(async()=>{
  for(const matchup of window.__fixture.battle.matchups){matchup.viableEntryIds=[];matchup.skipped=true}
  await window.__acceptance.refresh();
 });
 await settle(page);
 assert.equal(await page.getByRole('button',{name:'Start voting'}).isDisabled(),true,'voting stays disabled when every matchup is skipped');
 await page.evaluate(async()=>{
  const first=window.__fixture.battle.matchups[0], second=window.__fixture.battle.matchups[1];
  first.viableEntryIds=['e1'];first.skipped=false;second.viableEntryIds=['e4'];second.skipped=false;
  window.__persistFixture();await window.__acceptance.refresh();
 });
 await settle(page);

 page.once('dialog',dialog=>dialog.accept('Fixture veto reason'));
 await page.getByRole('button',{name:'Veto entry'}).first().click();
 await settle(page);
 assert.match(await page.locator('[data-battle-matchup-index="0"]').innerText(),/Skipped — no viable entries/);
 assert.equal(await page.getByRole('button',{name:'Undo veto'}).count(),1);
 assert.equal(await page.getByRole('button',{name:'Start voting'}).isDisabled(),false,'the next matchup remains viable');
 const vetoCall=await page.evaluate(()=>window.__fixture.calls.filter(call=>call.name==='veto_battle_entry').at(-1));
 assert.equal(vetoCall.args.p_entry_id,'e1');assert.equal(vetoCall.args.p_reason,'Fixture veto reason');assert.equal(vetoCall.args.p_veto,true);

 const beforeReload=await page.evaluate(()=>window.__fixture.calls.filter(call=>call.name==='get_host_battle_state').length);
 await page.reload();
 await page.waitForFunction(count=>window.__fixture.calls.filter(call=>call.name==='get_host_battle_state').length>count,beforeReload);
 await settle(page);
 assert.equal(await page.evaluate(()=>window.__acceptance.state.phase),'battle_review');
 assert.equal(await page.getByRole('button',{name:'Undo veto'}).count(),1,'veto and reason recover from the saved server state');
 assert.match(await page.locator('.battle-review-veto-reason').innerText(),/Fixture veto reason/);

 await page.getByRole('button',{name:'Undo veto'}).click();
 await settle(page);
 assert.equal(await page.getByRole('button',{name:'Veto entry'}).count(),4,'undo re-enables entries across both matchups');
 page.once('dialog',dialog=>dialog.accept('Fixture veto reason'));
 await page.getByRole('button',{name:'Veto entry'}).first().click();
 await settle(page);
 await page.getByRole('button',{name:'Undo veto'}).click();
 await settle(page);
 await page.getByRole('button',{name:'Start voting'}).click();
 await page.waitForFunction(()=>window.__acceptance.state.phase==='battle_vote');
 assert.equal(await page.evaluate(()=>window.__acceptance.state.battleMatchupIndex),0,'voting starts at the first matchup with a viable entry');
 assert.match(await body(page),/Voting is open/);
 const roomStateReads=await page.evaluate(()=>window.__fixture.calls.filter(call=>call.name==='get_host_live_room_state').length);
 await page.reload();
 await page.waitForFunction(count=>window.__fixture.calls.filter(call=>call.name==='get_host_live_room_state').length>count,roomStateReads);
 await settle(page);
 assert.equal(await page.evaluate(()=>window.__acceptance.state.phase),'battle_vote','the voting phase survives host refresh');
 assert.match(await body(page),/voting open/i);
 assert.deepEqual(errors,[]);
},f=>{
 const first=f.battle.matchups[0];
 first.entrants=[first.entrants[0]];
 first.viableEntryIds=['e1'];
 const secondEntries=[
  {entryId:'e4',playerId:'p4',playerName:'Second Creator',submitted:true,submittedAssetId:'ASSET-SECOND',viable:true,generations:[{attemptIndex:1,status:'complete',assetIds:['ASSET-SECOND'],playerPrompt:'Second entry prompt'}]},
  {entryId:'e5',playerId:'p5',playerName:'Third Creator',submitted:true,submittedAssetId:'ASSET-THIRD',viable:true,generations:[{attemptIndex:1,status:'complete',assetIds:['ASSET-THIRD'],playerPrompt:'Third entry prompt'}]},
  {entryId:'e6',playerId:'p6',playerName:'Fourth Creator',submitted:true,submittedAssetId:'ASSET-FOURTH',viable:true,generations:[{attemptIndex:1,status:'complete',assetIds:['ASSET-FOURTH'],playerPrompt:'Fourth entry prompt'}]}
 ];
 f.battle.matchups.push({matchupId:'m2',matchupIndex:1,promptText:'Second matchup prompt',viableEntryIds:['e4','e5','e6'],skipped:false,entrants:secondEntries});
 f.saved.state.battleMatchupCount=2;
});
await run('host-vote-result', 'two matchups, including a three-way, recover their pointer and reveal each result once', async ({page,errors}) => {
 await page.waitForFunction(()=>window.__acceptance.panel.state?.matchups?.length===2);
 await page.getByRole('button',{name:'Start voting'}).click();
 await page.waitForFunction(()=>window.__acceptance.state.phase==='battle_vote');
 assert.equal(await page.evaluate(()=>window.__acceptance.state.battleMatchupIndex),0);
 assert.equal(await page.evaluate(()=>window.__acceptance.state.battleVote.entries.length),2,'the first matchup is a two-way ballot');

 const reads=await page.evaluate(()=>window.__fixture.calls.filter(c=>c.name==='get_host_live_room_state').length);
 await page.reload();
 await page.waitForFunction(count=>window.__fixture.calls.filter(c=>c.name==='get_host_live_room_state').length>count,reads);
 await settle(page);
 assert.equal(await page.evaluate(()=>window.__acceptance.state.phase),'battle_vote');
 assert.equal(await page.evaluate(()=>window.__acceptance.state.battleMatchupIndex),0,'the current matchup pointer survives refresh');
 assert.equal(await page.evaluate(()=>window.__acceptance.state.battleVote.entries.length),2,'the anonymous ballot is rebuilt after refresh');

 await page.evaluate(async()=>{
  const current=window.__fixture.battle.matchups[0];current.votesCast=1;current.eligibleVoters=3;current.entrants[0].votes=1;
  window.__persistFixture();await window.__acceptance.refresh();
 });
 await settle(page);
 assert.match(await page.locator('[data-battle-vote-progress]').innerText(),/1 of 3 votes received/,'host progress refreshes from the private server counts');

 await page.evaluate(()=>{document.querySelector('[data-battle-reveal]').click();document.querySelector('[data-battle-reveal]').click();});
 await page.waitForFunction(()=>window.__acceptance.state.phase==='battle_result');
 assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(c=>c.name==='resolve_battle_matchup').length),1,'double Reveal issues only one resolver request');
 assert.equal(await page.evaluate(()=>window.__fixture.scoreAwards),1,'the first matchup awards once');
 assert.match(await body(page),/PRIVATE-CREATOR-ALPHA/);
 await page.screenshot({path:path.join(evidence,'host-vote-result-first.png'),fullPage:true});

 const resultReads=await page.evaluate(()=>window.__fixture.calls.filter(c=>c.name==='get_host_live_room_state').length);
 await page.reload();
 await page.waitForFunction(count=>window.__fixture.calls.filter(c=>c.name==='get_host_live_room_state').length>count,resultReads);
 await settle(page);
 assert.equal(await page.evaluate(()=>window.__acceptance.state.phase),'battle_result','result phase and revealed outcome survive refresh');
 assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(c=>c.name==='resolve_battle_matchup').length),1,'reloading a stored result does not resolve or score twice');
 const recovered=await page.evaluate(()=>({phase:window.__acceptance.state.phase,index:window.__acceptance.state.battleMatchupIndex,stale:window.__acceptance.panel.stale,matchups:window.__acceptance.panel.state?.matchups?.map(m=>({index:m.matchupIndex,viable:m.viableEntryIds,resolvedAt:m.resolvedAt}))}));
 assert.equal(await page.getByRole('button',{name:'Next matchup'}).count(),1,`the next viable matchup is available after reload: ${JSON.stringify(recovered)}`);
 await page.getByRole('button',{name:'Next matchup'}).click();
 await page.waitForFunction(()=>window.__acceptance.state.phase==='battle_vote'&&window.__acceptance.state.battleMatchupIndex===1);
 assert.equal(await page.evaluate(()=>window.__acceptance.state.battleVote.entries.length),3,'the next matchup presents all three viable entries');
 const publicVote=await page.evaluate(()=>JSON.stringify(window.__acceptance.projection()));
 assert.doesNotMatch(publicVote,/Second Creator|Third Creator|Fourth Creator/,'creator details stay out of the public ballot');
 await page.evaluate(async()=>{
  const current=window.__fixture.battle.matchups[1];current.votesCast=2;current.eligibleVoters=3;current.entrants[0].votes=2;
  window.__persistFixture();await window.__acceptance.refresh();
 });
 await settle(page);
 assert.match(await page.locator('[data-battle-vote-progress]').innerText(),/2 of 3 votes received/);
 await page.evaluate(()=>{document.querySelector('[data-battle-reveal]').click();document.querySelector('[data-battle-reveal]').click();});
 await page.waitForFunction(()=>window.__acceptance.state.phase==='battle_result'&&window.__acceptance.state.battleResult.matchupIndex===1);
 assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(c=>c.name==='resolve_battle_matchup').length),2);
 assert.equal(await page.evaluate(()=>window.__fixture.scoreAwards),2,'three-way result awards once too');
 assert.equal(await page.evaluate(()=>window.__acceptance.state.battleResult.entries.length),3);
 await page.getByRole('button',{name:'Finish battle round'}).click();
 await page.waitForFunction(()=>window.__acceptance.state.phase==='complete');
 assert.deepEqual(await page.evaluate(()=>({round:window.__acceptance.state.battleRoundIndex,index:window.__acceptance.state.battleMatchupIndex,count:window.__acceptance.state.battleMatchupCount,vote:window.__acceptance.state.battleVote,result:window.__acceptance.state.battleResult})),{round:null,index:null,count:null,vote:null,result:null},'finish clears matchup state before the finale');
 assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(evidence,'host-vote-result-finale.png'),fullPage:true});
},f=>{
 const submitted=(entryId,playerId,playerName,assetId)=>({entryId,playerId,playerName,submitted:true,submittedAssetId:assetId,viable:true,votes:0,generations:[{attemptIndex:1,status:'complete',assetIds:[assetId],playerPrompt:`${playerName} prompt`}]});
 const first={matchupId:'m1',matchupIndex:0,promptText:'First matchup prompt',viableEntryIds:['e1','e2'],skipped:false,votesCast:0,eligibleVoters:3,entrants:[submitted('e1','p1','PRIVATE-CREATOR-ALPHA','ASSET-ONE'),submitted('e2','p2','Second Creator','ASSET-TWO')]};
 const second={matchupId:'m2',matchupIndex:1,promptText:'Three-way matchup prompt',viableEntryIds:['e4','e5','e6'],skipped:false,votesCast:0,eligibleVoters:3,entrants:[submitted('e4','p4','Second Creator','ASSET-FOUR'),submitted('e5','p5','Third Creator','ASSET-FIVE'),submitted('e6','p6','Fourth Creator','ASSET-SIX')]};
 f.battle={...f.battle,phase:'battle_review',revision:42,matchups:[first,second]};
 f.saved.phase='battle_review';f.saved.revision=42;f.saved.state.phase='battle_review';f.saved.state.presentationScreen='battle_review';f.saved.state.battleMatchupCount=2;f.saved.state.battleMatchupIndex=0;f.saved.state.battleVote=null;f.saved.state.battleResult=null;
});
await run('stale-review', 'voting stays blocked after a veto cannot be confirmed and recovers only from a fresh viable roster', async ({page}) => {
 await (await lockControl(page)).click();
 await page.waitForFunction(()=>window.__acceptance.state.phase==='battle_review');
 await settle(page);
 assert.equal(await page.getByRole('button',{name:'Start voting'}).isDisabled(),false,'a confirmed viable matchup enables voting');

 await page.evaluate(()=>{window.__fixture.mode='fail-review-refresh';});
 page.once('dialog',dialog=>dialog.accept('Remove the final viable entry'));
 await page.getByRole('button',{name:'Veto entry'}).click();
 await settle(page);
 const stale=await page.evaluate(()=>({panel:window.__acceptance.panel,serverViable:window.__fixture.battle.matchups[0].viableEntryIds}));
 assert.equal(stale.panel.stale,true,'failed authoritative refresh marks the retained panel stale');
 assert.deepEqual(stale.panel.state.matchups[0].viableEntryIds,['e1'],'the last confirmed roster remains visible');
 assert.deepEqual(stale.serverViable,[],'the successful veto removed the final viable entry on the server');
 assert.equal(await page.getByRole('button',{name:'Start voting'}).isDisabled(),true,'patched start button is disabled while the roster is stale');
 assert.match(await body(page),/Fixture review refresh failure/);
 assert.match(await body(page),/last confirmed roster/i);

 await page.evaluate(()=>window.__acceptance.render());
 assert.equal(await page.getByRole('button',{name:'Start voting'}).isDisabled(),true,'full render also disables voting while stale');
 const writesBefore=await page.evaluate(()=>window.__fixture.calls.filter(call=>call.name==='set_live_room_state').length);
 await page.evaluate(()=>window.__acceptance.startVoting());
 await settle(page);
 assert.equal(await page.evaluate(()=>window.__acceptance.state.phase),'battle_review','the stale-state action guard keeps review open');
 assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.name==='set_live_room_state').length),writesBefore,'the rejected stale action writes no voting state');
 assert.match(await body(page),/stale\. Refresh the roster before starting voting/i,'the action guard explains how to recover');

 await page.evaluate(()=>{window.__fixture.mode='normal';});
 await page.getByRole('button',{name:/retry/i}).click();
 await settle(page);
 assert.equal(await page.evaluate(()=>window.__acceptance.panel.stale),false,'a successful authoritative refresh clears stale state');
 assert.equal(await page.getByRole('button',{name:'Start voting'}).isDisabled(),true,'a fresh roster with no viable matchups still cannot start voting');
 assert.match(await page.locator('[data-battle-matchup-index="0"]').innerText(),/Skipped — no viable entries/);

 await page.getByRole('button',{name:'Undo veto'}).click();
 await settle(page);
 assert.equal(await page.getByRole('button',{name:'Start voting'}).isDisabled(),false,'voting becomes available only after fresh state confirms a viable entry');
 assert.equal(await page.evaluate(()=>window.__acceptance.panel.stale),false);
 assert.deepEqual(await page.evaluate(()=>window.__acceptance.panel.state.matchups[0].viableEntryIds),['e1']);
 page.once('dialog',dialog=>dialog.accept('Skip the only viable matchup'));
 await page.getByRole('button',{name:'Veto entry'}).click();
 await settle(page);
 assert.equal(await page.getByRole('button',{name:'Start voting'}).isDisabled(),true,'all-skipped review still blocks voting');
 assert.equal(await page.getByRole('button',{name:'Finish battle round'}).isDisabled(),false,'a fresh all-skipped review can finish without resolving a matchup');
 await page.getByRole('button',{name:'Finish battle round'}).click();
 await page.waitForFunction(()=>window.__acceptance.state.phase==='complete');
 assert.deepEqual(await page.evaluate(()=>[window.__acceptance.state.battleRoundIndex,window.__acceptance.state.battleMatchupIndex,window.__acceptance.state.battleMatchupCount]),[null,null,null],'the all-skipped finish clears the battle position');
},f=>{
 f.battle.matchups[0].entrants=[f.battle.matchups[0].entrants[0]];
 f.battle.matchups[0].viableEntryIds=['e1'];
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
