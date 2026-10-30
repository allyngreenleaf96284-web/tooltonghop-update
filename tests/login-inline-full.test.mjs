import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLamFull } from '../modules/lamfull.js';
import { tileBounds } from '../modules/tool_login.js';

test('six Login windows fit work area above a bottom or side taskbar',()=>{
  for(const area of [{left:0,top:0,width:1920,height:1040},{left:60,top:0,width:1860,height:1080},{left:-1920,top:40,width:1920,height:1040}]){
    const cells=Array.from({length:6},(_,i)=>tileBounds(i,6,area));
    assert.equal(new Set(cells.map(x=>`${x.left},${x.top}`)).size,6);
    for(const box of cells){assert.ok(box.left>=area.left && box.top>=area.top);assert.ok(box.left+box.width<=area.left+area.width);assert.ok(box.top+box.height<=area.top+area.height);}
    assert.equal(cells.reduce((s,x)=>s+x.width*x.height,0),area.width*area.height);
  }
});
test('Full borrows the 3v session without opening, login, location navigation or closing it',async()=>{
  const page={isClosed:()=>false},browser={};
  const writes=[],events=[];
  let name='3v-61500000000001-Nuevo, California';
  const manager={saveConfig(){},async getProfileById(){return {name,browserType:'chrome'};},async getProfileNameById(){return name;},
    async updateProfileName(id,next){name=next;},
    async connectBrowser(){throw Error('must not reopen');},async stopHideMyAccProfile(){throw Error('must not close borrowed session');},
    async detectInitialMarketplaceState(){return {kind:"progress",totalSteps:3};},
    async runFullFlowAttempt(p,b){await this.waitForMarketplaceReady(p);assert.equal(p,page);assert.equal(b,browser);events.push('full');return {ok:true,barStatus:'3v'};}};
  const runtime={jobs:new Map([['p1',{status:'running'}]])};
  const tool=createLamFull({getManager:()=>manager,getLocationManager:()=>({}),runtime,addRuntimeLog(){},
    dangNhap:{async ensureFacebookLogin(){throw Error('must not login again');}},
    stateProxy:{async ensureForProfile(){throw Error('must not change proxy');},release(){throw Error('must not release borrowed proxy');}},
    buildToolRow:()=>({uid:'61500000000001',raw:{}}),allocateSellerInfoRow:async()=>({raw:{SSN:'123456789'}}),updateSellerInfoUid:async()=>{}});
  await tool.runProfile('p1',{}, {}, {updateOne:async(id,value)=>writes.push(value),flushAll:async()=>{}},0,6,
    {existingSession:{page,browser,location:{initial:'Nuevo, California',current:'Nuevo, California'},configureManager(){events.push('layout');}}});
  assert.deepEqual(events,['layout','full']);
  assert.equal(runtime.jobs.get('p1').status,'success',JSON.stringify(runtime.jobs.get('p1').result));
  assert.ok(writes.some(x=>x.trangThai==='thành công'));
});
