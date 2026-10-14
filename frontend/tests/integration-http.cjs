const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');
const temp = process.env.ROUNDTRIP_DIR;
for (const file of ['lib/config.ts', 'lib/api/errors.ts', 'lib/api/http-client.ts']) {
  const dest = path.join(temp, file.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(dest), {recursive:true});
  fs.writeFileSync(dest, ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText);
}
const {createHttpClient,request} = require(path.join(temp,'lib/api/http-client.js'));
const root = process.env.ROUNDTRIP_API;
const client = createHttpClient(root);
async function main() {
  await client.checkHealth();
  const config = await request(root,'/api/ai/config');
  if (process.argv[2] === 'restart') {
    assert.equal(config.model,'synthetic-tutor');
    assert.equal(config.has_api_key,true);
    const id = fs.readFileSync(path.join(temp,'session'),'utf8');
    const session = await client.getSession(id);
    assert.equal(session.turn,4);
    assert.equal(session.diagnosis.assessment,'correct');
    assert.equal(session.submissionDiagnosis.assessment,'incorrect');
    assert.equal(session.messages.length,7);
    const memories = await client.listMemories('demo-student-001');
    assert.equal(memories.length,1);
    assert.equal(memories[0].status,'improving');
    await client.deleteMemory(memories[0].id);
    assert.deepEqual(await client.listMemories('demo-student-001'),[]);
    const next = await client.startSession({studentId:'demo-student-001',problemId:'stack-sequence-001',answer:'合法',reasoning:'数字相同'});
    assert.deepEqual(next.usedMemoryIds,[]);
    console.log('HTTP adapter roundtrip: restart recovery, persisted AI configuration, memory deletion passed.');
    return;
  }
  assert.equal(config.configured,false);
  assert.equal((await client.listProblems()).length,3);
  const input = {base_url:process.env.ROUNDTRIP_PROVIDER,model:'synthetic-tutor',api_key:'synthetic-key'};
  await assert.rejects(request(root,'/api/ai/test',{method:'POST',body:JSON.stringify({...input,model:'bad-auth'})}),e=>e.kind==='model_unavailable');
  await assert.rejects(request(root,'/api/ai/test',{method:'POST',body:JSON.stringify({...input,model:'bad-format'})}),e=>e.kind==='model_unavailable');
  const probe = await request(root,'/api/ai/test',{method:'POST',body:JSON.stringify(input)});
  assert.equal(probe.structured_output,true);
  assert.equal((await request(root,'/api/ai/config')).configured,false);
  assert.deepEqual(await client.listMemories('demo-student-001'),[]);
  const saved = await request(root,'/api/ai/config',{method:'PUT',body:JSON.stringify(input)});
  assert.equal(saved.configured,true);
  assert.equal(JSON.stringify(saved).includes(input.api_key),false);
  assert.equal((await request(root,'/api/ai/test',{method:'POST'})).status,'ok');
  const start = await client.startSession({studentId:'demo-student-001',problemId:'stack-sequence-001',answer:'合法',reasoning:'数字相同'});
  assert.equal(start.diagnosis.assessment,'incorrect');
  const memoryId = start.memoryChanges[0].memoryId;
  const first = await client.sendMessage(start.sessionId,'弹出3后可以直接拿1。');
  assert.equal(first.turn,2);
  assert.equal(first.memoryChanges[0].toStatus,'needs_review');
  assert.deepEqual(first.usedMemoryIds,[memoryId]);
  for (const text of ['栈顶其实是2。','栈顶的2必须先弹出。']) {
    const turn = await client.sendMessage(start.sessionId,text);
    assert.equal(turn.diagnosis.assessment,'correct');
    assert.equal(turn.memoryChanges[0].toStatus,'improving');
  }
  const memories = await client.listMemories('demo-student-001');
  assert.equal(memories.length,1);
  assert.equal(memories[0].evidenceCount,4);
  fs.writeFileSync(path.join(temp,'session'),start.sessionId);
  console.log('HTTP adapter roundtrip: provider auth/format errors, AI test/save, 4 teaching turns, memory retrieval passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
