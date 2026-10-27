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
    const counters=audit?Object.fromEntries(['mediaCalls','nativeMediaCalls'].filter(k=>Number.isFinite(audit[k])&&audit[k]>=0).map(k=>[k,audit[k]])):{};
    return{suite,source,counters,reported:Object.keys(counters).length>0,syntheticRequests:Array.isArray(audit?.requests)?audit.requests.length:null};
  });
  const missingAudit=rows.filter(r=>!r.reported).map(r=>r.suite),used=rows.some(r=>Object.values(r.counters).some(v=>v>0));
  return{rows,missingAudit,deviceMediaUsed:used?true:!rows.length||missingAudit.length?null:false};
}
