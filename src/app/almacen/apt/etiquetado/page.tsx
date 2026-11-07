'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, Upload } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

type ReceiptRow = {
  source_key: string; document_no: string; source_date: string; document_type: string | null; warehouse: string; ruc: string | null; customer_name: string | null
  product_code: string; description: string | null; color: string | null; quantity: number; unit: string | null; lot: string | null
  origin_doc: string | null; origin_number: string | null; delivery_date: string | null; contract_code: string | null
  ref_doc_type: string | null; ref_correlation: string | null; ref_number: string | null; ref_date: string | null
  comment: string | null; unit_weight: number | null; total_weight: number | null; cost_center: string | null; source_updated_at: string | null
}
const keyOf = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s_./-]+/g, '').toLowerCase()
const text = (value: unknown) => value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim()
function date(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  if (typeof value === 'number') { const d = XLSX.SSF.parse_date_code(value); return d?.y ? `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}` : null }
  const v = String(value ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0,10)
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  return m ? `${m[3]}-${String(+m[2]).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}` : null
}
function dateTime(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'number') { const d = XLSX.SSF.parse_date_code(value); return d?.y ? new Date(Date.UTC(d.y,d.m-1,d.d,d.H,d.M,Math.floor(d.S))).toISOString() : null }
  const v = String(value ?? '').trim(); if (!v) return null
  const parsed = new Date(v); return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}
const number = (value: unknown) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const v = String(value ?? '').trim().replace(/,/g,'')
  return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null
}
async function sha256(data: ArrayBuffer | string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v=>v.toString(16).padStart(2,'0')).join('')
}
async function parseReceiptBook(file: File): Promise<ReceiptRow[]> {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
  const sheetName = workbook.SheetNames.find(name => keyOf(name) === 'entradaalmpt')
  if (!sheetName) throw new Error('No se encontró la hoja «Entrada ALM PT».')
  const sheet = workbook.Sheets[sheetName]
  const sourceRange = XLSX.utils.decode_range(sheet['!ref'] || 'A1')
  const columnZIndex = 25 - sourceRange.s.c
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true, blankrows: false })
  const headerIndex = matrix.slice(0,10).findIndex(row => {
    const headers = new Set(row.map(keyOf))
    return headers.has('nrodocumento') && headers.has('codproducto') && headers.has('cantidad') && headers.has('fecha')
  })
  if (headerIndex < 0) throw new Error('Faltan las columnas Nro_Documento, Cod_Producto, Cantidad o Fecha.')
  const headers = new Map((matrix[headerIndex] || []).map((value,index)=>[keyOf(value),index] as const))
  const get = (row: unknown[], key: string) => row[headers.get(key) ?? -1]
  const identityCounts = new Map<string,number>(), result: ReceiptRow[] = []
  for (const row of matrix.slice(headerIndex+1)) {
    const document = text(get(row,'nrodocumento')), product = text(get(row,'codproducto'))
    const qty = number(get(row,'cantidad')), sourceDate = date(get(row,'fecha')), warehouse = text(get(row,'bodega'))
    if (!document && !product && qty === null) continue
    if (!document || !product || !sourceDate || !warehouse || qty === null || qty <= 0) throw new Error(`Fila ${matrix.indexOf(row)+1}: requiere IPT, fecha, bodega, producto y cantidad positiva.`)
    const lot=text(get(row,'lote')), unit=text(get(row,'unidad')), description=text(get(row,'producto'))
    const originNumber=text(get(row,'nroorigen')), contract=text(get(row,'contrato'))
    // Column Z is the confirmed customer field in the APT workbook; keep header aliases
    // for future workbook versions and legacy Razon_Social as a final fallback.
    const customerName = text(row[columnZIndex]) ?? text(get(row,'cliente')) ?? text(get(row,'nombrecliente'))
      ?? text(get(row,'razonsocial')) ?? text(get(row,'clientetms'))
    const identity=JSON.stringify([document,sourceDate,warehouse,product,lot,unit,originNumber,contract])
    const occurrence=(identityCounts.get(identity)||0)+1; identityCounts.set(identity,occurrence)
    const source_key=await sha256(`${identity}#${occurrence}`)
    result.push({
      source_key, document_no:document, source_date:sourceDate, document_type:text(get(row,'tipodocumento')), warehouse, ruc:text(get(row,'ruc')), customer_name:customerName,
      product_code:product, description, color:text(get(row,'color')), quantity:qty, unit, lot, origin_doc:text(get(row,'docorigen')), origin_number:originNumber,
      delivery_date:date(get(row,'fechaentrega')), contract_code:contract, ref_doc_type:text(get(row,'reftipodocumento')),
      ref_correlation:text(get(row,'refcorrelativo')), ref_number:text(get(row,'refnumero')), ref_date:date(get(row,'reffecha')),
      comment:text(get(row,'comentario')), unit_weight:number(get(row,'pesounitario')), total_weight:number(get(row,'pesototal')),
      cost_center:text(get(row,'ccostojrm')), source_updated_at:dateTime(get(row,'fechaactualizacion')),
    })
  }
  if (!result.length) throw new Error('El libro no contiene ingresos con cantidad positiva.')
  return result
}

