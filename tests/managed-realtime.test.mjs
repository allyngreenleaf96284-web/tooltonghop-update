import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../server.js',import.meta.url),'utf8');
const extract=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
test('changing every folder retains the existing provider Spreadsheet',async()=>{
 const code=extract('async function resolveAccountSheetConfig','async function getHideState');
 const resolve=new Function('getHideAccount','normalizeSpreadsheetIds','configStore','clearManagedSheetCache','accountIdentityRecord','providerDisplayName',code+';return resolveAccountSheetConfig;')(
 async()=>({id:'hide:new-folder-hash',provider:'hide',email:'Hide (5 folder)',folderIds:['new']}),x=>x,{write:async x=>x},()=>{},x=>x,()=> 'Hide');
 const config={spreadsheetId:'hide-sheet',spreadsheetIds:['hide-sheet','gpm-sheet'],accountSheets:{'hide:old':'hide-sheet','gpm:old':'gpm-sheet'},knownHideAccounts:{}};
 const result=await resolve(config);assert.equal(result.spreadsheetId,'hide-sheet');assert.equal(result.accountSheets['hide:primary'],'hide-sheet');assert.equal(result.accountSheets['gpm:old'],'gpm-sheet');
});
test('duplicate requested tab titles only create one tab',async()=>{
 const code=extract('async function ensureSheets','async function readManagedTitles');const ensure=new Function(code+';return ensureSheets;')();let requests;
 await ensure({metadata:async()=>({sheets:[]}),batchUpdate:async x=>{requests=x;}},['done','done']);assert.equal(requests.length,1);
});
test('automatic credentials only fill missing data for matching UID',()=>{
 const code=extract('function missingCredentials','async function runBackgroundHideSheetSync');const fill=new Function('normalizeHeaderName',code+';return missingCredentials;')(x=>x==='mật khẩu'?'mat khau':x);
 const rows=new Map([['123',{password:'fixture-pass',twofa:'fixture-2fa',cookie:'fixture-cookie'}]]);
 assert.deepEqual(fill({uid:'123','mật khẩu':'existing'},rows),{});
 assert.deepEqual(fill({uid:'123','2fa':'keep'},rows),{'mật khẩu':'fixture-pass',cookie:'fixture-cookie'});
 assert.deepEqual(fill({uid:'999'},rows),{});
});
test('active batch sync patches names and missing credentials without rebuilding folder tabs',async()=>{
 const code=extract('async function runBackgroundHideSheetSync','function startBackgroundHideSheetSync');
 const state={folders:[{id:'f'}],profiles:[{id:'p',name:'new name',folderId:'f'}]};
 const tracker={};const updates=[];let flushed=false;
 const run=new Function('backgroundSyncState','resolveAccountSheetConfig','readConfig','getHideState','hashText','toolRuntime','syncSheets','createSheetRowSession','cachedCredentialSource','missingCredentials',code+';return runBackgroundHideSheetSync;')(
 tracker,async x=>x,async()=>({spreadsheetId:'s',credentialsPath:'fixture',credentialSourceSpreadsheetId:'source'}),async()=>state,x=>x,{running:true},async()=>{throw Error('must not rebuild active Sheet');},async()=>({rows:new Map([['p',{'tên profile hiện tại':'old'}]]),updateOne:async(id,update)=>updates.push(update),flushAll:async()=>{flushed=true;}}),async()=>({byUid:new Map()}),()=>({'mật khẩu':'fixture'}));
 await run();assert.equal(tracker.lastError,'');assert.equal(tracker.deferredStructure,true);assert.deepEqual(updates,[{'mật khẩu':'fixture','tên profile hiện tại':'new name'}]);assert.equal(flushed,true);assert.equal(tracker.isTicking,false);
});
