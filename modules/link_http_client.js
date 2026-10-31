import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { isIP } from "node:net";
import { createGunzip, createBrotliDecompress, createInflate } from "node:zlib";

export function normalizeHttpAccounts(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    cookie: String(item?.cookie || "").trim(), proxy: String(item?.proxy || "").trim()
  })).filter((item) => item.cookie || item.proxy);
}

export function parseCheckProxy(value) {
  let source = String(value || "").trim();
  if (!source || /[\r\n]/.test(source)) throw new Error("Proxy khong hop le.");
  if (!source.includes("://")) {
    const parts = source.split(":");
    if (parts.length === 4) source = `http://${encodeURIComponent(parts[2])}:${encodeURIComponent(parts[3])}@${parts[0]}:${parts[1]}`;
    else source = `http://${source}`;
  }
  let proxy;
  try { proxy = new URL(source); } catch { throw new Error("Proxy khong hop le."); }
  if (!["http:", "https:"].includes(proxy.protocol) || !proxy.hostname || proxy.pathname !== "/" || proxy.search || proxy.hash) {
    throw new Error("Dung proxy HTTP/HTTPS: host:port hoac host:port:user:pass.");
  }
  return proxy;
}

export function accountUid(cookie) {
  if (/[\r\n]/.test(cookie)) throw new Error("Cookie khong hop le.");
  const uid = cookie.match(/(?:^|;)\s*c_user=(\d+)\s*(?:;|$)/)?.[1];
  if (!uid || !/(?:^|;)\s*xs=[^;\s]+/.test(cookie)) throw new Error("Cookie can co c_user va xs.");
  return uid;
}

function connectionError(stage, code = "", status = 0) {
  const safeCode = /^[A-Z0-9_]+$/.test(String(code)) ? String(code) : "";
  const hint = status === 407 ? " — proxy tu choi tai khoan/mat khau" : status === 502 ? " — proxy khong ket noi duoc may chu dich" : "";
  const error = new Error(`${stage}${status ? `: HTTP ${status}` : safeCode ? `: ${safeCode}` : ""}${hint}.`);
  error.proxyDiagnostic = true;
  if (safeCode) error.code = safeCode;
  return error;
}

class TunnelAgent extends https.Agent {
  constructor(proxy) { super({ keepAlive: true, maxSockets: 20, maxFreeSockets: 4 }); this.proxy = proxy; this.opening = new Set(); }
  destroy() { for(const connection of this.opening) connection.destroy(); this.opening.clear(); super.destroy(); }
  createConnection(options, callback) {
    const proxy = this.proxy;
    const transport = proxy.protocol === "https:" ? https : http;
    const headers = {};
    if (proxy.username) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    const request = transport.request({ hostname: proxy.hostname.replace(/^\[|\]$/g,""), port: proxy.port, method: "CONNECT",
      path: `${options.host}:${options.port || 443}`, headers, agent: false });
    this.opening.add(request);
    let done = false, socket;
    const finish = (error, secure) => {
      if (done) return;
      done = true; clearTimeout(timer);
      this.opening.delete(request);this.opening.delete(socket);
      if (error) { request.destroy(); socket?.destroy(); }
      callback(error, secure);
    };
    const timer = setTimeout(() => finish(connectionError(`Proxy CONNECT -> ${options.host}`, "ETIMEDOUT")), 15000);
    request.on("connect", (response, connected, head) => {
      socket = connected;
      this.opening.add(connected);
      if (response.statusCode !== 200) return finish(connectionError(`Proxy CONNECT -> ${options.host}`, "", response.statusCode));
      if (head.length) connected.unshift(head);
      const secure = tls.connect({ socket: connected, servername: options.servername || options.host, rejectUnauthorized: true });
      socket = secure;
      this.opening.delete(connected);this.opening.add(secure);
      secure.once("secureConnect", () => finish(null, secure));
      secure.once("error", (error) => finish(connectionError(`TLS -> ${options.host}`, error.code)));
    });
    request.once("error", (error) => finish(connectionError("Ket noi toi cong proxy", error.code)));
    request.end();
    return undefined;
  }
}

