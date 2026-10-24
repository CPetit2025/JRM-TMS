'use client'

import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, Upload, XCircle } from 'lucide-react'
import { ChartCard } from '@/components/apt/ui'
import { Table, td, tdNum, th } from '@/components/inventario/parts'
import { notifyInvUpdated } from '@/lib/inventario/api'
import { fmtN, fmtPeso } from '@/lib/inventario/format'
import { fmtDateTime } from '@/lib/apt/format'
import { uploadErpFile } from '@/lib/erp/api'
import { ERP_KIND_LABEL, parseErpWorkbooks, type ErpParseResult } from '@/lib/erp/parse'
import type { ErpEstado } from '@/lib/erp/types'

// Lee en un worker; si el navegador no puede crearlo, en el hilo principal
export function readErpFiles(files: File[], onProgress: (m: string) => void): Promise<ErpParseResult> {
  return new Promise((resolve, reject) => {
    const fallback = () => {
      setTimeout(async () => {
        try {
          const inputs = await Promise.all(files.map(async f => ({ name: f.name, data: await f.arrayBuffer() })))
          resolve(parseErpWorkbooks(inputs, onProgress))
        } catch (e) { reject(e) }
      }, 50)
    }
    let worker: Worker
    try { worker = new Worker(new URL('../../lib/erp/parse.worker.ts', import.meta.url), { type: 'module' }) } catch { fallback(); return }
    worker.onmessage = (e: MessageEvent<{ type: string; message?: string; result?: ErpParseResult }>) => {
      if (e.data.type === 'progress') onProgress(e.data.message || 'Leyendo…')
      else {
        worker.terminate()
        if (e.data.type === 'done' && e.data.result) resolve(e.data.result)
        else reject(new Error(e.data.message || 'No se pudo leer el archivo'))
      }
    }
    worker.onerror = ev => { ev.preventDefault(); worker.terminate(); fallback() }
    worker.postMessage({ files })
  })
}

const STALE_H = 24

