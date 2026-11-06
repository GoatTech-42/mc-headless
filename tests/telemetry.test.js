'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
function harness(){let lines=[],running=true;const routes={};const box={fs:{statSync:()=>({mtimeMs:Date.now(),size:lines.join('\n').length}),readFileSync:()=>lines.join('\n')},path:require('node:path'),process:{env:{MC_JOIN_LOG_PATTERN:'^Joined world'}},GDIR:'/synthetic',isRunning:()=>running,Date,app:{get:(p,f)=>routes[p]=f}};
let a=source.indexOf('const transitionAt =');let b=source.indexOf("app.get('/api/login-code',",a);let c=source.indexOf('// Telemetry contract v2');let d=source.indexOf('const REVIVE_STATE_FILE',c);let e=source.indexOf('// desired = configured');let f=source.indexOf("app.get('/api/scripts',",e);
vm.createContext(box);vm.runInContext(source.slice(a,b).replace('const transitionAt = Date.now();','const transitionAt = Date.now()-120000;')+source.slice(c,d)+source.slice(e,f)+';this.scriptObserved=scriptObserved;this.gameInfo=gameInfo;',box);
return {set:(l,r=true)=>{lines=l;running=r;vm.runInContext("gameCache={key:'',info:null}",box)},read:()=>{let value;routes['/api/telemetry']({}, {setHeader:()=>{},json:x=>value=x});return value},box};}
const P='[12:00:00] [Render thread/INFO]: ';const J=P+'Joined world "synthetic"';const D=P+'Stopping!';const CONN=P+'Connecting to example.invalid, 25565';const STOP=P+'Stopping!';
const sample=(extra={})=>({v:2,ts:Date.now()/1000,session:'synthetic',seq:1,x:1,y:2,z:3,yaw:null,pitch:0,health:null,inventory:null,...extra});
test('telemetry freshness, join boundaries and unknown values',()=>{const h=harness();const line=x=>'TELEMETRY '+JSON.stringify(x);h.set([J,line(sample())]);assert.equal(h.read().status,'live');assert.equal(h.read().yaw,null);h.set([J,line(sample({ts:Date.now()/1000-20}))]);assert.equal(h.read().status,'stale');h.set([J,line(sample({ts:Date.now()/1000+10}))]);assert.equal(h.read().reason,'future-timestamp');h.set([J,line(sample()),D,J]);assert.equal(h.read().reason,'no-sample-since-join');h.set([J,line(sample())],false);assert.equal(h.read().reason,'not-joined');h.set([J,'TELEMETRY {broken']);assert.equal(h.read().reason,'invalid-sample');h.set([J,line(sample({x:null,y:null,z:null}))]);assert.equal(h.read().reason,'no-player-data');h.set([J,line(sample({inventory:[{name:'stone',count:'not-number'}]}))]);assert.equal(h.read().reason,'invalid-sample');});
test('script desired status is not positive running evidence',()=>{const h=harness();h.set([J]);assert.equal(h.box.scriptObserved('afk',h.box.gameInfo()).observed,'unknown');h.set([J,'SCRIPTBEAT '+JSON.stringify({name:'afk',session:'synthetic',ts:Date.now()/1000})]);assert.equal(h.box.scriptObserved('afk',h.box.gameInfo()).observed,'running');h.set([J,'SCRIPTBEAT '+JSON.stringify({name:'afk',session:'synthetic',ts:Date.now()/1000-60})]);assert.equal(h.box.scriptObserved('afk',h.box.gameInfo()).observed,'unknown');});
test('telemetry from before this dashboard started is a previous session',()=>{const h=harness();const line=x=>'TELEMETRY '+JSON.stringify(x);h.set([J,line(sample({ts:Date.now()/1000-300}))]);assert.equal(h.read().reason,'previous-session');});
test('script heartbeat: none, fresh, stale, before latest join, other script, bad shape',()=>{const h=harness();const beat=(n,ts,extra={})=>'SCRIPTBEAT '+JSON.stringify({name:n,session:'s',ts,...extra});const obs=(n='afk')=>h.box.scriptObserved(n,h.box.gameInfo());const now=()=>Date.now()/1000;
h.set([J]);assert.equal(obs().observedReason,'no-heartbeat-since-join');
h.set([J,beat('afk',now())]);assert.equal(obs().observed,'running');
h.set([J,beat('afk',now()-60)]);assert.equal(obs().observedReason,'stale-heartbeat');
h.set([J,beat('afk',now()),D,J]);assert.equal(obs().observedReason,'no-heartbeat-since-join');
h.set([J,beat('grinder',now())]);assert.equal(obs('afk').observed,'unknown');
h.set([J,'SCRIPTBEAT {broken']);assert.equal(obs().observedReason,'invalid-heartbeat');
h.set([J,beat('afk',now())],false);assert.equal(obs().observedReason,'game-stopped');});

test('chat / payload text cannot fake lifecycle lines (negative controls)',()=>{const h=harness();const line=x=>'TELEMETRY '+JSON.stringify(x);
h.set([J,line(sample()),P+'[CHAT] <friend> Joined you for dinner yesterday']);assert.equal(h.read().status,'live');
h.set([J,line(sample()),P+'[CHAT] <friend> Disconnecting now']);assert.equal(h.box.gameInfo().game,'in-world');assert.equal(h.read().status,'live');
h.set([J,P+'[CHAT] <friend> Connecting to my base']);assert.equal(h.box.gameInfo().game,'in-world');
h.set([J,line(sample({inventory:[{name:'Joined trophy',count:1}]}))]);assert.equal(h.read().status,'live');
h.set([J,line(sample({inventory:[{name:'Disconnecting stick',count:1}]}))]);assert.equal(h.read().status,'live');
h.set(['Joined',line(sample())]);assert.equal(h.box.gameInfo().game,'menu');});
test('grounded Connecting/Stopping! lines and a CONFIGURED join pattern change state (join pattern is synthetic, not observed)',()=>{const h=harness();h.set([J]);assert.equal(h.box.gameInfo().game,'in-world');h.set([J,CONN]);assert.equal(h.box.gameInfo().game,'connecting');h.set([J,D]);assert.equal(h.box.gameInfo().game,'menu');h.set([J,STOP]);assert.equal(h.box.gameInfo().game,'menu');h.set([P+'Player1[/1.2.3.4:5] logged in with entity id 7 at (0,0,0)']);assert.equal(h.box.gameInfo().game,'menu');h.set([P+'Loaded 1000 advancements']);assert.equal(h.box.gameInfo().game,'menu');h.set([P+'Disconnecting from server'],true);assert.equal(h.box.gameInfo().game,'menu');});
