import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { ensureLoginEnglish } from '../modules/login_language.js';
import { normalizeBankAccountName, installBankAccountNameGuard } from '../modules/bank_account_name.js';
import { createLamFull, buildRuntimeProfileName } from '../modules/lamfull.js';
import { isRetryableFailure } from '../modules/batch_retry.js';
const require = createRequire(import.meta.url);
let browser;
before(async () => { browser = await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true}); });
after(async () => { await browser?.close(); });

test('already English settings loaded after 6 seconds is accepted without clicking or reloading', async () => {
  const page = await browser.newPage();
  try {
    let nav = 0;
    assert.equal(await ensureLoginEnglish(page, {navigate: async () => {
      nav++; await page.setContent('<html lang="en-US"><body>Loading...</body></html>');
      await page.evaluate(() => setTimeout(() => { document.body.innerHTML='<h1>Language and region</h1><button>Account language</button>'; },6000));
    }}),true);
    assert.equal(nav,1);
  } finally { await page.close(); }
});

for (const zoom of [25,50,100]) test(`delayed picker and confirmation save verified at ${zoom}%`, async () => {
  const page = await browser.newPage();
  try {
    await page.setViewport({width:616,height:406});
    assert.equal(await ensureLoginEnglish(page, {navigate:async () => {
      await page.setContent(`<html lang="vi"><style>html{zoom:${zoom/100}}button{display:block;margin:10px}</style><body><button id="row">Ngôn ngữ của tài khoản: Tiếng Việt</button></body></html>`);
      await page.evaluate(() => {
        document.getElementById('row').onclick = () => setTimeout(() => {
          const dialog=document.createElement('div'); dialog.setAttribute('role','dialog');
          dialog.innerHTML='<input type="search"><button id="option">English (US)</button>';
          document.body.append(dialog);
          dialog.querySelector('#option').onclick=()=>setTimeout(()=>{
            dialog.innerHTML='<p>Refresh to apply language</p><button id="ok">OK</button>';
            dialog.querySelector('#ok').onclick=()=>{ dialog.querySelector('#ok').disabled=true; setTimeout(()=>{dialog.remove();document.getElementById('row').innerText='Account language: English (US)';},650); };
          },650);
        },900);
      });
    }}), true);
    assert.match(await page.$eval('#row',el=>el.innerText),/English \(US\)/);
  } finally { await page.close(); }
});

test('a picker requiring Save changes is saved before accepting English', async () => {
  const page = await browser.newPage();
  try {
    assert.equal(await ensureLoginEnglish(page,{navigate:async()=>{
      await page.setContent('<html lang="vi"><body><button id="row">Account language: Tiếng Việt</button></body></html>');
      await page.evaluate(()=>{
        document.getElementById('row').onclick=()=>{
          const dialog=document.createElement('div');dialog.setAttribute('role','dialog');
          dialog.innerHTML='<input type="search"><button id="en">English (US)</button><button id="save" disabled>Save changes</button>';
          document.body.append(dialog);
          dialog.querySelector('#en').onclick=()=>{dialog.querySelector('#save').disabled=false;};
          dialog.querySelector('#save').onclick=()=>{dialog.remove();document.getElementById('row').innerText='Account language: English (US)';};
        };
      });
    }}),true);
  } finally {await page.close();}
});

test('an English option alone does not count as saved and stop signals propagate', async () => {
  const page = await browser.newPage();
  try {
    assert.equal(await ensureLoginEnglish(page,{timeoutMs:700,controlWaitMs:400,navigate:()=>page.setContent('<div role="dialog"><button>English (US)</button></div>')}),false);
    const stopped=Object.assign(new Error('manual pause'),{code:'LOGIN_PAUSED'});
    await assert.rejects(ensureLoginEnglish(page,{navigate:async()=>{},check:async()=>{throw stopped;}}),error=>error===stopped);
  } finally { await page.close(); }
});

test('Latin accents removed, non-Latin and mixed-script names rejected without guessing', () => {
  assert.equal(normalizeBankAccountName('ngô minh vũ'),'ngo minh vu');
  assert.equal(normalizeBankAccountName('ĐẶNG José D’Ávila'),'DANG Jose D’Avila');
  assert.equal(normalizeBankAccountName('Łukasz'),'Łukasz');
  for (const name of ['สมชาย ใจดี','王 小明','Иван Smith','Minh あ']) assert.throws(()=>normalizeBankAccountName(name),error=>error.status==='cdt' && error.retryable===false);
  const name='2v-61594297498819-Los Angeles, California';
  assert.equal(buildRuntimeProfileName({status:'cdt',tenChuan:'cdt-cdt-'+name}),'cdt-'+name);
  assert.equal(isRetryableFailure({status:'error',result:{trangThai:'cdt'}}),false);
});

test('account-name guard preserves all other bank processing and restores original method',async()=>{
  const calls=[], original=async(...args)=>{calls.push(args);return true;};
  const manager={setFieldValueByExactLabel:original};
  const restore=installBankAccountNameGuard(manager);
  await manager.setFieldValueByExactLabel(null,'Name on account','Ngô Vũ');
  await manager.setFieldValueByExactLabel(null,'Bank account number','000123');
  assert.throws(()=>manager.setFieldValueByExactLabel(null,'Name on account','王'),error=>error.status==='cdt');
  assert.equal(calls[0][2],'Ngo Vu'); assert.equal(calls[1][2],'000123');
  restore(); assert.equal(manager.setFieldValueByExactLabel,original);
});

test('Full stops at non-Latin name, writes cdt once, releases seller allocation, and never submits bank',async()=>{
  const initial='2v-61594297498819-Los Angeles, California';
  let name=initial, attempts=0, submitted=false;
  const writes=[], allocations=[];
  const original=async()=>{submitted=true;};
  const manager={saveConfig(){},async getProfileById(){return {name,browserType:'chrome'};},async getProfileNameById(){return name;},
    async updateProfileName(id,next){name=next;},setFieldValueByExactLabel:original,
    async detectInitialMarketplaceState(){return {kind:'progress',totalSteps:3};},
    async runFullFlowAttempt(page){attempts++;await this.waitForMarketplaceReady(page);await this.setFieldValueByExactLabel(page,'Name on account','王 小明');return {ok:true};}};
  const runtime={jobs:new Map([['p1',{}]])};
  const tool=createLamFull({getManager:()=>manager,getLocationManager:()=>({}),runtime,addRuntimeLog(){},
    buildToolRow:()=>({uid:'61594297498819',raw:{}}),allocateSellerInfoRow:async()=>({raw:{}}),updateSellerInfoUid:async(c,a,value)=>allocations.push(value)});
  const result=await tool.runProfile('p1',{}, {},{updateOne:async(id,value)=>writes.push(value),flushAll:async()=>{}},0,1,
    {existingSession:{page:{isClosed:()=>false},browser:{},location:{initial:'Los Angeles, California',current:'Los Angeles, California'},configureManager(){}}});
  assert.equal(attempts,1);assert.equal(submitted,false);assert.equal(name,'cdt-'+initial);
  assert.equal(result.trangThai,'cdt');assert.ok(allocations.includes(''));
  assert.equal(manager.setFieldValueByExactLabel,original);
  assert.ok(writes.some(x=>x.tenChuan==='cdt-'+initial));
});
