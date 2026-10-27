const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const q=require('../video.js'),p=q.RECORDING_LIMITS,M=1024*1024,cases=[];
for(const bps of [1500000,3500000,7000000,12000000,16000000,20000000,24000000,28128000])for(const seconds of [1,2,3.4,6.8])for(const multiplier of [.8,1,1.3,1.5,1.7,2,2.2,2.5])for(const nominalMiB of [20,100,512]){
 const nominal=nominalMiB*M,observed=Math.ceil(bps/8*seconds*multiplier),next=Math.ceil(observed*1.5),flush=observed,stop=q.calculateRecordingStopBytes(nominal,bps,observed),final=stop-1+next+flush;
 const initialAvailable=2*(nominal+p.delayedOutputAllowanceBytes)+p.finalizationReserveBytes;
 assert.equal(q.calculateRecordingByteBudget(initialAvailable),nominal);
 assert.equal(q.recordingFinalizeSizeAllowed(final,{finalizeLimitBytes:nominal+p.delayedOutputAllowanceBytes}),true,'global acceptance must not strand a low nominal budget');
 assert.ok(final+p.finalizationReserveBytes<=initialAvailable,'atomic promotion must fit the modeled total remaining quota');
 cases.push({bps,seconds,multiplier,nominalMiB,stop,observed,next,flush,final,initialAvailable});
}
assert.equal(cases.length,768);assert.equal(q.recordingFinalizeSizeAllowed(p.targetBytes+p.delayedOutputAllowanceBytes+1),false);
const out=path.resolve(__dirname,'../test-results');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'recording-budget-matrix.json'),JSON.stringify({passed:true,cases:cases.length,sizeRejections:0,quotaViolations:0,scope:'Finite stated burst envelope; arbitrary output and external quota consumption are covered by rollback/data retention/export, not a numerical guarantee',details:cases},null,2));console.log('recording budget matrix passed: 768 cases; 0 size rejections, 0 modeled quota violations');
