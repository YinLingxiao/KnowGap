// OpenCode Go is a selectable preset everywhere the provider list is enumerated.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');

test('OpenCode Go preset points at the Go OpenAI-compatible endpoint', () => {
  assert.match(read('lib/modelProviders.ts'), /id: "opencode"[\s\S]*?baseUrl: "https:\/\/opencode\.ai\/inference\/go\/openai\/v1"/);
  assert.match(read('lib/api/model-library.ts'), /"zhipu", "opencode", "vertex"/);
  assert.match(read('components/settings/ProviderEditor.tsx'), /"openai", "opencode", "chatgpt"/);
});
