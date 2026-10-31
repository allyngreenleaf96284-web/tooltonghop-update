import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const defaultJournal = fileURLToPath(new URL("../data/link-hide-pending.json",import.meta.url));
const retryStatus = (value) => /^(không rõ|khong ro|lỗi check|loi check)$/i.test(String(value).trim());
const cellKey = (item) => JSON.stringify([item.spreadsheetId,item.title,item.rowNumber]);
const column = (index) => {let out="",n=index+1;while(n){n--;out=String.fromCharCode(65+n%26)+out;n=Math.floor(n/26);}return out;};

export async function createLinkSheetWriter(plans, journalPath=defaultJournal) {
  let stored=[];
  try {stored=JSON.parse(await readFile(journalPath,"utf8"));if(!Array.isArray(stored))throw new Error();}
  catch(error){if(error.code!=="ENOENT")throw new Error("Khong doc duoc hang cho ghi Sheet; da giu nguyen file.");}
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
          for(const item of batch) if(String(plan.values[item.rowNumber-1]?.[plan.linkIndex]||"").trim()!==item.link) throw new Error("Dong Sheet da doi link; can kiem tra hang cho truoc khi ghi lai.");
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
    async discardUnconfirmed(){await locked(async()=>{for(const [key,item] of pending)if(plans.some(plan=>plan.spreadsheetId===item.spreadsheetId&&plan.title===item.title)&&(retryStatus(item.status)||(/thâm buy now/i.test(item.status)&&item.verifiedBy!=="browser")))pending.delete(key);await persist();});},
    async write(plan,task,status,verifiedBy="http"){await locked(async()=>{const item={spreadsheetId:plan.spreadsheetId,title:plan.title,rowNumber:task.rowNumber,link:task.link,status,verifiedBy,version:randomUUID()};pending.set(cellKey(item),item);await persist();});}
  };
}
