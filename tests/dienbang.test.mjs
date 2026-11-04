import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stateFromProfileName,createDienBang} from '../modules/dienbang.js';
for(const [name,expected] of [['db1-2v-61575115240717-Los Angeles, California','California'],['2v-61575115240717-Kansas, Missouri','Missouri'],['full-West Virginia','West Virginia'],['Virginia-New York','New York'],['north carolina-tool','North Carolina'],['Californian-CA',''],['no state','']])test(name,()=>assert.equal(stateFromProfileName(name),expected));
test('writes only bang from current Sheet name and keeps unmatched rows intact',async()=>{
 const runtime={running:false,jobs:new Map()};const updates=[];let flushed=false;
 const session={rows:new Map([['a',{'tên profile hiện tại':'Kansas, Missouri',bang:'California'}],['b',{'tên profile hiện tại':'No matching state',bang:'Texas'}]]),pending:new Map(),updateOne:async(id,value)=>updates.push([id,value]),flushAll:async()=>{flushed=true;}};
 const tool=createDienBang({runtime,addRuntimeLog(){},createSheetRowSession:async()=>session});
 const result=await tool.runQueue(['a','b'],{});assert.deepEqual(updates,[['a',{bang:'Missouri'}]]);assert.equal(result.updated,1);assert.equal(result.skipped,1);assert.equal(flushed,true);assert.equal(runtime.running,false);
});
test('missing-only preserves existing bang and exposes live progress while writing',async()=>{
 const runtime={running:false,jobs:new Map()},updates=[];let release;const waiting=new Promise(resolve=>release=resolve);
 const session={rows:new Map([['a',{'tên profile hiện tại':'California',bang:'Texas'}],['b',{'tên profile hiện tại':'Kansas, Missouri',bang:''}],['c',{'tên profile hiện tại':'No state',bang:''}]]),pending:new Map(),updateOne:async(id,value)=>{updates.push([id,value]);await waiting;},flushAll:async()=>{}};
 const tool=createDienBang({runtime,addRuntimeLog(){},createSheetRowSession:async()=>session});
 const work=tool.runQueue(['a','b','c'],{},{onlyMissing:true});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(runtime.stateFillProgress.running,true);assert.equal(runtime.stateFillProgress.currentId,'b');assert.equal(runtime.stateFillProgress.skipped,1);
 release();await work;assert.deepEqual(updates,[['b',{bang:'Missouri'}]]);assert.equal(runtime.stateFillProgress.written,1);assert.equal(runtime.stateFillProgress.processed,3);assert.equal(runtime.stateFillProgress.skipped,2);assert.equal(runtime.stateFillProgress.running,false);
});
