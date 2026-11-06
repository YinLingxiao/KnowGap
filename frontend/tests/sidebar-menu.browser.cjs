// Run against a static production preview with PLAYWRIGHT_MODULE and SIDEBAR_SCREENSHOTS set.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
 const output = process.env.SIDEBAR_SCREENSHOTS;
 assert.ok(output, 'Set SIDEBAR_SCREENSHOTS to an artifact directory outside the repository');
 fs.mkdirSync(output, {recursive:true});
 const browser = await chromium.launch({channel:'chrome',headless:true});
 try {
 const page = await browser.newPage({viewport:{width:1100,height:820}});
 await page.addInitScript(() => localStorage.setItem('knowgap.auth.mode.v1','demo'));
 await page.route('**/api/**', route => {
  const p = new URL(route.request().url()).pathname;
  let json = {};
  if(p === '/api/conversations') json = Array.from({length:30},(_,i)=>({id:`test-${i}`, title:`极坐标计算二重积分测试会话 ${i}`,kind:'chat',message_count:2,created_at:'2026-11-06T00:00:00Z',updated_at:'2026-11-06T00:00:00Z'}));
  else if(p === '/api/subjects') json=[];
  else if(p.includes('onboarding')) json={status:'completed'};
  else if(p.includes('config')) json={configured:true,has_api_key:true,model:'test'};
  return route.fulfill({json});
 });
 await page.goto(process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:3197');
 await page.waitForTimeout(2000);
 const coach = page.getByRole('button',{name:'知道了',exact:true});
 if (await coach.isVisible()) await coach.click();
 const rows = page.locator('li').filter({has:page.locator('button[aria-haspopup="menu"]')});
 const openMenu = async (row) => {
   await row.hover();
   await row.locator('button[aria-haspopup="menu"]').click();
   await page.getByRole('menu').waitFor();
   await page.waitForTimeout(200);
 };
 for (const theme of ['dark','light']) {
   await page.evaluate(t => document.documentElement.dataset.theme=t,theme);
   await openMenu(rows.first());
   assert.ok(await page.getByRole('menu').evaluate(el => el.parentElement === document.body));
   assert.ok(await page.getByRole('menu').evaluate(el => {
     const r=el.getBoundingClientRect();
     return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
   }), 'Menu must receive hits instead of the following conversation');
   await page.screenshot({path:path.join(output, `sidebar-${theme}.png`)});
   await page.keyboard.press('Escape');
   assert.equal(await page.getByRole('menu').count(),0);
   assert.ok(await rows.first().locator('button[aria-haspopup="menu"]').evaluate(el=>el===document.activeElement));
   await openMenu(rows.first());
   await page.getByRole('menuitem',{name:'重命名',exact:true}).click();
   await page.locator('input[class*=renameInput]').waitFor();
   await page.keyboard.press('Escape');
   await openMenu(rows.first());
   await page.getByRole('menuitem',{name:'删除',exact:true}).click();
   await page.getByRole('button',{name:'取消',exact:true}).click();
   await openMenu(rows.first());
   await page.getByRole('button',{name:'新对话',exact:true}).click();
   assert.equal(await page.getByRole('menu').count(),0);
   await openMenu(rows.last());
   const box=await page.getByRole('menu').boundingBox();
   assert.ok(box.y>=8 && box.y+box.height<=812, 'Bottom-row menu stays in viewport');
   await page.locator('[class*="ConversationSidebar_scroll"]').evaluate(el=>el.scrollTop=0);
   await page.getByRole('menu').waitFor({state:'detached'});
   console.log(`PASS ${theme}: stacking, focus, Escape, rename, delete cancel, outside click, bottom edge, scroll dismissal`);
 }
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
