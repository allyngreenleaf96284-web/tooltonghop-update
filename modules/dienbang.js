const states='Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming'.split('|');
const canonical=new Map(states.map(name=>[name.toLowerCase(),name]));
const pattern=new RegExp('(?<![A-Za-z])('+[...states].sort((a,b)=>b.length-a.length).join('|')+')(?![A-Za-z])','gi');
export function stateFromProfileName(name){let result='';for(const match of String(name||'').matchAll(pattern))result=canonical.get(match[1].toLowerCase());return result;}
export function createDienBang({runtime,createSheetRowSession,addRuntimeLog}){
 return {async runQueue(profileIds,config,options={}){
  const ids=[...new Set(profileIds.map(String))];if(runtime.running)throw Error('Dang co tool khac chay.');
  runtime.running=true;runtime.currentTool='dien bang';runtime.stopRequested=false;runtime.jobs.clear();
  let updated=0,skipped=0;
  const progress=runtime.stateFillProgress={total:ids.length,processed:0,updated:0,skipped:0,errors:0,written:0,running:true,currentId:"",onlyMissing:options.onlyMissing===true};
  try{
   const session=await createSheetRowSession(config,ids);
   for(const id of ids)runtime.jobs.set(id,{profileId:id,tool:'dien bang',status:'queued',liveStatus:'dang cho',logs:[]});
   for(const id of ids){
    if(runtime.stopRequested)break;
    const job=runtime.jobs.get(id);job.status='running';progress.currentId=id;const row=session.rows.get(id);
    const existing=row&&Object.entries(row).find(([key])=>key.trim().toLowerCase()==='bang')?.[1];
    const name=row&&Object.entries(row).find(([key])=>key.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')==='ten profile hien tai')?.[1];
    const bang=stateFromProfileName(name);
    if(!row){job.status='error';job.liveStatus='Không tìm thấy dòng Sheet';progress.errors++;}
    else if(options.onlyMissing && String(existing||'').trim()){job.status='done';job.liveStatus='Đã có bang, bỏ qua';skipped++;}
    else if(!bang){job.status='done';job.liveStatus='Khong thay ten bang My; giu gia tri hien tai';skipped++;}
    else {await session.updateOne(id,{bang});updated++;job.status='success';job.liveStatus=`Da dien bang: ${bang}`;}
    progress.processed++;progress.updated=updated;progress.skipped=skipped;
    addRuntimeLog(`[${id}] ${job.liveStatus}`,'info',id,{tool:'dien bang',step:'dien bang'});
    if(session.pending.size>=50){await session.flush();progress.written=updated;}
   }
   await session.flushAll();progress.written=updated;return {started:ids.length,updated,skipped};
  }finally{progress.running=false;progress.currentId="";for(const job of runtime.jobs.values())if(['queued','running'].includes(job.status)){job.status=runtime.stopRequested?'stopped':'error';}runtime.running=false;runtime.currentTool='';runtime.stopRequested=false;}
 }};
}
