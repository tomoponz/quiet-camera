const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{const {readChildAudit,summarizeMediaAudits}=await import('./media-audit.mjs');
assert.equal(summarizeMediaAudits([]).deviceMediaUsed,null);
assert.equal(summarizeMediaAudits([{suite:'missing',audit:null}]).deviceMediaUsed,null);
assert.equal(summarizeMediaAudits([{suite:'zero',source:'test',audit:{nativeMediaCalls:0}}]).deviceMediaUsed,false);
assert.equal(summarizeMediaAudits([{suite:'used',audit:{mediaCalls:1}},{suite:'missing'}]).deviceMediaUsed,true);
assert.equal(summarizeMediaAudits([{suite:'bad',audit:{mediaCalls:-1}}]).deviceMediaUsed,null);
assert.equal(readChildAudit({stdout:'log\n{"audit":{"mediaCalls":0}}\n{"passed":true}\n'}).audit.mediaCalls,0);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quiet-camera-audit-test-'));const file=path.join(dir,'results.json');fs.writeFileSync(file,JSON.stringify({audit:{nativeMediaCalls:0}}));assert.equal(readChildAudit({outputDir:dir,startedAt:Date.now()+1000}).audit,null);assert.equal(readChildAudit({outputDir:dir,startedAt:0}).audit.nativeMediaCalls,0);fs.rmSync(file);fs.rmdirSync(dir);console.log('media audit tests passed: 8 cases')})().catch(e=>{console.error(e);process.exitCode=1});
