const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),XLSX=require('xlsx'),ExcelJS=require('exceljs')
const root=path.resolve(__dirname,'..'),crypto=require('node:crypto').webcrypto
const cache=new Map(),downloads=[],pdfs=[]
function load(rel){
 if(cache.has(rel))return cache.get(rel)
 const exports={},context={exports,require:n=>{
 if(n.startsWith('.'))return load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),n))+'.ts')
 if(n==='exceljs')return {Workbook:class extends ExcelJS.Workbook{addWorksheet(...args){const ws=super.addWorksheet(...args),add=ws.addRow.bind(ws);ws.addRow=r=>add(Array.from(r));return ws}}}
 if(n==='jspdf'){const real=require(n);return {jsPDF:class extends real.jsPDF{constructor(){super();this.save=()=>pdfs.push(this.output('arraybuffer'))}}}}
 return require(n)
 },Date,console,crypto,Blob,URL:{createObjectURL:blob=>{downloads.push(blob);return 'blob:test'},revokeObjectURL(){}},document:{createElement:()=>({click(){}})},setTimeout:fn=>fn()}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,rel),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context,{filename:rel})
 cache.set(rel,exports);return exports
}
function file(grid,{date1904=false,type='xlsx'}={}){
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(grid),'Asistencia')
 wb.Workbook={WBProps:{date1904}}
 const buf=XLSX.write(wb,{type:'buffer',bookType:type})
 return {name:'asistencia.'+(type==='biff8'?'xls':'xlsx'),size:buf.length,arrayBuffer:async()=>buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength)}
}
async function main(){
 const imp=load('src/lib/hhee/import.ts'),core=load('src/lib/hhee/core.ts'),report=load('src/lib/hhee/report.ts')
 const headers=['SOLICITUD','CODIGO_TRABAJADOR','INICIO','FIN','DESCANSO_MIN','HORAS_RECONOCIDAS','COSTO_PEN','RESULTADO','SUSTENTO','CONSENTIMIENTO']
 const row=['HE-000001','T001','2026-10-18 18:00','2026-10-18 20:30',30,2,'','Despacho realizado','Acta 1','SI']
 const p=await imp.parseAttendance(file([headers,row]));assert.equal(p.rows[0].start,'2026-10-18T18:00');assert.equal(p.rows[0].cost,null);assert.equal(p.rows[0].recognized_minutes,120);assert.equal(p.rows[0].consent,true);assert.match(p.file_hash,/^[a-f0-9]{64}$/)
 assert.equal((await imp.parseAttendance(file([headers,[...row.slice(0,6),'0',...row.slice(7)]]))).rows[0].cost,0)
 for(const [start,end] of [[0,1]]){
  const serial=(Date.UTC(2026,9,18,18)-Date.UTC(1899,11,30))/86400000
  for(const date1904 of [false,true])for(const type of ['xlsx','biff8']){
   const r=[...row];r[2]=serial-(date1904?1462:0);r[3]=serial+2.5/24-(date1904?1462:0)
   const parsed=await imp.parseAttendance(file([headers,r],{date1904,type}));assert.equal(parsed.rows[0].start,'2026-10-18T18:00',type+' / date1904 '+date1904);assert.equal(parsed.rows[0].end,'2026-10-18T20:30')
  }
 }
 const bad=[...row];bad[2]='2026-02-30 18:00';await assert.rejects(()=>imp.parseAttendance(file([headers,bad])),/Fecha inexistente/)
 const malformed=[...row];malformed[6]='12abc';await assert.rejects(()=>imp.parseAttendance(file([headers,malformed])),/Número inválido/)
 const missing=headers.filter(h=>h!=='INICIO');await assert.rejects(()=>imp.parseAttendance(file([missing,row])),/faltan columnas/)
 assert.throws(()=>imp.decimal('1,234.56'),/Número inválido/);assert.equal(imp.decimal('1,5'),1.5)
 assert.equal(core.limaDate(new Date('2026-10-19T02:00:00Z')),'2026-10-18')
 assert.equal(core.money(null),'Pendiente');assert.match(core.money(0),/0[.,]00/)
 const data={from:'2026-10-01',to:'2026-10-19',generated_at:'2026-10-19T16:00:00Z',total:1,row_limit:500,cost_visible:true,metrics:{validated_minutes:120,pending_minutes:60,validated_cost:null,pending_cost:1,prior_requests:0,executed_requests:1,pending_exceptions:1,justified_minutes:60,improvable_minutes:60,unassessed_minutes:0},
 areas:[{name:'Logística',hours:2,cost:null,pending_cost:1,targets_met:1,targets_defined:1}],causes:[{name:'Planificación',hours:2,cost:null}],rows:[{sequence:1,work_date:'2026-10-18',area_name:'Logística',state:'VALIDADA',approval:'APROBADA',activity:'Despacho',reference_code:'OT 12345',planned_minutes:120,approved_minutes:120,actual_minutes:120,validated_minutes:120,result_text:'Completado',assessment:'MEJORABLE',validated_cost:null,pending_cost:1}],actions:Array.from({length:30},(_,i)=>({area_name:'Logística',title:'Mejorar coordinación y disponibilidad de materiales '+i,assigned_name:'Responsable de prueba',due_date:'2026-10-25',state:'ABIERTA',conclusion:null,effective:null}))}
 const email=core.reportEmail(data);assert.match(email.body,/2 h/);assert.match(email.body,/Pendiente/);assert.doesNotMatch(email.body,/cpetit@|salario|remuneración/);assert.ok(email.body.endsWith('Atentamente,'))
 await report.exportReport(data,'excel');const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await downloads.pop().arrayBuffer()));assert.equal(wb.getWorksheet('Solicitudes').getCell('A2').value,'HE-000001');assert.equal(wb.getWorksheet('Resumen').getCell('B10').value,null)
 await report.exportReport({...data,cost_visible:false},'excel');const privateBook=new ExcelJS.Workbook();await privateBook.xlsx.load(Buffer.from(await downloads.pop().arrayBuffer()));assert.ok(!privateBook.getWorksheet('Solicitudes').getRow(1).values.some(v=>String(v).includes('Costo')))
 await report.exportReport(data,'pdf');assert.ok(pdfs[0].byteLength>3000);assert.match(Buffer.from(pdfs[0]).toString('latin1'),/\/Count [2-9]/)
 console.log('PASS HHEE: Excel XLS/XLSX/1904, fechas Lima, costo pendiente vs cero, privacidad de exportación y PDF multipágina.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
