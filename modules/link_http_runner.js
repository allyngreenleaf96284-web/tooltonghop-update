import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { normalizeHttpAccounts, accountUid, parseCheckProxy, createHttpCheckClient, classifyHttpListing } from "./link_http_client.js";
import { createLinkCheckProgress } from "./link_check_light.js";

const defaultJournal = fileURLToPath(new URL("../data/link-http-pending.json",import.meta.url));
const retryStatus = (value) => /^(không rõ|khong ro|lỗi check|loi check)$/i.test(String(value).trim());
const cellKey = (item) => JSON.stringify([item.spreadsheetId,item.title,item.rowNumber]);
const column = (index) => {let out="",n=index+1;while(n){n--;out=String.fromCharCode(65+n%26)+out;n=Math.floor(n/26);}return out;};

export async function createHttpSheetWriter(plans, journalPath=defaultJournal) {
  let stored=[];
  try {stored=JSON.parse(await readFile(journalPath,"utf8"));if(!Array.isArray(stored))throw new Error();}
  catch(error){if(error.code!=="ENOENT")throw new Error("Khong doc duoc hang cho ghi Sheet HTTP; da giu nguyen file.");}
  const pending=new Map(stored.map(item=>[cellKey(item),item]));
  let tail=Promise.resolve(), flushTail=Promise.resolve();
  const locked=(action)=>{const work=tail.then(action);tail=work.catch(()=>{});return work;};
  const persist=async()=>{
    await mkdir(path.dirname(journalPath),{recursive:true});
    const temporary=`${journalPath}.${randomUUID()}.tmp`;
    await writeFile(temporary,JSON.stringify([...pending.values()]),"utf8");await rename(temporary,journalPath);
  };
  const flush=()=>{
    const work=flushTail.then(async()=>{
      const snapshot=await locked(async()=>[...pending.values()]);
      for(const plan of plans){
        const items=snapshot.filter(item=>item.spreadsheetId===plan.spreadsheetId&&item.title===plan.title);
        for(let offset=0;offset<items.length;offset+=50){
          const batch=items.slice(offset,offset+50);
          for(const item of batch) if(String(plan.values[item.rowNumber-1]?.[plan.linkIndex]||"").trim()!==item.link) throw new Error("Dong Sheet da doi link; can kiem tra hang cho HTTP truoc khi ghi lai.");
          await plan.client.batchUpdateValues(batch.map(item=>({range:`'${plan.title.replace(/'/g,"''")}'!${column(plan.nick1Index)}${item.rowNumber}`,values:[[item.status]]})));
          await locked(async()=>{
            for(const item of batch){if(pending.get(cellKey(item))?.version===item.version)pending.delete(cellKey(item));
              plan.values[item.rowNumber-1] ||= [];plan.values[item.rowNumber-1][plan.nick1Index]=item.status;}
            await persist();
          });
        }
      }
    });
    flushTail=work.catch(()=>{});return work;
  };
  return {
    flush,
    get pendingCount(){return [...pending.values()].filter(item=>plans.some(plan=>plan.spreadsheetId===item.spreadsheetId&&plan.title===item.title)).length;},
    async write(plan,task,status){await locked(async()=>{const item={spreadsheetId:plan.spreadsheetId,title:plan.title,rowNumber:task.rowNumber,link:task.link,status,version:randomUUID()};pending.set(cellKey(item),item);await persist();});}
  };
}

export async function runHttpLinkChecks(options) {
  const {runtime}=options;
  if(runtime.running)throw new Error("Dang co tool khac chay.");
  runtime.running=true;runtime.stopRequested=false;runtime.currentTool="check link order";
  try{return await startHttpLinkChecks(options);}
  catch(error){runtime.running=false;runtime.currentTool="";throw error;}
}

