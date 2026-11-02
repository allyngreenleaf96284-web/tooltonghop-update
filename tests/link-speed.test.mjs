import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLinkCheckProgress} from '../modules/link_check_light.js';
test('speed counts only actual completions, measures aggregate wall time and bounds history',()=>{
 let time=0;const p=createLinkCheckProgress({},4,()=>false,()=>time);
 const plan={spreadsheetId:'s',title:'t',nick1Index:0,values:[['status'],['sold']],sharedQueue:{tasks:[{rowNumber:2}]}};
 p.register([plan]);assert.equal(p.summary.speed.processed,0);
 p.startTask();
 for(let i=0;i<100;i++){time+=100;p.wrote(plan,{rowNumber:i+2},'sold',{checkMs:400,saveMs:2});}
 assert.equal(p.summary.speed.first100Ms,10000);assert.equal(p.summary.speed.lastSaveMs,2);
 for(let i=0;i<100;i++){time+=200;p.wrote(plan,{rowNumber:i+2},'sold');}
 assert.equal(p.summary.speed.last100Ms,20000);assert.equal(p.summary.speed.average100Ms,15000);
 for(let i=0;i<1000;i++){time+=100;p.wrote(plan,{rowNumber:i+2},'sold');}
 assert.equal(p.summary.speed.recent.length,10);assert.equal(p.summary.speed.batches,12);
});
