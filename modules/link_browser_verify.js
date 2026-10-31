import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseCheckProxy } from "./link_http_client.js";
import { installLightLinkCheck } from "./link_check_light.js";

function loadBrowserRuntime() {
  for(const base of [import.meta.url,new URL("../bundled-apps/Shipping-Full-Studio/app/package.json",import.meta.url),new URL("../bundled-apps/HMA-Studio-Portable-20260420/app/package.json",import.meta.url)]) {
    try{return createRequire(base)("puppeteer-core");}catch{}
  }
  throw new Error("Chua tim thay thu vien trinh duyet de xac minh; link duoc giu lai, chua ghi Sheet.");
}

async function launchBrowser() {
  const executablePath=[
    path.join(process.env.ProgramFiles||"C:/Program Files","Google/Chrome/Application/chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"]||"C:/Program Files (x86)","Google/Chrome/Application/chrome.exe"),
    path.join(process.env.LOCALAPPDATA||"", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"]||"C:/Program Files (x86)","Microsoft/Edge/Application/msedge.exe")
  ].find(existsSync);
  if(!executablePath)throw new Error("Can Chrome/Edge de xac minh link chua ro; chua ghi ket qua vao Sheet.");
  return loadBrowserRuntime().launch({executablePath,headless:true,args:["--proxy-server=http://per-context"]});
}

export function createLinkBrowserVerifier({readStatus,launch=launchBrowser,settleMs=2000,grayMinMs=15000,grayStableMs=5000,timeoutMs=35000}={}) {
  let browserPromise,active=0,closed=false;
  const contexts=new Map(),queue=[];
  const pump=()=>{
    while(active<2&&queue.length){
      const task=queue.shift();
      if(closed||task.options.signal?.aborted){task.reject(new Error("Da dung xac minh."));continue;}
      active++;
      inspect(task.nick,task.link,task.options).then(task.resolve,task.reject).finally(()=>{active--;pump();});
    }
  };
  async function inspect(nick,link,{signal,verifyIp,onProxyInfo=()=>{}}) {
    let target;try{target=new URL(link);}catch{return {reason:"Link Marketplace khong hop le; chua ghi Sheet."};}
    if(target.protocol!=="https:"||!["www.facebook.com","facebook.com","m.facebook.com"].includes(target.hostname)||(target.port&&target.port!=="443")||!/^\/marketplace\/item\/\d+(?:\/|$)/.test(target.pathname))return {reason:"Link Marketplace khong hop le; chua ghi Sheet."};
    if(typeof readStatus!=="function")throw new Error("Chua co bo doc trang xac minh.");
    if(!browserPromise)browserPromise=launch();
    const browser=await browserPromise;
    if(signal?.aborted)throw new Error("Da dung xac minh.");
    let contextPromise=contexts.get(nick.id);
    if(!contextPromise){
      contextPromise=(async()=>{
        const proxy=parseCheckProxy(nick.proxy);
        if(typeof browser.createBrowserContext!=="function")throw new Error("Thu vien Chromium qua cu; can cap nhat de gan proxy rieng cho moi nick.");
        const context=await browser.createBrowserContext({proxyServer:`${proxy.protocol}//${proxy.hostname}:${proxy.port || (proxy.protocol==="https:"?443:80)}`});
        return {context,proxy,verified:null};
      })();contexts.set(nick.id,contextPromise);
    }
    const state=await contextPromise;
    const page=await state.context.newPage();
    const abort=()=>{void page.close().catch(()=>{});};
    signal?.addEventListener("abort",abort,{once:true});
    try{
      if(signal?.aborted)throw new Error("Da dung xac minh.");
      if(state.proxy.username)await page.authenticate({username:decodeURIComponent(state.proxy.username),password:decodeURIComponent(state.proxy.password)});
      await page.setViewport({width:1360,height:900});
      await page.setCookie(...nick.cookie.split(";").filter(value=>value.includes("=")).map(value=>{const i=value.indexOf("=");return {name:value.slice(0,i).trim(),value:value.slice(i+1).trim(),domain:".facebook.com",path:"/",secure:true};}));
      await installLightLinkCheck(page);
      if(!state.verified){
        await page.goto("https://api64.ipify.org?format=json",{waitUntil:"domcontentloaded",timeout:20000});
        const raw=await page.evaluate(()=>document.querySelector("pre")?.textContent||document.body?.innerText||"");
        const ip=JSON.parse(raw).ip;
        if(typeof verifyIp!=="function")throw new Error("Chua xac minh duoc IP My cua trinh duyet.");
        state.verified=await verifyIp(ip,signal);
      }
      onProxyInfo(state.verified);
      const response=await page.goto(link,{waitUntil:"domcontentloaded",timeout:30000});
      if(response&&response.status()!==200)return {reason:`Facebook tra HTTP ${response.status()} trong trinh duyet; link van cho xac minh.`};
      const start=Date.now();let last="",stableSince=start;
      while(Date.now()-start<timeoutMs){
        if(signal?.aborted)throw new Error("Da dung xac minh.");
        const state=await page.evaluate(()=>({url:location.href,challenge:!!document.querySelector('iframe[src*="recaptcha"],.g-recaptcha'),busy:!!document.querySelector('[role="progressbar"]')}));
        if(/\/login|\/checkpoint|\/two_step_verification|\/marketplace\/ineligible/.test(state.url)||state.challenge)return {blocked:true,reason:"Trinh duyet can dang nhap/xac minh hoac nick khong vao duoc cho."};
        const current=await readStatus(page);
        if(current!==last){last=current;stableSince=Date.now();}
        const gray=/thâm buy now/i.test(current);
        // Feed/recommendation spinners can run forever. Gate on a stable
        // listing action result, not unrelated progress bars elsewhere.
        if(current&&current!=="không rõ"&&Date.now()-stableSince>=(gray?grayStableMs:settleMs)&&(!gray||Date.now()-start>=grayMinMs))return {status:current,verifiedBy:"browser"};
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      return {reason:"Trang chua on dinh/du du lieu sau xac minh; link van cho xu ly."};
    }finally{signal?.removeEventListener("abort",abort);await page.close().catch(()=>{});}
  }
  return {
    verify(nick,link,options){return new Promise((resolve,reject)=>{queue.push({nick,link,options,resolve,reject});pump();});},
    async close(){closed=true;pump();if(browserPromise){const browser=await browserPromise.catch(()=>null);await browser?.close().catch(()=>{});}}
  };
}
