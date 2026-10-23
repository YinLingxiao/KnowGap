// PLAYWRIGHT_MODULE / CHATGPT_SCREENSHOTS are supplied by the test runner.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const output = process.env.CHATGPT_SCREENSHOTS;
  assert.ok(output, 'Set CHATGPT_SCREENSHOTS to a directory outside the repository');
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = url => {
      window.__opened.push(url);
      const popup = { location: { href: url }, close() {} };
      window.__popup = popup;
      return popup;
    };
  });
  let connected = false;
  let authorized = false;
  let saved = { base_url: 'https://api.deepseek.com/v1', model: '', has_api_key: false, configured: false,
    auth_mode: 'api_key', project_id: '', location: 'global' };
  const payloads = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/ai/config' && request.method() === 'GET') return route.fulfill({ json: saved });
    if (url.pathname === '/api/chatgpt/start') {
      authorized = true;
      return route.fulfill({ json: { authorize_url: 'http://127.0.0.1:1455/auth/callback?state=test', expires_in: 600 } });
    }
    if (url.pathname === '/api/chatgpt/status') {
      return route.fulfill({ json: { connected, email: connected ? 'learner@example.com' : '', plan_enabled: connected,
        reauth_required: false, expires_at: 0, accounts: [], error: '' } });
    }
    if (url.pathname === '/api/chatgpt/models') {
      return route.fulfill({ json: { models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] } });
    }
    if (url.pathname === '/api/chatgpt/logout') {
      connected = false;
      return route.fulfill({ json: { revoked: true, warning: '' } });
    }
    if (url.pathname === '/api/ai/test') {
      payloads.push({ path: url.pathname, body: request.postDataJSON() });
      return route.fulfill({ json: { status: 'ok', model: 'gpt-6.1-sol', structured_output: true } });
    }
    if (url.pathname === '/api/ai/config' && request.method() === 'PUT') {
      const body = request.postDataJSON();
      payloads.push({ path: url.pathname, body });
      saved = { ...body, has_api_key: false, configured: true, chatgpt: { connected: true,
        email: 'learner@example.com', plan_enabled: true, reauth_required: false, expires_at: 0, accounts: [] } };
      return route.fulfill({ json: saved });
    }
    return route.fulfill({ status: 404, json: { detail: 'not mocked' } });
  });
  try {
    await page.goto((process.env.CHATGPT_PREVIEW_URL || 'http://127.0.0.1:3000') + '/dev/model-access');
    await page.getByRole('radio', { name: /ChatGPT 套餐/ }).click();
    await page.getByText('未连接', { exact: false }).first().waitFor();
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    const connect = page.getByRole('button', { name: 'Continue with ChatGPT', exact: true });
    await connect.click();
    connected = true;
    await page.getByText(/套餐额度已授权/).waitFor({ timeout: 8000 });
    assert.equal(authorized, true);
    assert.match(await page.evaluate(() => window.__popup.location.href), /^http:\/\/127\.0\.0\.1:1455\/auth\/callback/);
    const model = page.getByLabel('模型', { exact: true });
    await model.fill('gpt-6.1-sol');
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await page.getByText(/连接正常：gpt-6.1-sol/).waitFor();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('已保存，立即生效。', { exact: true }).waitFor();
    const testPayload = payloads.find(item => item.path === '/api/ai/test').body;
    const savePayload = payloads.find(item => item.path === '/api/ai/config').body;
    for (const body of [testPayload, savePayload]) {
      assert.equal(body.auth_mode, 'chatgpt');
      assert.equal(body.base_url, 'https://api.openai.com/v1');
      assert.ok(!('api_key' in body));
    }
    await page.reload();
    await page.getByText(/套餐额度已授权/).waitFor();
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'gpt-6.1-sol');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const width of [1080, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: path.join(output, `chatgpt-${theme}-${width}.png`), fullPage: true });
      }
    }
    await page.getByRole('button', { name: '断开', exact: true }).click();
    await page.getByText('已断开 ChatGPT，套餐额度不再使用。', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('ChatGPT OAuth card: provider, connect/poll, model, test/save payloads, reload, themes and responsive layout passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
