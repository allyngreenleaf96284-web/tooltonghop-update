import { readFile, writeFile, rename, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const defaultJournal = fileURLToPath(new URL("../data/link-hide-pending.json",import.meta.url));
const retryStatus = (value) => /^(không rõ|khong ro|lỗi check|loi check)$/i.test(String(value).trim());
const cellKey = (item) => JSON.stringify([item.spreadsheetId,item.title,item.rowNumber,item.link]);
const column = (index) => {let out="",n=index+1;while(n){n--;out=String.fromCharCode(65+n%26)+out;n=Math.floor(n/26);}return out;};

export async function createLinkSheetWriter(plans, journalPath=defaultJournal) {
  let stored=[];
  try {stored=JSON.parse(await readFile(journalPath,"utf8"));if(!Array.isArray(stored))throw new Error();}
  catch(error){if(error.code!=="ENOENT")throw new Error("Khong doc duoc hang cho ghi Sheet; da giu nguyen file.");}
  const exportPath=journalPath.replace(/\.json$/i, "")+"-results.txt";
  const reviewPath=journalPath.replace(/\.json$/i, "")+"-review.txt";
  let reviewCount=0, confirmedCount=0, lastWrite="";
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
        for(let offset=0;offset<items.length;offset+=100){
          const batch=items.slice(offset,offset+100);
          // Read immediately before writing: row numbers from the check queue may be stale.
          const values=typeof plan.client.getValues === "function" ? await plan.client.getValues(plan.title) : plan.values;
          const rows=new Map();
          for(let index=1;index<values.length;index++){
            const link=String(values[index]?.[plan.linkIndex]||"").trim();
            if(link){if(!rows.has(link))rows.set(link,[]);rows.get(link).push(index+1);}
          }
          const ready=[], unresolved=[];
          for(const item of batch){
            const matches=rows.get(String(item.link).trim())||[];
            if(matches.length===1)ready.push({item,rowNumber:matches[0]});
            else unresolved.push({...item,reason:matches.length ? "Link trung nhieu dong; can xem tay" : "Link khong con trong Sheet",savedAt:new Date().toISOString()});
          }
          if(unresolved.length)await locked(async()=>{
            await mkdir(path.dirname(reviewPath),{recursive:true});
            await appendFile(reviewPath,unresolved.map(item=>JSON.stringify(item)).join("\n")+"\n","utf8");
            for(const item of unresolved)if(pending.get(cellKey(item))?.version===item.version)pending.delete(cellKey(item));
            await persist();reviewCount+=unresolved.length;
          });
          if(!ready.length)continue;
          await plan.client.batchUpdateValues(ready.map(({item,rowNumber})=>({range:`'${plan.title.replace(/'/g,"''")}'!${column(plan.nick1Index)}${rowNumber}`,values:[[item.status]]})));
          if(typeof plan.client.getValues === "function"){
            const verified=await plan.client.getValues(plan.title);
            for(const {item,rowNumber} of ready){
              if(String(verified[rowNumber-1]?.[plan.linkIndex]||"").trim()!==item.link || String(verified[rowNumber-1]?.[plan.nick1Index]||"").trim()!==item.status)
                throw new Error(`Google Sheet chua xac nhan dung ket qua tai ${plan.title}!${column(plan.nick1Index)}${rowNumber}; giu hang cho de ghi lai.`);
            }
          }
          confirmedCount+=ready.length;
          lastWrite=`${plan.spreadsheetId} / ${plan.title} / cot ${column(plan.nick1Index)} / ${new Date().toISOString()}`;
          await locked(async()=>{
            for(const {item,rowNumber} of ready){
              if(pending.get(cellKey(item))?.version===item.version)pending.delete(cellKey(item));
              // Update cached rows by link too; active workers still hold their original row numbers.
              for(const row of plan.values)if(String(row?.[plan.linkIndex]||"").trim()===item.link)row[plan.nick1Index]=item.status;
            }
            await persist();
          });
        }
      }
    });
    flushTail=work.catch(()=>{});return work;
  };
  return {
    flush,
    exportPath,
    reviewPath,
    get confirmedCount(){return confirmedCount;},
    get lastWrite(){return lastWrite;},
    get reviewCount(){return reviewCount;},
    get pendingCount(){return [...pending.values()].filter(item=>plans.some(plan=>plan.spreadsheetId===item.spreadsheetId&&plan.title===item.title)).length;},
    async discardUnconfirmed(){await locked(async()=>{for(const [key,item] of pending)if(plans.some(plan=>plan.spreadsheetId===item.spreadsheetId&&plan.title===item.title)&&(retryStatus(item.status)||(/thâm buy now/i.test(item.status)&&item.verifiedBy!=="browser")))pending.delete(key);await persist();});},
    async write(plan,task,status,verifiedBy="http"){await locked(async()=>{const item={spreadsheetId:plan.spreadsheetId,title:plan.title,rowNumber:task.rowNumber,link:task.link,status,verifiedBy,version:randomUUID()};pending.set(cellKey(item),item);await persist();await appendFile(exportPath,[new Date().toISOString(),item.spreadsheetId,item.title,item.rowNumber,item.link,item.status].map(value=>String(value).replace(/[\t\r\n]+/g," ")).join("\t")+"\n","utf8");});}
  };
}
