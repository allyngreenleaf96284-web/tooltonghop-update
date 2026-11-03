import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {installSellerStateGuard} from '../modules/seller_state_guard.js';
const require=createRequire(import.meta.url);
test('preselected CA is clicked again and its menu closes before continuing',async()=>{
 const browser=await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage();await page.setContent(`<button role="combobox" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#options').hidden=false">County/region CA</button><div id="options" role="listbox" hidden><button role="option" onclick="document.body.dataset.selected='yes';document.querySelector('[role=combobox]').setAttribute('aria-expanded','false');document.querySelector('#options').hidden=true">CA</button><button role="option">AR</button></div>`);
 const manager={selectStateDropdown(){throw Error('old broad selector called');}};const restore=installSellerStateGuard(manager);await manager.selectStateDropdown(page,'CA');assert.equal(await page.evaluate(()=>document.body.dataset.selected),'yes');assert.equal(await page.$eval('[role=combobox]',el=>el.getAttribute('aria-expanded')),'false');restore();
 }finally{await browser.close();}
});
