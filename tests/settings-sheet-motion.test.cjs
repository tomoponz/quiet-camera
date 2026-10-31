const assert = require('node:assert/strict');
const M = require('../assets/js/settings-sheet-motion.js');
let checks = 0;
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks++; };
const line = (speed, step = 10, end = 100) => Array.from({ length: Math.floor(end / step) + 1 }, (_, i) => ({ time: i * step, x: 50, y: 100 + i * step * speed }));
check('slow down is resize', M.releaseIntent(line(.5), 100).action, 'resize');
check('below threshold stays open', M.releaseIntent(line(.749), 100).action, 'resize');
check('threshold down dismisses', M.releaseIntent(line(.75), 100).action, 'dismiss');
check('threshold up expands', M.releaseIntent(line(-.75), 100).action, 'expand');
check('fast up expands', M.releaseIntent(line(-2), 100).action, 'expand');
check('fast down dismisses', M.releaseIntent(line(2), 100).action, 'dismiss');
for (const step of [4, 8, 12, 16, 20, 25, 33]) {
 const points = line(1.1, step, 99), now = points.at(-1).time;
 check('sampling cadence '+step, M.releaseIntent(points, now).action, 'dismiss');
}
const held = [...line(2), { time: 181, x: 50, y: 300 }];
check('hold cancels stale fling', M.releaseIntent(held, 181).action, 'resize');
check('insufficient travel stays open', M.releaseIntent([{time:0,x:0,y:0},{time:12,x:0,y:20},{time:24,x:0,y:35}],24).action,'resize');
check('two samples do not infer fling', M.releaseIntent([{time:0,x:0,y:0},{time:50,x:0,y:100}],50).action,'resize');
check('too short time does not infer fling', M.releaseIntent([{time:0,x:0,y:0},{time:5,x:0,y:50},{time:10,x:0,y:100}],10).action,'resize');
check('sideways motion stays open', M.releaseIntent(line(2).map(p=>({...p,x:p.time*2})),100).action,'resize');
check('small jitter stays open', M.releaseIntent(line(0).map((p,i)=>({...p,y:p.y+(i%2?2:-2)})),100).action,'resize');
check('coalesced duplicate timestamps are stable', M.releaseIntent([...line(1.2),...line(1.2)],100).action,'dismiss');
check('invalid samples ignored', M.releaseIntent([...line(1.2),{time:NaN,x:0,y:0},{time:Infinity,x:0,y:0}],100).action,'dismiss');
check('latest reverse direction prevents old downward fling', M.releaseIntent([...line(2,10,80),{time:90,x:50,y:250},{time:100,x:50,y:240}],100).action,'resize');
check('long drag uses only recent window', M.releaseIntent([...line(.1,10,400),...line(1.2).map(p=>({...p,time:p.time+410,y:p.y+200}))],510).action,'dismiss');
check('empty input is safe', M.releaseIntent([],0).action,'resize');
console.log(JSON.stringify({passed:true,checks,speed:M.SPEED,windowMs:M.WINDOW_MS,idleMs:M.IDLE_MS,travel:M.TRAVEL}));
