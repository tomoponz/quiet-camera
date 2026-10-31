"use strict";
const assert=require('node:assert/strict'),m=require('../assets/js/device-layout-model.js');let checks=0;
function check(actual,expected){assert.deepEqual(actual,expected);checks++;}
const phone=(type,angle,width=800,height=393)=>m.rotation({type,angle,width,height});
check(phone('portrait-primary',0,393,800),0);check(phone('landscape-primary',90),1);check(phone('landscape-secondary',270),3);check(phone('portrait-secondary',180,393,800),2);
check(phone('portrait-primary',0,393,280),0); // Keyboard must not imply a physical turn.
check(phone('landscape-primary',0),3);check(phone('portrait-primary',90,393,800),0); // Natural-landscape screen.
check(m.rotation({legacyAngle:-90,width:800,height:393}),3);check(m.rotation({width:800,height:393}),1);check(m.rotation({width:800,height:393,previous:3}),3);
const box={x:10,y:20,width:30,height:40};
check(m.rect(box,100,200,1),{x:20,y:60,width:40,height:30});check(m.rect(box,100,200,3),{x:140,y:10,width:40,height:30});check(m.rect(box,100,200,2),{x:60,y:140,width:30,height:40});
check(m.rect({x:40,y:180,width:20,height:20},100,200,1),{x:180,y:40,width:20,height:20}); // Portrait bottom -> landscape right.
check(m.rect({x:40,y:0,width:20,height:20},100,200,1),{x:0,y:40,width:20,height:20}); // Portrait top -> landscape left.
for(const q of [0,1,2,3])for(const [width,height]of[[393,800],[320,480],[641,360],[393,280]])for(const aspect of[3/4,1,9/16]){
 const size=m.size(width,height,q),safe=m.insets({top:20,right:12,bottom:18,left:8},q),fit=m.fit(size.width,size.height,safe,aspect,q),r=fit.viewport;
 assert(r.x>=8-.01&&r.y>=20-.01&&r.x+r.width<=width-12+.01&&r.y+r.height<=height-18+.01);
 assert(Math.abs(r.width/r.height-(q%2?1/aspect:aspect))<1e-9);
 assert.equal(fit.canonical.y,safe.top);checks++;
}
for(const aspect of[9/16,3/4,1,16/9]){
 const region={x:12,y:118,width:369,height:516},f=m.fitRegion(region,aspect);
 assert(Math.abs(f.y+f.height-634)<1e-9);
 assert(f.x>=12&&f.x+f.width<=381+.001&&f.y>=118);
 assert(Math.abs(f.width/f.height-aspect)<1e-9);
 assert(Math.abs(f.width-369)<1e-9||Math.abs(f.height-516)<1e-9);checks++;
}
console.log(JSON.stringify({passed:true,checks,clockwiseAndCounterclockwise:true,orientationLockUsed:false}));
