import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'test-results');
fs.mkdirSync(output,{recursive:true});
const results=[];
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
const syntax=[...fs.readdirSync(root).filter(f=>f.endsWith('.js')),...fs.readdirSync(import.meta.dirname).filter(f=>/\.(cjs|mjs)$/.test(f)).map(f=>'tests/'+f)];
await Promise.all(syntax.map(file=>run(['--check',file])));
const browsers=[
 ['layout-browser.test.mjs','QUIET_CAMERA_TEST_OUTPUT','layout'],
 ['media-review-browser.test.mjs','QUIET_CAMERA_REVIEW_TEST_OUTPUT','media'],
 ['modal-layer-browser.test.mjs','QUIET_CAMERA_MODAL_TEST_OUTPUT','history'],
 ['settings-sheet-browser.test.mjs','QUIET_CAMERA_SHEET_TEST_OUTPUT','settings'],
 ['mode-indicator-browser.test.mjs','QUIET_CAMERA_MODE_TEST_OUTPUT','mode'],
 ['preview-width-browser.test.mjs','QUIET_CAMERA_PREVIEW_TEST_OUTPUT','preview'],
 ['camera-overlay-browser.test.mjs','QUIET_CAMERA_OVERLAY_OUTPUT','overlay'],
 ['device-layout-browser.test.mjs','QUIET_CAMERA_DEVICE_TEST_OUTPUT','device'],
];
let browserSuites=0;
if(process.argv.includes('--browser')&&results.every(r=>r.code===0)){
 let cursor=0;
 await Promise.all(Array.from({length:2},async()=>{while(cursor<browsers.length){const[file,key,folder]=browsers[cursor++];await run(['tests/'+file],{[key]:path.join(output,folder),QUIET_CAMERA_REVIEW_FIXTURES:path.join(root,'tests/fixtures'),QUIET_CAMERA_OVERLAY_ROOT:root,QUIET_CAMERA_OVERLAY_BASELINE:'0'});browserSuites++;}}));
}
const summary={passed:results.every(r=>r.code===0),recordedAt:new Date().toISOString(),sourceSuites:suites.length,syntaxChecks:syntax.length,browserSuites,deviceMediaUsed:false,results};
fs.writeFileSync(path.join(output,'aggregate.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({passed:summary.passed,sourceSuites:summary.sourceSuites,syntaxChecks:summary.syntaxChecks,browserSuites}));if(!summary.passed)process.exitCode=1;