export function ErpVigencia({ estado }: { estado: ErpEstado }) {
  const [now] = useState(() => Date.now())
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {(['CONTRATOS', 'STOCK'] as const).map(kind => {
        const a = estado.activas[kind]
        const hours = a?.cut_at ? (now - new Date(a.cut_at).getTime()) / 3600000 : null
        const s = (a?.summary || {}) as Record<string, number>
        return (
          <div key={kind} className={`rounded-xl border p-3 ${!a ? 'border-red-200 bg-red-50' : hours !== null && hours > STALE_H ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{ERP_KIND_LABEL[kind]}</p>
            {!a ? <p className="mt-1 text-sm font-semibold text-red-800">Sin cargar</p> : <>
              <p className="mt-1 text-sm font-semibold text-slate-900">Corte del ERP: {a.cut_at ? fmtDateTime(a.cut_at) : '—'}
                {hours !== null && hours > STALE_H && <span className="ml-2 text-xs font-bold text-amber-800">hace {Math.round(hours / 24 * 10) / 10} día(s): actualice el Excel</span>}</p>
              <p className="text-xs text-slate-600">{kind === 'CONTRATOS'
                ? `${fmtN(s.ots)} OT · ${fmtN(s.lineas)} líneas · ${fmtN(s.lineas_pendientes)} con pendiente · ${fmtN(s.guias)} guías`
                : `${fmtN(s.lotes)} lotes · ${fmtN(s.productos)} productos · ${fmtPeso(s.kg)}`}</p>
            </>}
          </div>
        )
      })}
    </div>
  )
}

export function ErpCarga({ estado }: { estado: ErpEstado }) {
  const input = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<ErpParseResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [results, setResults] = useState<Record<number, { ok: boolean; text: string }>>({})

  const pick = async (files: FileList | null) => {
    if (!files?.length) return
    setError(null); setDone(null); setParsed(null); setResults({})
    setBusy('Leyendo archivos…')
    try {
      const r = await readErpFiles([...files], m => setBusy(m))
      setParsed(r)
      if (r.errors.length) setError(r.errors.join(' '))
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo leer el archivo') } finally { setBusy(null) }
  }

  const upload = async () => {
    if (!parsed || busy || parsed.errors.length) return
    setError(null); setDone(null)
    const res = { ...results }
    const failed: string[] = []
    for (const [i, f] of parsed.files.entries()) {
      if (res[i]?.ok) continue
      try {
        const r = await uploadErpFile(f, m => setBusy(`${ERP_KIND_LABEL[f.kind]}: ${m}`))
        res[i] = { ok: true, text: `${fmtN(r.rows)} filas aplicadas` }
      } catch (e) {
        res[i] = { ok: false, text: e instanceof Error ? e.message : 'No se pudo cargar' }
        failed.push(`${ERP_KIND_LABEL[f.kind]}: ${res[i].text}`)
      }
      setResults({ ...res })
    }
    setBusy(null)
    notifyInvUpdated()
    if (failed.length) { setError(`No se aplicó: ${failed.join(' · ')}. Pulse «Reanudar carga» para completar solo lo pendiente.`); return }
    setDone('Carga aplicada: cada archivo reemplazó la foto anterior y se cruzó con las rutas del TMS.')
    setParsed(null); setResults({})
    if (input.current) input.current.value = ''
  }

  if (!estado.can_load) return null
  return (
    <ChartCard title="Cargar Excel del ERP" subtitle="Actualizable Despacho y Stock Bodega Despacho: en Excel, Datos › Actualizar todo, guarde y súbalos aquí (uno o los dos)">
      <div className="space-y-3">
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center hover:border-[#002855]">
          <FileSpreadsheet className="h-8 w-8 text-slate-400" />
          <span className="text-sm font-semibold text-slate-700">Seleccione Actualizable_Despacho.xlsx y/o StockBodegaDespacho.xlsx</span>
          <span className="text-xs text-slate-500">Cada carga es una foto completa: reemplaza a la anterior del mismo archivo</span>
          <input ref={input} type="file" accept=".xlsx,.xls" multiple className="sr-only" disabled={!!busy} onChange={e => pick(e.target.files)} />
        </label>
        {parsed && parsed.files.length > 0 && <div className="space-y-3">
          <Table head={<tr><th className={th}>Archivo</th><th className={th}>Tipo</th><th className={`${th} text-right`}>Filas</th><th className={th}>Corte del ERP</th><th className={th}>Resultado</th></tr>}>
            {parsed.files.map((f, i) => <tr key={i}>
              <td className={td}>{f.fileName} · {f.sheetName}</td><td className={`${td} font-semibold`}>{ERP_KIND_LABEL[f.kind]}</td>
              <td className={tdNum}>{fmtN(f.rows.length)}{f.kind === 'CONTRATOS' && <span className="block text-[11px] text-slate-500">{fmtN(f.stats.despachos)} despachos por guía</span>}</td>
              <td className={td}>{f.cutAt ? fmtDateTime(f.cutAt) : '—'}</td>
              <td className={`${td} text-xs`}>{results[i] ? <span className={`flex items-start gap-1 ${results[i].ok ? 'text-emerald-700' : 'text-red-700'}`}>
                {results[i].ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}{results[i].text}</span> : <span className="text-slate-400">Pendiente</span>}</td>
            </tr>)}
          </Table>
          {parsed.files.flatMap(f => f.warnings.map(w => `${ERP_KIND_LABEL[f.kind]}: ${w}`)).map((w, i) =>
            <p key={i} className="flex items-start gap-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{w}</p>)}
          <button type="button" onClick={upload} disabled={!!busy || parsed.errors.length > 0} className="flex min-h-11 items-center gap-2 rounded-lg bg-[#cf152d] px-5 text-sm font-bold text-white disabled:opacity-60">
            <Upload className="h-4 w-4" /> {Object.keys(results).length ? 'Reanudar carga' : 'Aplicar carga'}</button>
        </div>}
        {busy && <p className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />{busy}</p>}
        {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
        {done && <p className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />{done}</p>}
      </div>
    </ChartCard>
  )
}
