const {test}=require('node:test')
const assert=require('node:assert/strict')
const {readFileSync}=require('node:fs')
const ts=require('typescript'),vm=require('node:vm'),React=require('react'),renderer=require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT=true
const source=file=>ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText
function reporterFixture(){
 let clock=Date.now(),failure=false;const calls=[]
 class Clock extends Date {static now(){return clock}}
 const context={exports:{},Date:Clock,navigator:{onLine:true}}
 vm.runInNewContext(source('src/lib/driver-presence.ts'),context)
 const reporter=context.exports.createDriverPresenceReporter({rpc:async(name,args)=>{calls.push({name,args});return{error:failure?'failed':null}}})
 return{reporter,calls,context,advance:n=>clock+=n,fail:v=>failure=v}
}
const position=(accuracy=15)=>({timestamp:Date.now(),coords:{latitude:-12,longitude:-77,accuracy,speed:null}})
test('connected without route/GPS; plate and driver identity cannot be supplied by the client',async()=>{
 const f=reporterFixture();await f.reporter.send();assert.equal(f.calls[0].name,'driver_app_heartbeat');assert.equal(f.calls[0].args.p_lat,null)
 assert.equal(f.calls[0].args.driver_id,undefined);assert.equal(f.calls[0].args.dispatch_id,undefined)
 f.reporter.position(position());await f.reporter.send();assert.equal(f.calls.length,1)
 f.advance(15000);await f.reporter.send();assert.equal(f.calls[1].args.p_lat,-12);assert.equal(f.calls[1].args.p_speed_mps,null)
})
test('denied GPS still reports connection; offline/cleanup stops sending; failed heartbeat can retry',async()=>{
 const f=reporterFixture();f.reporter.gps('denied');await f.reporter.send();assert.equal(f.calls[0].args.p_gps_state,'denied')
 f.advance(16000);f.context.navigator.onLine=false;await f.reporter.send();assert.equal(f.calls.length,1)
 f.context.navigator.onLine=true;f.fail(true);await f.reporter.send();f.fail(false);await f.reporter.send();assert.equal(f.calls.length,3)
 f.reporter.stop();f.advance(16000);await f.reporter.send(true);assert.equal(f.calls.length,3)
})
test('low-quality location does not invent a GPS position or speed',async()=>{
 const f=reporterFixture();f.reporter.position(position(3000));await f.reporter.send();assert.equal(f.calls[0].args.p_lat,null);assert.equal(f.calls[0].args.p_recorded_at,null)
})
test('monitor retains idle/stale positions, omits missing GPS, and never replaces unknown speed with zero',()=>{
 const context={exports:{},Date,Number,Math};vm.runInNewContext(source('src/lib/gps-monitor.ts'),context)
 const {monitorMarker,stateFor}=context.exports
 const row={id:'driver:x',driver_id:'x',driver:'Conductor',plate:null,operational_status:'SIN_RUTA',connected:true,gps_at:new Date().toISOString(),gps_fresh:true,lat:null,lng:null,speed:null,accuracy_m:15}
 assert.equal(monitorMarker(row),null)
 let marker=monitorMarker({...row,lat:-12,lng:-77});assert.equal(marker.speed,null);assert.equal(marker.status,'ubicacion');assert.equal(marker.operationalLabel,'Sin ruta')
 marker=monitorMarker({...row,lat:-12,lng:-77,gps_fresh:false,speed:40});assert.equal(marker.status,'sin_senal');assert.equal(marker.speed,null)
 assert.equal(stateFor({...row,operational_status:'ESPERANDO_GUIA'}).label,'En destino · esperando guía')
 assert.equal(monitorMarker({...row,lat:NaN,lng:-77}),null)
})
test('actual GPSGuard sends idle presence without entering route queue and cleans up watchers/timers',async()=>{
 const calls=[],writes=[],intervals=new Map(),events=new Map();let watch,unwatched=false,seq=0
 const f=reporterFixture()
 const client={rpc:async(name,args)=>{calls.push({name,args});return{error:null}},auth:{getUser:async()=>({data:{user:{id:'user'}}})},from:table=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:table==='drivers'?{id:'driver',is_active:true}:null}),in:()=>({order:()=>({limit:()=>({maybeSingle:async()=>({data:null})})})})})})})}
 const context={exports:{},navigator:{onLine:true,geolocation:{watchPosition:callback=>{watch=callback;return 1},clearWatch:()=>{unwatched=true}}},
  window:{setInterval:fn=>{intervals.set(++seq,fn);return seq},clearInterval:id=>intervals.delete(id),addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name),dispatchEvent(){}},
  localStorage:{getItem:()=>null,setItem:(...args)=>writes.push(args),removeItem(){}},CustomEvent:class{},console,Date,crypto:require('node:crypto').webcrypto,
  require:name=>name==='@/lib/supabase/client'?{createClient:()=>client}:name==='@/lib/driver-presence'?{createDriverPresenceReporter:()=>{const real=f.context.exports.createDriverPresenceReporter(client);return real}}:name==='@/lib/native-route-tracker'?{nativeRouteTracker:null}:name==='@/lib/route-point-sync'?{activeRouteKey:'active',readRouteQueue:()=>[],syncRoutePoints:async()=>{},routeQueueKey:'queue'}:require(name)}
 vm.runInNewContext(source('src/components/driver/GPSGuard.tsx'),context)
 let root;await renderer.act(async()=>{root=renderer.create(React.createElement(context.exports.default,{children:'App'}))})
 assert.equal(calls[0].name,'driver_app_heartbeat');assert.equal(typeof watch,'function')
 await renderer.act(async()=>watch(position()));assert.equal(writes.length,0)
 f.advance(16000);await renderer.act(async()=>{for(const fn of intervals.values())fn()})
 assert.ok(calls.some(c=>c.args.p_lat===-12));assert.equal(writes.length,0)
 await renderer.act(async()=>root.unmount());assert.equal(intervals.size,0);assert.equal(events.size,0);assert.equal(unwatched,true)
})
