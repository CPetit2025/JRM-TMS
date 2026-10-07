const assert=require('node:assert/strict'), XLSX=require('xlsx'), ExcelJS=require('exceljs')
const ts=require('typescript'), vm=require('node:vm'), fs=require('node:fs'), path=require('node:path'),{spawnSync}=require('node:child_process')
const root=path.resolve(__dirname,'..')
async function check() {
 assert.equal(XLSX.version,'0.20.3')
 const context={exports:{},require:n=>n==='xlsx'?XLSX:require(n),Date,console}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,'src/lib/apt/parseWorkbook.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context)
 for(const [type,date1904] of [['xlsx',false],['biff8',false],['xlsx',true]]) {
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([
   ['TIPODOCTO','BODEGA','Numero','Fecha','Producto','NumRel','PesoTotalProduccido','Cantidad'],
   ['P/E PRODUCCION','647-04 APT','E001',new Date(2026,9,6),'SKU-TEST','OT-1',125,1],
  ]),'ENTRADA')
  if(date1904){
   wb.Workbook={WBProps:{date1904:true}}
   // A 1904 workbook stores serials relative to 1904; Date-to-cell conversion defaults to 1900.
   wb.Sheets.ENTRADA.D2={t:'n',v:(Date.UTC(2026,9,6)-Date.UTC(1899,11,30))/86400000-1462,z:'yyyy-mm-dd'}
  }
  const bytes=XLSX.write(wb,{type:'buffer',bookType:type})
  const result=context.exports.parseWorkbooks([{name:'fixture.'+(type==='biff8'?'xls':'xlsx'),data:new Uint8Array(bytes)}])
  assert.equal(result.sheets[0].stats.validas,1)
  assert.equal(result.sheets[0].rows[0].Fecha,'2026-10-06',`${type} date1904=${date1904} ${process.env.TZ}`)
  assert.equal(result.sheets[0].stats.tn,0.125)
 }
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Exportación');sheet.addRow(['OT','Peso']);sheet.addRow(['16523',125])
 const loaded=new ExcelJS.Workbook();await loaded.xlsx.load(await book.xlsx.writeBuffer());assert.equal(loaded.getWorksheet(1).getCell('A2').value,'16523')
 // ExcelJS and Capacitor's Xcode integration use the preserved CommonJS UUID v4 API.
 const project=require('xcode').project('fixture.pbxproj');project.hash={project:{objects:{}}};assert.match(project.generateUuid(),/^[A-F0-9]{24}$/)
 console.log(`PASS: XLS/XLSX APT import dates, weight and ExcelJS export preserved (${process.env.TZ}).`)
}
if(process.argv.includes('--child'))check().catch(e=>{console.error(e);process.exitCode=1})
else for(const TZ of ['UTC','America/Lima','America/New_York']){
 const r=spawnSync(process.execPath,[__filename,'--child'],{env:{...process.env,TZ},encoding:'utf8'});process.stdout.write(r.stdout);assert.equal(r.status,0,r.stderr)
}
