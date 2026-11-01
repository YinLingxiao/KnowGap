const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');
const temp = process.env.ROUNDTRIP_DIR;
for (const file of ['lib/config.ts', 'lib/api/errors.ts', 'lib/api/http-client.ts', 'lib/api/material-client.ts']) {
  const dest = path.join(temp, file.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(dest), {recursive:true});
  fs.writeFileSync(dest, ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText);
}
const {request} = require(path.join(temp,'lib/api/http-client.js'));
const {createMaterialClient} = require(path.join(temp,'lib/api/material-client.js'));
const root = process.env.ROUNDTRIP_API;
const materials = createMaterialClient(root);
async function main() {
  assert.deepEqual(await request(root,'/health'),{status:'ok'});
  const config = await request(root,'/api/ai/config');
  if (process.argv[2] === 'restart') {
    assert.equal(config.model,'synthetic-tutor');
    assert.equal(config.has_api_key,true);
    const [document] = await materials.list();
    await materials.remove(document.id);
    assert.deepEqual(await materials.search('后进先出'),[]);
    console.log('HTTP adapter roundtrip: restart recovery, persisted AI configuration, material removal passed.');
    return;
  }
  assert.equal(config.configured,false);
  assert.equal((await request(root,'/api/problems')).length,3);
  const document = await materials.upload(new File(['栈遵循后进先出，只能弹出栈顶。 LIFO means last in first out.'], 'stack-notes.md'));
  assert.equal((await materials.search('后进先出'))[0].documentId,document.id);
  const input = {base_url:process.env.ROUNDTRIP_PROVIDER,model:'synthetic-tutor',api_key:'synthetic-key'};
  await assert.rejects(request(root,'/api/ai/test',{method:'POST',body:JSON.stringify({...input,model:'bad-auth'})}),e=>e.kind==='model_unavailable');
  await assert.rejects(request(root,'/api/ai/test',{method:'POST',body:JSON.stringify({...input,model:'bad-format'})}),e=>e.kind==='model_unavailable');
  const probe = await request(root,'/api/ai/test',{method:'POST',body:JSON.stringify(input)});
  assert.equal(probe.structured_output,true);
  assert.equal((await request(root,'/api/ai/config')).configured,false);
  const saved = await request(root,'/api/ai/config',{method:'PUT',body:JSON.stringify(input)});
  assert.equal(saved.configured,true);
  assert.equal(JSON.stringify(saved).includes(input.api_key),false);
  assert.equal((await request(root,'/api/ai/test',{method:'POST'})).status,'ok');
  console.log('HTTP adapter roundtrip: provider auth/format errors, AI test/save, material upload/search passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