export default function WmsReceiptImportPage() {
  const fileInputRef = useRef<HTMLInputElement|null>(null)
  const [file,setFile]=useState<File|null>(null), [busy,setBusy]=useState(false), [error,setError]=useState(''), [done,setDone]=useState('')
  const [history,setHistory]=useState<{id:string;file_name:string;row_count:number;imported_at:string}[]>([])
  const [historyError,setHistoryError]=useState('')
  const loadHistory=useCallback(async()=>{
    const {data,error}=await createClient().from('wh_receipt_import_runs').select('id,file_name,row_count,imported_at').order('imported_at',{ascending:false}).limit(25)
    if(error)setHistoryError('No se pudo consultar el historial de importaciones.');else{setHistory(data||[]);setHistoryError('')}
  },[])
  useEffect(()=>{const timer=window.setTimeout(()=>void loadHistory(),0);return()=>window.clearTimeout(timer)},[loadHistory])
  const importFile=async()=>{
    if(!file||busy)return
    setBusy(true);setError('');setDone('')
    const attemptId=crypto.randomUUID()
    let fileHash:string|null=null, importHash:string|null=null, rowsRead:number|null=null
    const recordAttempt=async(status:'ACCEPTED'|'DUPLICATE'|'REJECTED',reason:string|null=null)=>{
      try{
        const audit=await createClient().rpc('wh_record_import_attempt',{p_attempt_id:attemptId,p_file_name:file.name,p_file_hash:fileHash,p_import_hash:importHash,p_status:status,p_rows_read:rowsRead,p_error:reason})
        if(audit.error)setHistoryError('No se pudo registrar el intento en auditoría. Conserve el resultado y avise a supervisión.')
      }catch{setHistoryError('No se pudo registrar el intento en auditoría. Conserve el resultado y avise a supervisión.')}
    }
    try{
      const bytes=await file.arrayBuffer()
      fileHash=await sha256(bytes)
      const rows=await parseReceiptBook(file)
      rowsRead=rows.length
      // Bump the importer version so an already-imported workbook is reprocessed once with column Z.
      const hash=await sha256(`${fileHash}:customer-column-z-v1`)
      importHash=hash
      const {data,error:rpcError}=await createClient().rpc('wh_import_receipt_snapshot',{p_file_name:file.name,p_file_hash:hash,p_rows:rows})
      if(rpcError)throw rpcError
      await loadHistory()
      await recordAttempt(data?.duplicate?'DUPLICATE':'ACCEPTED')
      const customerRows=rows.filter(row=>row.customer_name).length
      const customerSummary=`Clientes detectados en columna Z o encabezado equivalente: ${customerRows} de ${rows.length}.`
      setDone(data?.duplicate?`Este archivo ya estaba importado; no se duplicaron ingresos. ${customerSummary}`:`${Number(data?.rows||rows.length)} líneas importadas para Recepción y etiquetado. ${customerSummary} No se modificó el inventario multi‑almacén.`)
    }catch(e){
      const reason=e instanceof Error?e.message:typeof e==='object'&&e&&'message' in e?String(e.message):'No se pudo importar el Excel de ingresos.'
      setError(reason)
      await recordAttempt('REJECTED',reason)
    }
    finally{setBusy(false)}
  }
  return <div className="mx-auto max-w-4xl space-y-5">
    <header><p className="text-xs font-bold uppercase tracking-widest text-blue-700">WMS · Recepción</p><h1 className="mt-1 text-3xl font-black text-[#002855]">Actualizar ingresos para etiquetado</h1>
      <p className="mt-1 text-sm text-slate-600">Fuente exclusiva de recepción. Este libro no carga inventario, salidas ni analítica.</p></header>
    {error&&<p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900"><AlertTriangle className="mr-2 inline h-4 w-4"/>{error}</p>}
    {done&&<p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900"><CheckCircle2 className="mr-2 inline h-4 w-4"/>{done}</p>}
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="font-bold text-[#002855]">Actualizar ingresos WMS</h2><p className="mt-1 text-xs text-slate-500">La actualización manual importa el Excel que seleccione y conserva el historial de recepciones y etiquetas. Si el archivo ya fue importado, no duplica registros.</p></div>
        <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-900">Origen del robot: C:\WMS\entrada.xlsx</span>
      </div>
      <input ref={fileInputRef} id="wms-receipt-file" type="file" accept=".xlsx,.xls" className="sr-only" onChange={e=>{setFile(e.target.files?.[0]||null);setError('');setDone('')}}/>
      <div className="mt-4 flex flex-col gap-3 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3"><FileSpreadsheet className="h-8 w-8 shrink-0 text-slate-400"/><div className="min-w-0"><span className="block truncate text-sm font-semibold">{file?.name||'No hay archivo seleccionado'}</span><span className="text-xs text-slate-500">Excel .xlsx o .xls · hoja Entrada ALM PT · cliente en columna Z</span></div></div>
        <button type="button" onClick={()=>fileInputRef.current?.click()} className="min-h-10 shrink-0 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-[#002855]">Seleccionar Excel</button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" disabled={!file||busy} onClick={()=>void importFile()} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#cf152d] px-5 text-sm font-bold text-white disabled:opacity-50">
          {busy?<Loader2 className="h-4 w-4 animate-spin"/>:<Upload className="h-4 w-4"/>}{busy?'Actualizando…':'Actualizar manualmente'}
        </button>
        <p className="text-xs text-slate-500">La carga automática del archivo local la ejecuta el robot de Windows; el navegador no puede leer C:\WMS directamente.</p>
      </div>
    </section>
    <section className="rounded-xl border bg-white p-5"><h2 className="font-bold text-[#002855]">Historial de importaciones</h2>
      {historyError ? <p className="mt-2 text-sm text-rose-800">{historyError}</p> : <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Archivo</th><th className="p-2">Registros aceptados</th><th className="p-2">Fecha de importación</th></tr></thead><tbody>
        {history.map(run=><tr key={run.id} className="border-t"><td className="p-2">{run.file_name}</td><td className="p-2">{run.row_count}</td><td className="p-2">{new Date(run.imported_at).toLocaleString('es-PE')}</td></tr>)}
        {!history.length&&<tr><td colSpan={3} className="p-3 text-slate-500">Sin importaciones registradas.</td></tr>}
      </tbody></table></div>}
    </section>
  </div>
}
