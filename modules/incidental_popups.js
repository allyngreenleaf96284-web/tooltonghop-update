// Dismiss only incidental overlays. Workflow dialogs, forms and security steps stay open.
function popupSweep(start){
 if(!/(^|\.)facebook\.com$/i.test(location.hostname))return;
 if(start&&window.__toolPopupSweepInstalled)return;
 const sweep=()=>{
  const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden';};
  const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
  let closed=0;
  for(const dialog of [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible).reverse()){
   const text=clean(dialog.innerText||dialog.textContent);
   const meta=/your meta account is here/i.test(text);
   const workflow=/seller information setup|your information|select.*language|language and region|english.*us|condition|category|minimum price|return address|date of birth|shipping carrier|payout|choose.*state|county|name on account|package weight|shipping label|delivery label|shipping options|delivery method|choose a way to confirm|authentication app|enter.*code|two.factor|captcha|not a robot|invalid address|change location|select location|choose location|tax information|bank account|save.*draft|discard.*draft/i.test(text);
   if(!meta&&(workflow||dialog.querySelector('input,textarea,select,[contenteditable="true"],[role="combobox"],[role="listbox"]')))continue;
   const buttons=[...dialog.querySelectorAll('button,[role="button"]')].filter(visible);
   const close=buttons.find(button=>/^(close|dismiss|not now|maybe later|skip|đóng|bỏ qua|lúc khác|fermer|cerrar)$/i.test(clean(button.getAttribute('aria-label')||button.getAttribute('title')||button.innerText||button.textContent)));
   if(close){close.click();closed++;}
  }
  return closed;
 };
 if(start){window.__toolPopupSweepInstalled=true;window.setInterval(sweep,700);}
 return sweep();
}
const installed=new WeakSet();
export async function installIncidentalPopupGuard(page){
 if(!page?.evaluateOnNewDocument || !page?.evaluate)return;
 if(installed.has(page))return;installed.add(page);
 await page.evaluateOnNewDocument(popupSweep,true);
 await page.evaluate(popupSweep,true).catch(()=>{});
}
export async function dismissIncidentalPopups(page){return typeof page?.evaluate === "function" ? page.evaluate(popupSweep,false).catch(()=>0) : 0;}
const guardedManagers=new WeakSet();
export function guardManagerPopupActions(manager){
 if(!manager||guardedManagers.has(manager))return;guardedManagers.add(manager);
 for(const name of ['clickByText','clickFirstSelector','clickButtonByTextExact','clickButtonIfVisible']){
  const original=manager[name];if(typeof original!=='function')continue;
  manager[name]=async function(page,...args){
   await dismissIncidentalPopups(page);
   try{
    const result=await original.call(this,page,...args);
    if(result===false && await dismissIncidentalPopups(page))return original.call(this,page,...args);
    return result;
   }catch(error){
    if(/intercept|obscur|not clickable|another element|pointer/i.test(String(error.message)) && await dismissIncidentalPopups(page))return original.call(this,page,...args);
    throw error;
   }
  };
 }
}
