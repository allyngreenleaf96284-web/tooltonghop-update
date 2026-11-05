const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function waitShippingControl(page,kind,method='Delivery',{shouldStop=()=>false,retryMs=15000,pollMs=250}={}){
 let nextClick=0;
 for(;;){
  if(shouldStop()||page.isClosed()){const error=Error('Da dung cho Shipping/Delivery.');error.status='stopped';throw error;}
  const allowClick=Date.now()>=nextClick;
  const state=await page.evaluate(({kind,method,allowClick})=>{
   const clean=x=>String(x||'').replace(/\s+/g,' ').trim();
   const visible=node=>{const r=node?.getBoundingClientRect();return r&&r.width>0&&r.height>0&&getComputedStyle(node).visibility!=='hidden'&&getComputedStyle(node).display!=='none';};
   window.__toolShippingDialogActive=true;
   let dialog=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].find(node=>visible(node)&&/change (shipping|delivery) method|package weight/i.test(clean(node.innerText)));
   if(!dialog){
    const heading=[...document.querySelectorAll('h1,h2,h3,span,div')].filter(visible).find(n=>/^change (shipping|delivery) method$/i.test(clean(n.innerText)));
    for(let n=heading?.parentElement;n&&n!==document.body;n=n.parentElement){
     if(/package weight/i.test(clean(n.innerText))){dialog=n;break;}
    }
   }
   if(kind==='label'&&dialog)return 'ready';
   if(kind==='weight'){
    if(!dialog)return 'dialog-missing';
    const options=[...document.querySelectorAll('[role="option"],[role="radio"],input[name="package_weight_range"]')].some(node=>visible(node)&&/\blbs\b/i.test(clean(node.innerText||node.parentElement?.innerText))) || [...document.querySelectorAll('span,div,label')].some(node=>visible(node)&&/^(?:under\s+)?[\d.]+.*\blbs\b/i.test(clean(node.innerText))&&clean(node.innerText).length<65&&!node.querySelector('[role=combobox]')&&!/package weight/i.test(clean(node.innerText)));
    if(options)return 'ready';
   }
   if(!allowClick)return 'waiting';
   if(kind==='label'&&[...document.querySelectorAll('[role=dialog],[aria-modal=true]')].some(visible))return 'waiting';
   let target;
   if(kind==='label'){
    const exact=new RegExp(`^(select|change) ${method} label$`,'i');
    const label=[...document.querySelectorAll('button,[role="button"],span,div')].filter(visible).filter(node=>exact.test(clean(node.innerText||node.textContent))).sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length)[0];
    target=label?.closest('button,[role="button"]')||label;
   }else{
    target=[...dialog.querySelectorAll('[role="combobox"],button,[role="button"],label')].filter(visible).sort((a,b)=>Number(b.getAttribute('role')==='combobox')-Number(a.getAttribute('role')==='combobox')).find(node=>/package weight/i.test(clean(node.getAttribute('aria-label')||'')+' '+clean(node.innerText)+' '+clean(document.getElementById(node.getAttribute('aria-labelledby'))?.textContent)));
   }
   if(!target)return 'missing';
   target.scrollIntoView({block:'center',inline:'nearest'});
   // Recheck in the same page task before clicking so a late modal is never toggled.
   if(kind==='weight'&&target.getAttribute('aria-expanded')==='true')return 'waiting';
   const rect=target.getBoundingClientRect();
   const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
   if(!hit||(!target.contains(hit)&&!hit.contains(target)))return 'waiting';
   target.click();return 'clicked';
  },{kind,method,allowClick}).catch(()=> 'waiting');
  if(state==='ready')return;
  if(state==='dialog-missing')return false;
  if(state==='clicked')nextClick=Date.now()+retryMs;
  await sleep(pollMs);
 }
}
export async function closeWeightMenu(page,allowClick=true){
 return page.evaluate(allowClick=>{
  const visible=node=>{const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(node).display!=='none';};
  const field=[...document.querySelectorAll('[role="combobox"],button,[role="button"],label')].filter(visible).sort((a,b)=>Number(b.getAttribute('role')==='combobox')-Number(a.getAttribute('role')==='combobox')).find(node=>/package weight/i.test((node.innerText||'')+' '+(node.getAttribute('aria-label')||'')+' '+(document.getElementById(node.getAttribute('aria-labelledby'))?.textContent||'')));
  const options=[...document.querySelectorAll('[role="option"],[role="radio"],input[name="package_weight_range"]')].filter(visible).filter(node=>/lbs/i.test(node.innerText||node.parentElement?.innerText||''));
  const plainOptions=[...document.querySelectorAll('span,div,label')].some(n=>visible(n)&&/^(?:under\s+)?[\d.]+.*kg\s*\([^)]*lbs\)/i.test((n.innerText||'').trim())&&(n.innerText||'').length<65);
  if(!options.length&&!plainOptions&&field?.getAttribute('aria-expanded')!=='true')return true;
  if(field&&allowClick)field.click();return false;
 },allowClick);
}
