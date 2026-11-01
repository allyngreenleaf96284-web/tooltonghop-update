import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLinkSheetWriter} from '../modules/link_check_writer.js';
test('100 results use one request; TXT survives successful flush',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sheet-batch-'));
 try {
  const calls=[];const values=Array.from({length:101},(_,i)=>['',`https://example.test/${i}`]);
  const plan={spreadsheetId:'fixture',title:'Links',linkIndex:1,nick1Index:2,values,client:{batchUpdateValues:async data=>calls.push(data)}};
  const writer=await createLinkSheetWriter([plan],path.join(dir,'pending.json'));
  for(let i=1;i<=100;i++)await writer.write(plan,{rowNumber:i+1,link:values[i][1]},'sold','browser');
  assert.equal(calls.length,0);await writer.flush();assert.equal(calls.length,1);assert.equal(calls[0].length,100);assert.equal(writer.pendingCount,0);
  const txt=await readFile(writer.exportPath,'utf8');assert.equal(txt.trim().split('\n').length,100);assert.match(txt,/\tsold/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('expired Sheet token refreshes once and retries same write',async()=>{
 const source=await readFile(new URL('../server.js',import.meta.url),'utf8');
 const start=source.indexOf('class SheetsClient {');const end=source.indexOf('\nasync function ',start);
 // Extract just the constructor and request methods via class slice before metadata.
 const code=source.slice(start,source.indexOf('  async metadata()',start))+'}';
 const tokens=[];let refreshes=0;
 const Client=new Function('fetch','getGoogleAccessToken',code+';return SheetsClient;')(async(url,options)=>{tokens.push(options.headers.authorization);return tokens.length===1?{ok:false,status:401,json:async()=>({error:{message:'expired'}})}:{ok:true,json:async()=>({ok:true})};},async()=>{refreshes++;return 'fresh';});
 const c=new Client({spreadsheetId:'fixture',credentialsPath:'fixture'},'expired');c.waitGlobalWriteSlot=async()=>{};
 assert.deepEqual(await c.request('/values:batchUpdate',{method:'POST'}),{ok:true});assert.equal(refreshes,1);assert.deepEqual(tokens,['Bearer expired','Bearer fresh']);
});
test('fresh Sheet rows relocate results; missing and duplicate links do not block valid writes',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sheet-relocate-'));
 try {
  const writes=[];const original=[['uid','link','status'],['a','link-a',''],['b','link-b',''],['c','link-c','']];
  const fresh=[original[0],['x','link-c',''],['y','link-c',''],['b','link-b',''],['a','link-a','']];
  const plan={spreadsheetId:'fixture',title:'Links',linkIndex:1,nick1Index:2,values:original,client:{getValues:async()=>fresh,batchUpdateValues:async data=>{writes.push(...data);for(const x of data){const r=Number(x.range.match(/C(\d+)$/)[1]);fresh[r-1][2]=x.values[0][0];}}}};
  const writer=await createLinkSheetWriter([plan],path.join(dir,'pending.json'));
  await writer.write(plan,{rowNumber:2,link:'link-a'},'sold');
  await writer.write(plan,{rowNumber:2,link:'deleted'},'pending');
  await writer.write(plan,{rowNumber:4,link:'link-c'},'sold');
  await writer.write(plan,{rowNumber:3,link:'link-b'},'pending');
  assert.equal(writer.pendingCount,4);
  await writer.flush();assert.equal(writer.pendingCount,0);assert.equal(writer.reviewCount,2);
  assert.deepEqual(writes.map(x=>x.range),["'Links'!C5","'Links'!C4"]);
  assert.equal((await readFile(writer.reviewPath,'utf8')).trim().split('\n').length,2);
  assert.equal(original[1][0],'a');assert.equal(original[1][2],'sold');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('unconfirmed writes stay pending and are not counted as written',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sheet-confirm-'));
 try{
  const plan={spreadsheetId:'fixture',title:'Links',linkIndex:1,nick1Index:2,values:[['uid','link','status'],['a','link-a','']],client:{getValues:async()=>plan.values,batchUpdateValues:async()=>({})}};
  const writer=await createLinkSheetWriter([plan],path.join(dir,'pending.json'));
  await writer.write(plan,{rowNumber:2,link:'link-a'},'sold');
  await assert.rejects(writer.flush(),/chua xac nhan/);assert.equal(writer.confirmedCount,0);assert.equal(writer.pendingCount,1);
  plan.client.batchUpdateValues=async()=>{plan.values[1][2]='sold';};
  await writer.flush();assert.equal(writer.confirmedCount,1);assert.equal(writer.pendingCount,0);assert.match(writer.lastWrite,/fixture \/ Links \/ cot C/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
