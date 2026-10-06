// Executes the actual validators, offline sync and PDF renderer.
const assert=require('node:assert/strict')
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path')
const {spawnSync}=require('node:child_process')
const ts=require('typescript'),{test}=require('node:test')
const root=path.resolve(__dirname,'..')
function module(file,imports={}) {
 const context={exports:{},require:name=>imports[name]||require(name),console,Date,Set,Promise,Number}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,resolveJsonModule:true}}).outputText,context)
 return context.exports
}
const format=require('../src/lib/preuse-format.json')
const preuse=module('src/lib/preuse.ts',{'./preuse-format.json':format})
const signature=[[{x:.1,y:.3},{x:.2,y:.4},{x:.4,y:.1},{x:.8,y:.6}]]
const answers=()=>format.items.map(item=>({code:item.code,response:'B',comment:''}))
test('official form has 34 mandatory independent B/M/R/N/A responses and normalized signature',()=>{
 assert.equal(format.items.length,34);assert.equal(format.code,'FR-DT 007');assert.equal(format.version,'01');assert.equal(format.formatDate,'22.01.14')
 assert.equal(format.items[0].text,'Sistema de Frenos');assert.equal(format.items[33].text,'Fajas de Amarre')
 assert.equal(preuse.validatePreuseAnswers(preuse.blankPreuseAnswers()),false)
 assert.equal(preuse.validatePreuseAnswers(answers()),true)
 assert.equal(preuse.validatePreuseAnswers(answers().slice(1)),false)
 const duplicate=answers();duplicate[0].code='i02';assert.equal(preuse.validatePreuseAnswers(duplicate),false)
 const legacy=answers();legacy[0].response='OK';assert.equal(preuse.validatePreuseAnswers(legacy),false)
 for(const value of ['B','M','R','N/A']) {const a=answers();a[0].response=value;assert.equal(preuse.validatePreuseAnswers(a),true)}
 assert.equal(preuse.validPreuseSignature(signature),true)
 assert.equal(preuse.validPreuseSignature([]),false)
 assert.equal(preuse.validPreuseSignature([[{x:4,y:0},{x:.2,y:.3},{x:.3,y:.3},{x:.4,y:.3}]]),false)
 assert.equal(preuse.limaDay(new Date('2026-10-07T03:00:00Z')),'2026-10-06')
})
test('sync requires server success, preserves owner/unit/date and serializes retries',async()=>{
 const {syncPreuseRecords}=module('src/lib/offline/preuse-sync.ts')
 const own={operation_id:'operation',profile_id:'owner',unit_revision:'unit-revision',captured_at:'2026-10-06T12:00:00Z',data:{answers:answers()},synced:0}
 const other={...own,operation_id:'other',profile_id:'another'}
 const calls=[],writes=[]
 let confirmed=false
 const dependencies={pending:async()=>[own,other],user:async()=> 'owner',submit:async row=>{calls.push(row);return confirmed?{data:{success:true},error:null}:{data:{success:false},error:null}},update:async(id,changes)=>writes.push({id,changes})}
 const first=await syncPreuseRecords(dependencies)
 assert.equal(first.pending,1);assert.equal(first.synced,0);assert.equal(writes[0].changes.synced,undefined);assert.equal(calls[0],own)
 confirmed=true;calls.length=0;writes.length=0
 const a=syncPreuseRecords(dependencies),b=syncPreuseRecords(dependencies);assert.equal(a,b)
 const result=await a;assert.equal(result.synced,1);assert.equal(calls.length,1);assert.equal(writes[0].id,'operation');assert.equal(writes[0].changes.synced,1)
 writes.length=0
 await syncPreuseRecords({...dependencies,submit:async()=>({data:{success:true},error:{message:'timeout'}})})
 assert.equal(writes[0].changes.synced,undefined);assert.equal(writes[0].changes.last_error,'timeout')
 writes.length=0
 await syncPreuseRecords({...dependencies,user:async()=>null});assert.equal(writes.length,0)
})
test('PDF gives each inspection/unit its own complete A4 form, preserving all original items and fields',()=>{
 const {drawPreusePage}=module('src/lib/preuse-pdf.ts',{'./preuse':preuse})
 const {jsPDF}=require('jspdf')
 const doc=new jsPDF({unit:'mm',format:'a4',compress:true})
 const logo='data:image/png;base64,'+fs.readFileSync(path.join(root,'public/logo-jrm.png')).toString('base64')
 const dates=['2026-10-06','2026-10-06','2026-10-07'],plates=['ABC-123','XYZ-456','ABC-123']
 for(let i=0;i<3;i++) {
  if(i)doc.addPage()
  drawPreusePage(doc,{operation_date:dates[i],vehicle_plate:plates[i],driver_name:'Conductor Prueba',license:'A-IIIc - LIC123',soat_expiration:'2027-01-01',technical_review_expiration:'2027-02-01',answers:answers().map((a,n)=>({...a,response:['B','M','R','N/A'][n%4],comment:n===0?'Comentario conservado':n===33?'Ultimo comentario':''})),vehicle_operational:i!==1,observation:'Observación de la inspección '+i,inspector_name:'Conductor Prueba',signature},logo)
 }
 assert.equal(doc.getNumberOfPages(),3)
 const file='/tmp/preuse-format-test.pdf';fs.writeFileSync(file,Buffer.from(doc.output('arraybuffer')))
 const parsed=spawnSync('pdftotext',['-layout',file,'-'],{encoding:'utf8'})
 assert.equal(parsed.status,0,parsed.stderr)
 const pages=parsed.stdout.split('\f').filter(page=>page.trim())
 assert.equal(pages.length,3)
 for(let i=0;i<3;i++) {
  const text=pages[i].replace(/\s+/g,' ')
  for(const item of format.items)assert.ok(text.includes(item.text),item.text)
  for(const field of [plates[i],'FR-DT 007','22.01.14','Página 1 de 1','Comentario conservado','Ultimo comentario','LIC123','Inspeccionado por','OHSAS 18001','Observación de la inspección '+i])assert.ok(text.includes(field),field)
 }
 const incomplete={answers:answers().slice(1)};assert.throws(()=>drawPreusePage(doc,incomplete),/34 ítems/)
})
