const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Only match the seller State/County field and actual popup options.
async function stateControl(page,action,value){
 return page.evaluate(({action,value})=>{
  const clean=x=>String(x||'').replace(/\s+/g,' ').trim().toLowerCase();
  const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden';};
  const field=[...document.querySelectorAll('[role="combobox"],[aria-haspopup="listbox"]')].find(el=>visible(el)&&/^(state|county\/|county region)/.test(clean(el.innerText||el.getAttribute('aria-label'))));
  if(!field)return {missing:true};
  const expanded=field.getAttribute('aria-expanded')==='true';
  const options=[...document.querySelectorAll('[role="option"], [role="listbox"] li, [role="menu"] [role="menuitem"]')].filter(visible);
  if(action==='open'){if(!expanded&&!options.length)field.click();return {};}
  const desired=clean(value),names=Object.fromEntries('AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming'.toLowerCase().split('|').map(x=>x.split(':')));
  const code=Object.keys(names).find(key=>key===desired||names[key]===desired)||desired;
  const match=text=>{text=clean(text);return text===desired||text===code||text===names[code]||text===`${names[code]} (${code})`||text===`${code} - ${names[code]}`;};
  if(action==='select'){
   const option=options.find(el=>match(el.innerText||el.textContent));
   if(option){option.scrollIntoView({block:'nearest'});option.click();return {selected:true};}
   return {};
  }
  const text=clean(field.innerText||field.getAttribute('aria-label'));
  const correct=text.split(/\s+/).includes(desired)||text.endsWith(desired)||Boolean(names[desired]&&text.includes(names[desired]));
  return {correct,open:expanded||options.length>0};
 },{action,value});
}
export function installSellerStateGuard(manager){
 const original=manager.selectStateDropdown;
 if(typeof original!=='function')return ()=>{};
 manager.selectStateDropdown=async function(page,value){
  if(!value)return;
  await stateControl(page,'open',value);
  let selected=false;const deadline=Date.now()+15000;
  while(Date.now()<deadline){
   const result=await stateControl(page,selected?'read':'select',value);
   if(result.selected)selected=true;
   if(selected){
    let state=await stateControl(page,'read',value);
    if(state.open){await page.keyboard.press('Escape');state=await stateControl(page,'read',value);}
    if(state.correct&&!state.open)return;
   }
   await sleep(200);
  }
  throw new Error(`Seller Info: chua chon va dong menu State/County = ${value}; dung truoc khi bam Next.`);
 };
 return ()=>{manager.selectStateDropdown=original;};
}
