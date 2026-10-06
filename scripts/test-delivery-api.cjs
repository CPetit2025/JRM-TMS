const {test}=require('node:test')
const assert=require('node:assert/strict')
const ts=require('typescript')
const vm=require('node:vm')
const {readFileSync}=require('node:fs')
const path=require('node:path')
const sharp=require('sharp')
const crypto=require('node:crypto').webcrypto
const token='a'.repeat(64),requestId='11111111-1111-4111-8111-111111111111',operationId='22222222-2222-4222-8222-222222222222'
function fixture(options={}) {
 const calls=[],uploaded=[]
 const context={exports:{},Buffer,File,FormData,crypto,process:{env:{SUPABASE_SERVICE_ROLE_KEY:'test',NEXT_PUBLIC_SUPABASE_URL:'https://example.test'}},
 require(name){
  if(name==='sharp')return sharp
  if(name==='next/server')return{NextResponse:{json:(body,settings)=>({body,...settings})}}
  if(name==='@supabase/supabase-js')return{createClient:()=>({
   rpc:async(name,args)=>{calls.push([name,args]);
    if(name==='delivery_public_authorize')return options.blocked?{error:{message:'Acceso bloqueado'}}:{data:{success:true,dispatch_id:'d1',duplicate:options.duplicate,submission_id:'s1'}}
    if(name==='delivery_public_submit')return{data:{success:true,pending_review:true,submission_id:'s1'}}
    return{data:{success:true,dispatch_id:'internal',paradas:[]}}
   },
   storage:{from:()=>({upload:async(name,bytes,settings)=>{uploaded.push({name,bytes,settings});return{error:null}}})}
  })}
  throw Error(name)
 }}
 const source=ts.transpileModule(readFileSync(path.join(__dirname,'../src/app/api/tercero/[token]/route.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText
 vm.runInNewContext(source,context)
 return{api:context.exports,calls,uploaded}
}
async function body(photos=[]) {
 const data=new FormData();data.set('accion','entrega');data.set('request_id',requestId);data.set('operation_id',operationId);data.set('recibido_por','Receptor')
 for(const photo of photos)data.append('foto',photo)
 return{formData:async()=>data,headers:new Headers()}
}
const params={params:Promise.resolve({token})}
test('portal bloqueado no sube archivos; recibo repetido confirma sin otra subida',async()=>{
 const blocked=fixture({blocked:true});assert.equal((await blocked.api.POST(await body(),params)).status,403);assert.equal(blocked.uploaded.length,0)
 const repeat=fixture({duplicate:true});const response=await repeat.api.POST(await body(),params);assert.equal(response.body.duplicate,true);assert.equal(repeat.uploaded.length,0)
})
test('fotos vacías, imagen falsa y exceso de tamaño no se registran',async()=>{
 for(const photos of [[],[new File(['not an image'],'fake.jpg',{type:'image/jpeg'})],[new File([new Uint8Array(4*1024*1024+1)],'large.jpg',{type:'image/jpeg'})]]){
  const f=fixture();const response=await f.api.POST(await body(photos),params);assert.ok(response.status>=400);assert.equal(f.uploaded.length,0);assert.equal(f.calls.some(c=>c[0]==='delivery_public_submit'),false)
 }
})
test('varias imágenes reales se decodifican sin metadatos y se envían como una versión pendiente',async()=>{
 const image=await sharp({create:{width:160,height:100,channels:3,background:'white'}}).png().withMetadata().toBuffer()
 const f=fixture();const response=await f.api.POST(await body([new File([image],'one.png',{type:'image/png'}),new File([image],'two.png',{type:'image/png'})]),params)
 assert.equal(response.body.pending_review,true);assert.equal(f.uploaded.length,2)
 for(const photo of f.uploaded){const meta=await sharp(photo.bytes).metadata();assert.equal(meta.format,'jpeg');assert.equal(meta.exif,undefined);assert.equal(photo.settings.upsert,false)}
 assert.equal(f.calls.at(-1)[1].p_photos.length,2);assert.equal(f.calls.at(-1)[1].p_operation,operationId)
})
test('consulta pública omite identificador interno y prohíbe cache/referrer',async()=>{
 const f=fixture();const response=await f.api.GET({},params);assert.equal(response.body.dispatch_id,undefined);assert.equal(response.headers['Cache-Control'],'no-store');assert.equal(response.headers['Referrer-Policy'],'no-referrer')
})

test('el enlace solo registra la guía: salida, llegada y Packing List se rechazan sin ejecutar RPC ni subir archivos',async()=>{
 for(const action of ['salida','llegada','packing_list']){
  const f=fixture(),data=new FormData();data.set('accion',action);data.set('request_id',requestId)
  const response=await f.api.POST({formData:async()=>data,headers:new Headers()},params)
  assert.equal(response.status,400);assert.equal(f.calls.length,0);assert.equal(f.uploaded.length,0)
 }
})
