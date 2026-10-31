const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once,EventEmitter} = require('node:events');

(async () => {
  const {createOwnedScratch,validateOwnedScratch,cleanupBrowserTest}=await import('./browser-cleanup.mjs');
  const evidence=path.resolve(__dirname,'../test-results/cleanup-unit');
  const scratch=createOwnedScratch('quiet-camera-cleanup-test-');
  assert.equal(validateOwnedScratch(scratch),scratch);
  assert.throws(()=>validateOwnedScratch(path.dirname(scratch)),/not owned/);
  assert.throws(()=>validateOwnedScratch(path.join(scratch,'profile')),/not owned/);
  assert.throws(()=>createOwnedScratch('../outside-'),/Invalid/);
  const marker=path.join(scratch,'.quiet-camera-test-owner'), token=fs.readFileSync(marker,'utf8');
  fs.writeFileSync(marker,'changed-owner');
  assert.throws(()=>validateOwnedScratch(scratch),/ownership/);
  fs.writeFileSync(marker,token);
  const child=spawn(process.execPath,['-e','setTimeout(()=>{},250)'],{windowsHide:true,stdio:'ignore'});
  await once(child,'spawn');
  let exited=false;child.once('exit',()=>{exited=true});
  const cleanup=cleanupBrowserTest({scratch,chrome:child,output:evidence});
  await new Promise(resolve=>setTimeout(resolve,25));
  assert(fs.existsSync(scratch),'scratch remains while its child is alive');
  const result=await cleanup;
  assert(exited,'spawned child exit is observed before deletion');
  assert.equal(result.passed,true);
  assert.equal(result.scratchRemoved,true);
  assert.equal(fs.existsSync(scratch),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(evidence,'cleanup.json'),'utf8')).browserExited,true);
  // Model ChildProcess's documented distinction: exit has happened while a
  // separately inherited stdio handle delays close. No real process is killed.
  const pipeScratch=createOwnedScratch('quiet-camera-cleanup-pipe-test-');
  const pipeChild=new EventEmitter();
  Object.assign(pipeChild,{pid:2147483647,exitCode:null,signalCode:null,kill(){throw Error('An exited process must not be killed')}});
  let pipeReleased=false,closeObserved=false;
  pipeChild.stderr={destroy(){pipeReleased=true;pipeChild.emit('close',0)}};
  pipeChild.once('close',()=>{closeObserved=true});
  setTimeout(()=>{pipeChild.exitCode=0;pipeChild.emit('exit',0)},40);
  const pipeResult=await cleanupBrowserTest({scratch:pipeScratch,chrome:pipeChild,output:path.join(evidence,'pipe')});
  assert.equal(pipeResult.passed,true,'process exit does not depend on inherited pipe EOF');
  assert.equal(pipeResult.browserExit.exitCode,0);
  assert.equal(pipeReleased,true,'only the exited child pipes are released');
  assert.equal(closeObserved,true);
  assert.equal(pipeResult.scratchRemoved,true);
  assert.equal(fs.existsSync(pipeScratch),false);
  console.log('owned browser cleanup tests passed: 17 cases');
})().catch(error=>{console.error(error);process.exitCode=1});