export function createHttpCheckClient({ cookie, proxy }, { lookupCountry } = {}) {
  const agent = new TunnelAgent(parseCheckProxy(proxy));
  const cookies = new Map(cookie.split(";").map((part) => { const i = part.indexOf("="); return [part.slice(0,i).trim(), part.slice(i+1).trim()]; }).filter(([key]) => key));
  async function get(rawUrl, { timeoutMs = 20000, signal, facebook = true, throughProxy = true } = {}, redirects = 0) {
    const url = new URL(rawUrl);
    const allowed = facebook ? ["www.facebook.com", "facebook.com", "m.facebook.com"] : ["ipinfo.io", "api64.ipify.org"];
    if (url.protocol !== "https:" || !allowed.includes(url.hostname) || (url.port && url.port !== "443")) throw new Error("URL check khong duoc ho tro.");
    if (facebook && !throughProxy) throw new Error("Facebook bat buoc di qua proxy.");
    return new Promise((resolve, reject) => {
      // Identify this transport as an HTTP client. Claiming Chrome with an
      // incomplete browser request caused Facebook HTTP 400 on valid sessions.
      const headers = { "Accept": facebook ? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" : "application/json", "Accept-Encoding": "gzip, br", "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "ToolTongHop-LinkCheck/1.0" };
      if (facebook && cookies.size) headers.Cookie = [...cookies].map(([key,value]) => `${key}=${value}`).join("; ");
      const request = https.get(url, { agent: throughProxy ? agent : undefined, headers, signal }, (response) => {
        if (facebook) for (const line of response.headers["set-cookie"] || []) {
          const pair = line.split(";")[0], i = pair.indexOf("=");
          if (i > 0) cookies.set(pair.slice(0,i), pair.slice(i+1));
        }
        if ([301,302,303,307,308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          if (redirects >= 4) return reject(new Error("Qua nhieu lan chuyen trang."));
          return get(new URL(response.headers.location,url).href,{timeoutMs,signal,facebook,throughProxy},redirects+1).then(resolve,reject);
        }
        const encoding=response.headers["content-encoding"];
        const body=encoding==="gzip"?createGunzip():encoding==="br"?createBrotliDecompress():encoding==="deflate"?createInflate():response;
        if(body!==response)response.pipe(body);
        const chunks = []; let size = 0;
        body.on("data", (chunk) => { size += chunk.length; if (size > 12*1024*1024) {body.destroy();request.destroy(new Error("Phan hoi qua lon."));} else chunks.push(chunk); });
        body.on("end", () => resolve({ html: Buffer.concat(chunks).toString("utf8"), status: response.statusCode, url: url.href }));
        body.on("error",()=>{request.destroy();reject(new Error("Khong doc duoc noi dung HTTP."));});
        response.on("error", () => reject(new Error("Phan hoi bi ngat.")));
      });
      const timer = setTimeout(() => request.destroy(connectionError(`HTTPS -> ${url.hostname}`, "ETIMEDOUT")),timeoutMs);
      request.once("close",()=>clearTimeout(timer));
      request.once("error",(error)=>reject(error.proxyDiagnostic ? error : error.name === "AbortError" ? new Error("Da dung check HTTP.") : connectionError(`HTTPS -> ${url.hostname}${throughProxy ? " qua proxy" : " (tra quoc gia IP)"}`,error.code)));
    });
  }
  return {
    get,
    async verifyUs(signal) {
      // IPv6-only exits cannot reach IPv4-only geo providers. Obtain the exit
      // through a dual-stack endpoint first. Geography lookup sends only that
      // public IP, directly; it never receives Facebook cookies or proxy auth.
      const response = await get("https://api64.ipify.org?format=json", {facebook:false,signal,timeoutMs:15000});
      let ip;try{ip=JSON.parse(response.html).ip;}catch{}
      if(response.status!==200||!isIP(ip || ""))throw new Error("Khong lay duoc IP dau ra IPv4/IPv6 cua proxy.");
      let info;
      if(lookupCountry) info=await lookupCountry(ip,signal);
      else {
        const country=await get(`https://ipinfo.io/${encodeURIComponent(ip)}/json`,{facebook:false,throughProxy:false,signal,timeoutMs:15000});
        if(country.status!==200)throw new Error(`Tra quoc gia IP dau ra: HTTP ${country.status}; chua xac minh duoc proxy My.`);
        try {info=JSON.parse(country.html);}catch{throw new Error("Khong doc duoc quoc gia IP dau ra.");}
      }
      if (info?.country !== "US") throw new Error("Proxy chua duoc xac nhan la IP My (US).");
      return true;
    },
    close() { agent.destroy(); }
  };
}

const decode = (value) => String(value).replace(/&#(?:x([0-9a-f]+)|(\d+));/gi,(original,hex,num)=>{const code=parseInt(hex||num,hex?16:10);return code<=0x10ffff?String.fromCodePoint(code):original;}).replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ');

// Positive evidence only, scoped to the requested listing. An unrelated Sold
// recommendation or a word in the product description must not decide status.
export function classifyHttpListing({html, status, url}, listingId) {
  if (/\/login(?:[/.?]|$)|\/checkpoint\/|\/two_step_verification\//i.test(url) || [401,403,429].includes(status)) return {blocked:true,reason:"Phien can dang nhap/xac minh hoac bi gioi han."};
  if (/"USER_ID"\s*:\s*"0"/.test(html) || /<form\b[^>]*(?:id=["']login_form["']|action=["'][^"']*\/login)/i.test(html) || /<iframe\b[^>]*src=["'][^"']*\/recaptcha\//i.test(html)) return {blocked:true,reason:"Trang dang nhap hoac xac minh da xuat hien; can xu ly nick."};
  if (status !== 200) return {status:"không rõ",reason:`HTTP ${status}; can kiem tra bang trinh duyet.`};
  if (/\/marketplace\/ineligible\//.test(url)) return {blocked:true,reason:"die cho: tai khoan khong vao duoc Marketplace."};
  const scriptPattern=/<script\b[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match=scriptPattern.exec(html))) {
    let root; try {root=JSON.parse(match[1]);} catch {try{root=JSON.parse(decode(match[1]));}catch{continue;}}
    const stack=[root]; let visited=0;
    while(stack.length && visited++<100000) {
      const node=stack.pop(); if (!node || typeof node!=="object") continue;
      if (String(node.id || "") === listingId && /Marketplace.*Listing/i.test(String(node.__typename || ""))) {
        if (node.is_sold === true) return {status:"sold"};
        if (node.is_pending === true) return {status:"pending"};
        if (node.is_buy_now_enabled === true) return {status:"buy now"};
      }
      for(const value of Object.values(node)) if(value && typeof value==="object") stack.push(value);
    }
  }
  const withoutScripts=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"");
  // Server-rendered title fallback: require the listing's canonical URL.
  const canonical = withoutScripts.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)/i)?.[1];
  if (canonical && new RegExp(`/marketplace/item/${listingId}(?:/|[?#]|$)`).test(canonical)) {
    const headings=[...withoutScripts.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((item)=>decode(item[1].replace(/<[^>]*>/g," ")).replace(/\s+/g," ").trim());
    for (const heading of headings) { const found=heading.match(/^(sold|pending)\s*[·•]\s*\S/i); if(found)return {status:found[1].toLowerCase()}; }
  }
  return {status:"không rõ",reason:"HTML chua du bang chung; can kiem tra bang trinh duyet (ke ca mau nut Buy now)."};
}
