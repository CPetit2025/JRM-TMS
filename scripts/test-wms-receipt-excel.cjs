const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const ts = require('typescript')
const vm = require('node:vm')
const XLSX = require('xlsx')
const source = readFileSync('src/app/almacen/apt/etiquetado/page.tsx','utf8')
const parser = "import * as XLSX from 'xlsx';\n" + source.slice(source.indexOf('type ReceiptRow'),source.indexOf('export default function')) + '\nexport {parseReceiptBook,sha256}'
const context={exports:{},require:name=>{assert.equal(name,'xlsx');return XLSX},crypto:require('node:crypto').webcrypto,TextEncoder,Uint8Array,Date}
vm.runInNewContext(ts.transpileModule(parser,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context)
const headers=['Nro_Documento','Cod_Producto','Cantidad','Fecha','Bodega','Lote','Unidad','Producto',...Array(17).fill(''),'Cliente']
function file(rows, sheet='Entrada ALM PT'){
 const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([headers,...rows]),sheet)
 const bytes=XLSX.write(workbook,{type:'array',bookType:'xlsx'})
 return {arrayBuffer:async()=>bytes}
}
async function main(){
 const row=['0000140557','CODE-1',900,'2026-11-07','PT','LOT-1','UND','Producto',...Array(17).fill(null),'Cliente columna Z']
 const f=file([row]);const result=await context.exports.parseReceiptBook(f)
 assert.equal(result.length,1);assert.equal(result[0].customer_name,'Cliente columna Z');assert.equal(result[0].document_no,'0000140557');assert.equal(result[0].quantity,900)
 const changed=[...row];changed[2]=899
 assert.equal((await context.exports.parseReceiptBook(file([changed])))[0].source_key,result[0].source_key)
 const repeated=await context.exports.parseReceiptBook(file([row,row]));assert.notEqual(repeated[0].source_key,repeated[1].source_key)
 await assert.rejects(context.exports.parseReceiptBook(file([row],'Incorrecta')),/hoja/)
 const invalid=[...row];invalid[2]=-1;await assert.rejects(context.exports.parseReceiptBook(file([invalid])),/positiva/)
 assert.equal(await context.exports.sha256(await f.arrayBuffer()),await context.exports.sha256(await f.arrayBuffer()))
 for(const input of process.argv.slice(2)){
  const bytes=readFileSync(input);const rows=await context.exports.parseReceiptBook({arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)})
  assert.equal(new Set(rows.map(row=>row.source_key)).size,rows.length)
  console.log(JSON.stringify({workbook:require('node:path').basename(input),rows:rows.length,customers:rows.filter(row=>row.customer_name).length,unique_keys:true}))
 }
 console.log('PASS: real XLSX parsing, column Z, leading-zero IPT, stable source key, distinct repeated lines, malformed sheet/negative quantity rejection, SHA-256 consistency.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