async function startHttpLinkChecks({config,readPlan,runtime,log,createClient=createHttpCheckClient,journalPath}) {
  const accounts=normalizeHttpAccounts(config.marketplaceHttpAccounts);
  if(!accounts.length)throw new Error("Them it nhat mot nick HTTP: cookie Facebook va proxy My.");
  const seen=new Set();
  const nicks=accounts.map((account,index)=>{
    let uid;try {uid=accountUid(account.cookie);parseCheckProxy(account.proxy);}catch(error){throw new Error(`Nick HTTP ${index+1}: ${error.message}`);}
    if(seen.has(uid))throw new Error(`Nick HTTP ${index+1} bi trung c_user.`);seen.add(uid);
    return {...account,uid,id:`http-${uid}`,label:`HTTP nick ${index+1}`};
  });
  const plans=[], sheets=new Set();
  for(const input of (config.marketplaceCheckSpreadsheetIds?.length?config.marketplaceCheckSpreadsheetIds:[config.marketplaceCheckSpreadsheetId])){
    const plan=await readPlan(config,input),key=JSON.stringify([plan.spreadsheetId,plan.title]);
    if(!sheets.has(key)){sheets.add(key);plans.push(plan);}
  }
  const writer=await createHttpSheetWriter(plans,journalPath);
  // Replay locally saved results before scheduling links again.
  await writer.flush();
  const tasks=[];
  for(const plan of plans){
    const owned=[];
    for(let i=1;i<plan.values.length;i++){
      const url=String(plan.values[i]?.[plan.linkIndex]||"").trim(),status=plan.values[i]?.[plan.nick1Index]||"";
      if(!url || (status&&!retryStatus(status)))continue;
      const task={rowNumber:i+1,link:url,plan};owned.push(task);tasks.push(task);
    }
    plan.sharedQueue={tasks:owned};
  }
  const progress=createLinkCheckProgress(runtime,nicks.length,retryStatus);
  progress.register(plans);progress.summary.mode="http";progress.summary.sheetPending=0;
  const perNick=Math.max(1,Math.min(10,Math.floor(Number(config.marketplaceHttpConcurrency)||2)));
  const controller=new AbortController();
  let cursor=0;
  for(const nick of nicks)runtime.jobs.set(nick.id,{profileId:nick.id,uid:nick.uid,tool:"check link order",status:"queued",liveStatus:`${nick.label}: cho kiem tra proxy/session`,logs:[],startedAt:new Date().toISOString(),result:null});
  setImmediate(async()=>{
    let flushing=false,nextFlushAt=0;
    const flush=async()=>{
      if(flushing||Date.now()<nextFlushAt)return;flushing=true;
      try{await writer.flush();progress.summary.sheetWriteError="";}catch{nextFlushAt=Date.now()+5000;progress.summary.sheetWriteError="Chua ghi duoc Sheet; ket qua duoc giu tren may de ghi lai.";}
      finally{progress.summary.sheetPending=writer.pendingCount;flushing=false;}
    };
    const timer=setInterval(()=>{if(runtime.stopRequested)controller.abort();void flush();},1000);
    try {
      if(runtime.stopRequested){for(const nick of nicks)runtime.jobs.get(nick.id).status="stopped";return;}
      if(!tasks.length){for(const nick of nicks){const job=runtime.jobs.get(nick.id);job.status="success";job.liveStatus="Khong con link can check.";}return;}
      await Promise.allSettled(nicks.map(async(nick)=>{
        const job=runtime.jobs.get(nick.id);let client,blocked=false,checked=0,unknown=0,lastReason="";
        try{
          client=createClient(nick);job.status="running";job.liveStatus=`${nick.label}: dang xac minh proxy My`;
          await client.verifyUs(controller.signal);
          // Verify the supplied session belongs to this account before sharing work.
          const session=await client.get("https://www.facebook.com/me?locale=en_US",{signal:controller.signal});
          if(session.status!==200)throw new Error(`Facebook tra HTTP ${session.status} khi kiem tra phien; chua xac nhan duoc dang nhap.`);
          if(/\/login|\/checkpoint|\/two_step_verification/.test(session.url))throw new Error("Cookie het han hoac can xac minh dang nhap.");
          const sessionEvidence=session.html.match(/"USER_ID"\s*:\s*"(\d+)"/)?.[1] || session.html.match(/"actorID"\s*:\s*"(\d+)"/)?.[1];
          if(sessionEvidence!==nick.uid)throw new Error("Chua xac nhan duoc phien dang nhap tu cookie; can kiem tra lai nick.");
          progress.summary.activeProfiles++;
          try{
            const workers=Array.from({length:perNick},async()=>{
              while(!runtime.stopRequested&&!blocked){
                const task=tasks[cursor++];if(!task)break;
                progress.summary.inFlight++;progress.summary.attempts++;
                job.liveStatus=`${nick.label}: dong ${task.rowNumber}, da check ${checked}`;
                try {
                  let result;
                  try{
                    const parsed=new URL(task.link),id=parsed.pathname.match(/^\/marketplace\/item\/(\d+)(?:\/|$)/)?.[1];
                    if(parsed.protocol!=="https:"||!["www.facebook.com","facebook.com","m.facebook.com"].includes(parsed.hostname)||!id)result={status:"không rõ",reason:"Link khong phai Marketplace item HTTPS."};
                    else{parsed.searchParams.set("locale","en_US");const response=await client.get(parsed.href,{signal:controller.signal,timeoutMs:Math.min(30000,Number(config.marketplaceCheckTimeoutMs)||20000)});result=classifyHttpListing(response,id);}
                  }catch{result={status:"không rõ",reason:"Loi HTTP/proxy; can check lai."};}
                  if(runtime.stopRequested)break;
                  if(result.blocked){tasks.push(task);blocked=true;job.liveStatus=`${nick.label}: ${result.reason}`;job.status="error";job.result={chiTiet:result.reason};return;}
                  await writer.write(task.plan,task,result.status);
                  progress.wrote(task.plan,task,result.status);progress.summary.sheetPending=writer.pendingCount;checked++;
                  if(retryStatus(result.status))unknown++;
                  if(result.reason)lastReason=result.reason;
                  job.liveStatus=`${nick.label}: da check ${checked}; ${result.status}${result.reason?` — ${result.reason}`:""}`;
                }finally{progress.summary.inFlight--;}
              }
            });
            const results=await Promise.allSettled(workers);
            const failed=results.find(result=>result.status==="rejected");
            if(failed)throw failed.reason;
          }finally{progress.summary.activeProfiles--;}
          if(!blocked){job.status=runtime.stopRequested?"stopped":"success";job.liveStatus=`${nick.label}: da check ${checked}, khong ro ${unknown}${lastReason?` — ${lastReason}`:""}`;job.result={checked,unknown,lastReason};}
          else job.liveStatus=`${nick.label}: ${job.result.chiTiet}`;
        }catch(error){job.status=runtime.stopRequested?"stopped":"error";job.liveStatus=`${nick.label}: ${error.message}`;log(nick.id,"HTTP check",job.liveStatus,"warn");}
        finally{try{client?.close();}catch{}job.finishedAt=new Date().toISOString();}
      }));
    }finally{
      clearInterval(timer);
      // A final flush is queued behind any timer flush, including on Stop.
      try{await writer.flush();progress.summary.sheetWriteError="";}catch{progress.summary.sheetWriteError="Con ket qua cho ghi Sheet; da luu tren may, lan chay sau se ghi lai.";}
      progress.summary.sheetPending=writer.pendingCount;controller.abort();progress.finish();runtime.running=false;runtime.currentTool="";
    }
  });
  return {started:nicks.length,profileIds:nicks.map(nick=>nick.id),sheets:plans.length,requestsPerNick:perNick,mode:"http",totalLinks:tasks.length};
}
