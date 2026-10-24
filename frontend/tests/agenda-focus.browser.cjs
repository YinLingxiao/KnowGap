// Run with PLAYWRIGHT_MODULE pointing at an external Playwright installation.
// No browser-test dependency is added to the application.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const output = process.env.AGENDA_SCREENSHOTS;
  assert.ok(output, 'Set AGENDA_SCREENSHOTS to an artifact directory outside the repository');
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'no-preference' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const dialog = page.locator('dialog[aria-labelledby="task-composer-heading"]');
  const agenda = page.locator('[data-coachmark="agenda"]');
  const add = agenda.locator('header').getByRole('button', { name: '添加任务', exact: true });
  const screenshot = name => page.screenshot({ path: path.join(output, `${name}.png`) });
  async function closed() {
    await page.waitForTimeout(240);
    assert.equal(await dialog.evaluate(el => el.open), false);
    assert.equal(await dialog.evaluate(el => getComputedStyle(el).display), 'none');
  }
  try {
    await page.goto('http://127.0.0.1:3101');
    await page.getByRole('button', { name: '使用本机演示身份直接进入 →' }).click();
    await page.waitForTimeout(1500);
    const demo = page.getByRole('button', { name: '先逛逛演示空间', exact: true });
    if (await demo.isVisible()) await demo.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: '日程', exact: true }).click();
    const coach = page.getByRole('button', { name: '知道了', exact: true });
    if (await coach.isVisible()) await coach.click();
    await add.waitFor();

    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      // Leave the app in its default system-following theme.
      await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
      for (const [view, name] of [['inbox', '待办'], ['today', '今天'], ['upcoming', '预览'], ['week', '周历'], ['space', '数据结构（演示）']]) {
        await agenda.locator('nav').getByRole('button', { name: new RegExp(`^${name.replace(/[（）]/g, '\\$&')}`) }).click();
        await add.waitFor({ state: 'visible' });
        assert.ok(await add.locator('svg').count());
        await screenshot(`${theme}-${view}`);
        await add.click();
        await dialog.waitFor({ state: 'visible' });
        await page.waitForTimeout(220);
        assert.equal(await dialog.evaluate(el => getComputedStyle(el).opacity), '1');
        if (view === 'space') {
          assert.match(await dialog.locator('footer').innerText(), /数据结构（演示）/);
          await screenshot(`${theme}-space-composer`);
        }
        await dialog.getByRole('button', { name: '关闭添加任务', exact: true }).click();
        await closed();
        console.log(`PASS ${theme} ${view}: header button, open/close${view === 'space' ? ', prefilled space' : ''}`);
      }
    }

    await agenda.locator('h1').click();
    await page.keyboard.press('q');
    await dialog.waitFor({ state: 'visible' });
    await page.waitForTimeout(220);
    await page.keyboard.press('Escape');
    await closed();
    console.log('PASS real Q / Escape keyboard path');

    // Inspect in-flight transitions within a single browser task so RPC latency
    // cannot consume the entire 180ms animation before sampling it.
    const animation = await page.evaluate(async () => {
      const d = document.querySelector('dialog[aria-labelledby="task-composer-heading"]');
      const trigger = document.querySelector('button[aria-keyshortcuts="Q"]');
      const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      trigger.click();
      await frames();
      const opening = d.getAnimations({ subtree: true }).map(a => ({ property: a.transitionProperty, duration: a.effect.getTiming().duration }));
      const entryOpacity = getComputedStyle(d).opacity;
      await Promise.all(d.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
      d.querySelector('button[aria-label="关闭添加任务"]').click();
      await frames();
      const exiting = d.getAnimations({ subtree: true }).map(a => ({ property: a.transitionProperty, duration: a.effect.getTiming().duration }));
      const exit = { open: d.open, display: getComputedStyle(d).display, opacity: getComputedStyle(d).opacity };
      return { opening, entryOpacity, exiting, exit };
    });
    assert.ok(animation.opening.some(a => a.property === 'opacity' && a.duration === 180), JSON.stringify(animation));
    assert.ok(animation.exiting.some(a => a.property === 'opacity' && a.duration === 180), JSON.stringify(animation));
    assert.ok(Number(animation.entryOpacity) < 1);
    assert.equal(animation.exit.open, false);
    assert.notEqual(animation.exit.display, 'none');
    await closed();
    console.log('PASS 180ms entry / exit transitions:', JSON.stringify(animation));

    // Freeze native CSS transitions at their midpoint for screenshot evidence.
    await page.evaluate(async () => {
      document.querySelector('button[aria-keyshortcuts="Q"]').click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const d = document.querySelector('dialog[aria-labelledby="task-composer-heading"]');
      d.getAnimations({ subtree: true }).forEach(a => { a.pause(); a.currentTime = 45; });
    });
    await page.screenshot({ path: path.join(output, 'motion-enter.png'), animations: 'allow' });
    await page.evaluate(async () => {
      const d = document.querySelector('dialog[aria-labelledby="task-composer-heading"]');
      d.getAnimations({ subtree: true }).forEach(a => a.finish());
      d.querySelector('button[aria-label="关闭添加任务"]').click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      d.getAnimations({ subtree: true }).forEach(a => { a.pause(); a.currentTime = 45; });
    });
    await page.screenshot({ path: path.join(output, 'motion-exit.png'), animations: 'allow' });
    await page.evaluate(() => document.querySelector('dialog[aria-labelledby="task-composer-heading"]').getAnimations({ subtree: true }).forEach(a => a.finish()));
    await closed();

    for (const mode of ['setting', 'system']) {
      await page.emulateMedia({ reducedMotion: mode === 'system' ? 'reduce' : 'no-preference' });
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const settings = page.getByRole('dialog', { name: '设置', exact: true });
      await settings.getByRole('button', { name: '通用', exact: true }).click();
      await settings.getByRole('radiogroup', { name: '界面动效', exact: true }).getByRole('radio', { name: mode === 'setting' ? '减弱' : '跟随系统', exact: true }).click();
      if (mode === 'setting') await screenshot('settings-reduced-choice');
      await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
      for (let i = 0; i < 3; i++) {
        await add.click();
        await dialog.waitFor({ state: 'visible' });
        assert.equal(await dialog.evaluate(el => getComputedStyle(el).opacity), '1');
        if (!i) await screenshot(`reduced-${mode}`);
        await page.keyboard.press('Escape');
        await closed();
      }
      console.log(`PASS reduced motion (${mode}): three open / close cycles`);
    }

    for (const width of [1024, 768, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await add.waitFor({ state: 'visible' });
      assert.equal(await add.evaluate(el => getComputedStyle(el).fontSize === '0px'), false);
      await add.click();
      await dialog.waitFor({ state: 'visible' });
      assert.ok(await dialog.evaluate(el => el.getBoundingClientRect().width <= innerWidth));
      await screenshot(`narrow-${width}`);
      await page.keyboard.press('Escape');
      await closed();
      console.log(`PASS ${width}px: labeled header button and composer fit`);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS no browser page errors; screenshots: ${output}`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
