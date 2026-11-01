import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLinkSheetWriter} from '../modules/link_check_writer.js';
test('1000 results use one request; TXT survives successful flush',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sheet-batch-'));
 try {
  const calls=[];const values=Array.from({length:1001},(_,i)=>['',`https://example.test/${i}`]);
  const plan={spreadsheetId:'fixture',title:'Links',linkIndex:1,nick1Index:2,values,client:{batchUpdateValues:async data=>calls.push(data)}};
  const writer=await createLinkSheetWriter([plan],path.join(dir,'pending.json'));
  for(let i=1;i<=1000;i++)await writer.write(plan,{rowNumber:i+1,link:values[i][1]},'sold','browser');
  assert.equal(calls.length,0);await writer.flush();assert.equal(calls.length,1);assert.equal(calls[0].length,1000);assert.equal(writer.pendingCount,0);
  const txt=await readFile(writer.exportPath,'utf8');assert.equal(txt.trim().split('\n').length,1000);assert.match(txt,/\tsold/);
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
