import fs from 'node:fs';
import path from 'node:path';
export function readChildAudit({stdout='',outputDir=null,startedAt=0}){
  for(const line of stdout.trim().split(/\r?\n/).reverse()){
    try{const value=JSON.parse(line);if(value?.audit&&typeof value.audit==='object')return{source:'stdout',audit:value.audit}}catch{}
  }
  if(outputDir){try{const file=path.join(outputDir,'results.json');if(fs.statSync(file).mtimeMs>=startedAt){const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value?.audit&&typeof value.audit==='object')return{source:'results.json',audit:value.audit}}}catch{}}
  return{source:null,audit:null};
}
export function summarizeMediaAudits(entries){
  const rows=entries.map(({suite,source,audit})=>{
    const keys=audit?['mediaCalls','nativeMediaCalls'].filter(k=>Object.hasOwn(audit,k)):[];
    const counters=Object.fromEntries(keys.filter(k=>Number.isInteger(audit[k])&&audit[k]>=0).map(k=>[k,audit[k]]));
    return{suite,source,counters,reported:keys.length>0&&Object.keys(counters).length===keys.length,syntheticRequests:Array.isArray(audit?.requests)?audit.requests.length:null};
  });
  const missingAudit=rows.filter(r=>!r.reported).map(r=>r.suite),used=rows.some(r=>Object.values(r.counters).some(v=>v>0));
  return{rows,missingAudit,deviceMediaUsed:used?true:!rows.length||missingAudit.length?null:false};
}

export function regressionOutcome({results,browserRequested,expectedSuites=[],mediaAudits=[]}) {
  if(!browserRequested)expectedSuites=[];
  const media=summarizeMediaAudits(mediaAudits), observed=mediaAudits.map(entry=>entry.suite);
  const missingSuites=expectedSuites.filter(suite=>!observed.includes(suite));
  const unexpectedSuites=observed.filter(suite=>!expectedSuites.includes(suite));
  const duplicateSuites=[...new Set(observed.filter((suite,index)=>observed.indexOf(suite)!==index))];
  const auditsPassed=!browserRequested||(expectedSuites.length>0&&media.deviceMediaUsed===false&&media.missingAudit.length===0&&missingSuites.length===0&&unexpectedSuites.length===0&&duplicateSuites.length===0);
  return {passed:results.every(result=>result.code===0)&&auditsPassed,media,auditsPassed,missingSuites,unexpectedSuites,duplicateSuites};
}
