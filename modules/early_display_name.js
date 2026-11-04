import { normalizeBankAccountName } from './bank_account_name.js';
export async function checkThreeVDisplayName(page,state){
 if(typeof page?.evaluate!=='function')return '';
 if(state?.kind!=='progress'||Number(state.totalSteps)!==3)return '';
 const name=await page.evaluate(()=>{
  const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
  const labels=[...document.querySelectorAll('span,div,p')].filter(el=>/^Listing to Marketplace(?:\s*[·•]\s*Public)?$/i.test(clean(el.innerText||el.textContent)));
  const label=labels.sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length)[0];
  if(!label)return '';
  for(let parent=label.parentElement,depth=0;parent&&depth<5;parent=parent.parentElement,depth++){
   if(!parent.querySelector('img,[role="img"]'))continue;
   const texts=[];const walker=document.createTreeWalker(parent,NodeFilter.SHOW_TEXT);
   while(walker.nextNode()){const text=clean(walker.currentNode.textContent);if(text&&text.length<100&&!/^(Listing to Marketplace|Public|[·•])$/i.test(text)&&!text.includes('Listing to Marketplace'))texts.push(text);}
   if(texts.length===1)return texts[0];
  }
  return '';
 });
 if(name)normalizeBankAccountName(name);
 return name;
}
