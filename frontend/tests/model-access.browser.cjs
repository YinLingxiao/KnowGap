// PLAYWRIGHT_MODULE points at an external Playwright install; no application dependency.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  const output = process.env.MODEL_SCREENSHOTS;
  assert.ok(output, 'Set MODEL_SCREENSHOTS to a directory outside the repository');
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const express = 'https://aiplatform.googleapis.com/v1/publishers/google/models';
  let saved = { base_url: express, model: 'gemini-4-argon', has_api_key: true, configured: true, auth_mode: 'api_key', project_id: '', location: 'global' };
  const requests = [];
  await page.route('**/api/ai/**', async route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: saved });
    const body = request.postDataJSON();
    requests.push({ path: new URL(request.url()).pathname, body });
    if (request.url().endsWith('/test')) return route.fulfill({ json: { status: 'ok', model: body.model, structured_output: true } });
    saved = { ...saved, ...body, has_api_key: body.auth_mode !== 'adc', configured: true };
    delete saved.api_key;
    return route.fulfill({ json: saved });
  });
  try {
    await page.goto((process.env.MODEL_PREVIEW_URL || 'http://127.0.0.1:3000') + '/dev/model-access');
    const auth = page.getByLabel('认证方式', { exact: true });
    await auth.waitFor();
    assert.equal(await auth.inputValue(), 'api_key');
    assert.equal(await page.locator('input[type="password"]').count(), 1);
    await auth.selectOption('adc');
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: '测试连接', exact: true }).isDisabled(), true);
    await page.getByLabel('Google Cloud 项目 ID', { exact: true }).fill('knowgap-adc-test');
    await page.getByLabel('区域', { exact: true }).fill('us-central1');
    const url = page.getByLabel('接口地址', { exact: true });
    assert.equal(await url.getAttribute('readonly'), '');
    assert.equal(await url.inputValue(), 'https://us-central1-aiplatform.googleapis.com/v1/projects/knowgap-adc-test/locations/us-central1/publishers/google/models');
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await page.getByText(/连接正常：gemini-4-argon/).waitFor();
    assert.equal(requests.at(-1).body.auth_mode, 'adc');
    assert.ok(!('api_key' in requests.at(-1).body));
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('已保存，立即生效。', { exact: true }).waitFor();
    await page.reload();
    await auth.waitFor();
    assert.equal(await auth.inputValue(), 'adc');
    assert.equal(await page.getByLabel('区域', { exact: true }).inputValue(), 'us-central1');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const width of [1080, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: path.join(output, `adc-${theme}-${width}.png`), fullPage: true });
      }
    }
    await auth.selectOption('api_key');
    assert.equal(await url.inputValue(), express);
    assert.equal(await page.locator('input[type="password"]').count(), 1);
    assert.equal(await page.getByRole('button', { name: '测试连接', exact: true }).isDisabled(), true);
    await page.getByLabel('Vertex Express API Key', { exact: true }).fill('synthetic-only');
    assert.equal(await page.getByRole('button', { name: '测试连接', exact: true }).isEnabled(), true);
    assert.deepEqual(errors, []);
    console.log('ADC/API-key switching, validation, probe/save payloads, reload, themes and responsive layout passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
