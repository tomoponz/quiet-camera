import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readChildAudit,summarizeMediaAudits} from './media-audit.mjs';
import {syntaxFiles} from './application-files.mjs';
const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'test-results');
fs.mkdirSync(output,{recursive:true});
const results=[],mediaAudits=[];
async function run(args,env={}){
 const result=await new Promise(resolve=>{
  const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  child.on('error',error=>resolve({args,code:1,stdout,stderr:String(error)}));
  child.on('close',code=>resolve({args,code,stdout,stderr}));
 });results.push(result);console.log(JSON.stringify({test:args.join(' '),passed:result.code===0}));if(result.code!==0)process.stderr.write((result.stderr||result.stdout).slice(-12000));return result;
}
const suites=fs.readdirSync(import.meta.dirname).filter(f=>f==='validate.mjs'||f.endsWith('.test.cjs'));
await Promise.all(suites.map(file=>run(['tests/'+file])));
const syntax=syntaxFiles(root);
await run(['tests/check-syntax.mjs']);
const browsers=[
 ['structure-upgrade-browser.test.mjs','QC_STRUCTURE_UPGRADE_OUTPUT','structure-upgrade'],
 ['mixed-review-browser.test.mjs','QC_MIXED_OUTPUT','mixed-review'],
 ['continuous-capture-browser.test.mjs','QC_CONTINUOUS_CAPTURE_OUTPUT','continuous-capture'],
 ['recording-safety-browser.test.mjs','QC_RECORDING_BROWSER_OUTPUT','recording-safety'],
 ['review-history-regression-browser.test.mjs','QC_REVIEW_HISTORY_OUTPUT','review-history'],
 ['pc-buttons-browser.test.mjs','QUIET_CAMERA_PC_BUTTONS_TEST_OUTPUT','pc-buttons'],
 ['layout-browser.test.mjs','QUIET_CAMERA_TEST_OUTPUT','layout'],
 ['media-review-browser.test.mjs','QUIET_CAMERA_REVIEW_TEST_OUTPUT','media'],
 ['modal-layer-browser.test.mjs','QUIET_CAMERA_MODAL_TEST_OUTPUT','history'],
 ['settings-sheet-browser.test.mjs','QUIET_CAMERA_SHEET_TEST_OUTPUT','settings'],
 ['mode-indicator-browser.test.mjs','QUIET_CAMERA_MODE_TEST_OUTPUT','mode'],
 ['preview-width-browser.test.mjs','QUIET_CAMERA_PREVIEW_TEST_OUTPUT','preview'],
 ['camera-overlay-browser.test.mjs','QUIET_CAMERA_OVERLAY_OUTPUT','overlay'],
 ['device-layout-browser.test.mjs','QUIET_CAMERA_DEVICE_TEST_OUTPUT','device'],
 ['zoom-status-browser.test.mjs','QUIET_CAMERA_ZOOM_TEST_OUTPUT','zoom-status'],
 ['gallery-interaction-browser.test.mjs','QUIET_CAMERA_GALLERY_TEST_OUTPUT','gallery'],
 ['camera-transition-browser.test.mjs','QUIET_CAMERA_TRANSITION_TEST_OUTPUT','transition'],
 ['review-action-bar-browser.test.mjs','QUIET_CAMERA_DETAIL_TEST_OUTPUT','detail-actions'],
 ['gallery-action-bar-browser.test.mjs','QUIET_CAMERA_ACTIONS_TEST_OUTPUT','actions'],
 ['preview-fit-browser.test.mjs','QUIET_CAMERA_FIT_OUTPUT','preview-fit'],
];
let browserSuites=0;
if(process.argv.includes('--browser')&&results.every(r=>r.code===0)){
 let cursor=0;
 await Promise.all(Array.from({length:2},async()=>{while(cursor<browsers.length){const[file,key,folder]=browsers[cursor++];const startedAt=Date.now();const child=await run(['tests/'+file],{[key]:path.join(output,folder),QUIET_CAMERA_REVIEW_FIXTURES:path.join(root,'tests/fixtures'),QUIET_CAMERA_OVERLAY_ROOT:root,QUIET_CAMERA_OVERLAY_BASELINE:'0'});mediaAudits.push({suite:file,...readChildAudit({stdout:child.stdout,outputDir:path.join(output,folder),startedAt})});browserSuites++;}}));
}
const summary={passed:results.every(r=>r.code===0),recordedAt:new Date().toISOString(),sourceSuites:suites.length,syntaxChecks:syntax.length,browserSuites,...(()=>{const m=summarizeMediaAudits(mediaAudits);return {deviceMediaUsed:m.deviceMediaUsed,missingMediaAudit:m.missingAudit,mediaAudit:m.rows}})(),results};
fs.writeFileSync(path.join(output,'aggregate.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({passed:summary.passed,sourceSuites:summary.sourceSuites,syntaxChecks:summary.syntaxChecks,browserSuites}));if(!summary.passed)process.exitCode=1;
