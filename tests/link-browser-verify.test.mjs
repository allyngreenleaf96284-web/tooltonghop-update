import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {createLinkBrowserVerifier} from '../modules/link_browser_verify.js';

test('browser verification isolates proxies/cookies, waits past initially disabled UI, and caps live pages at two',async()=>{
  let active=0,peak=0,closed=false;
  const contexts=[],pages=[];
  class Page extends EventEmitter {
    constructor(){super();this.calls=0;this.closed=false;active++;peak=Math.max(peak,active);pages.push(this);}
    async setRequestInterception(){} async authenticate(auth){this.auth=auth;} async setViewport(){} async setCookie(...cookies){this.cookies=cookies;}
    async goto(url){this.url=url;}
    async evaluate(){return this.url.includes('api64.ipify.org')?'{"ip":"2001:db8::1"}':{url:this.url,challenge:false,busy:false};}
    async close(){if(!this.closed){this.closed=true;active--;this.emit('close');}}
  }
  const browser={async createBrowserContext(options){const context={options,async newPage(){return new Page();}};contexts.push(context);return context;},async close(){closed=true;}};
  const verifier=createLinkBrowserVerifier({launch:async()=>browser,readStatus:async page=>++page.calls===1?'thâm buy now':'buy now- make an offer',settleMs:0,grayMinMs:1000,grayStableMs:1000,timeoutMs:3000});
  const nicks=[1,2,3].map(i=>({id:'p'+i,cookie:`c_user=${10000+i}; xs=fixture;`,proxy:`localhost:${8000+i}:user${i}:pass${i}`}));
  try{
    const invalid=await verifier.verify(nicks[0],'file:///fixture',{verifyIp:async ip=>({ip,country:'US'})});
    assert.match(invalid.reason,/khong hop le/);assert.equal(pages.length,0);
    const results=await Promise.all(nicks.map(nick=>verifier.verify(nick,'https://www.facebook.com/marketplace/item/123/',{verifyIp:async ip=>({ip,country:'US'})})));
    assert.ok(results.every(result=>result.status==='buy now- make an offer'&&result.verifiedBy==='browser'));
    assert.equal(peak,2);assert.equal(active,0);
    assert.deepEqual(contexts.map(context=>context.options.proxyServer),['http://localhost:8001','http://localhost:8002','http://localhost:8003']);
    assert.deepEqual(pages.map(page=>page.auth.username),['user1','user2','user3']);
    assert.deepEqual(pages.map(page=>page.cookies.find(cookie=>cookie.name==='c_user').value),['10001','10002','10003']);
  }finally{await verifier.close();assert.equal(closed,true);}
});
