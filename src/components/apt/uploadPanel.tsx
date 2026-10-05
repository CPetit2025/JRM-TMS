'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Info, Loader2, RefreshCw, Upload, X } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import { fmtDate, fmtInt, fmtTn } from '@/lib/apt/format'
import { APT_KINDS, APT_KIND_LABEL, MOTIVO_FUERA_APT, parseWorkbooks, type AptParseResult, type AptParsedSheet } from '@/lib/apt/parseWorkbook'
import type { AptCoverage, AptState, AptUploadSummary, AptUploadSummaryKey, AptUploadSummaryKind } from '@/lib/apt/types'
import { CoverageAlerts, KIND_STYLE } from './uploadCoverage'

// Carga diaria de ENTRADA / SALIDA / traspasos / consumos / devoluciones: lectura en el navegador (cada fila se enruta
// por TIPODOCTO), vista previa, envío por lotes y recálculo FIFO y del flujo multi-almacén

// Reducir el trabajo por petición del rol authenticated (límite de 8 s).
const BATCH = 250
const MAX_MB = 60
const MAX_FILES = 6
const RETRIES = 3

type Phase =
  | { step: 'idle' }
  | { step: 'reading'; message: string }
  | { step: 'preview'; files: File[]; result: AptParseResult }
  | { step: 'sending'; sent: number; total: number; kind: string; retry: number }
  | { step: 'applying' }
  | { step: 'rebuilding' }

// Lee en un worker; si el navegador no puede crearlo, lee en el hilo principal
function readFiles(files: File[], onProgress: (m: string) => void): Promise<AptParseResult> {
  return new Promise((resolve, reject) => {
    const fallback = () => {
      onProgress('Leyendo archivo…')
      setTimeout(async () => {
        try {
          const inputs = await Promise.all(files.map(async f => ({ name: f.name, data: await f.arrayBuffer() })))
          resolve(parseWorkbooks(inputs, onProgress))
        } catch (e) {
          reject(e)
        }
      }, 50)
    }
    let worker: Worker
    try {
      worker = new Worker(new URL('../../lib/apt/parseWorkbook.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      fallback()
      return
    }
    worker.onmessage = (e: MessageEvent<{ type: string; message?: string; result?: AptParseResult }>) => {
      const d = e.data
      if (d.type === 'progress') onProgress(d.message || 'Leyendo archivo…')
      else {
        worker.terminate()
        if (d.type === 'done' && d.result) resolve(d.result)
        else reject(new Error(d.message || 'No se pudo leer el archivo'))
      }
    }
    worker.onerror = ev => {
      ev.preventDefault()
      worker.terminate()
      fallback()
    }
    worker.postMessage({ files })
  })
}

const summaryKey = (k: (typeof APT_KINDS)[number]) => k.toLowerCase() as AptUploadSummaryKey

const isNetworkError = (msg: string) => /fetch|network|\bred\b|timeout|tiempo de espera|conexi|load failed|50[234]|gateway|aborted|statement timeout/i.test(msg)

async function withRetry<T>(fn: () => Promise<T>, onRetry: (n: number) => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (attempt >= RETRIES || !isNetworkError(msg)) throw e
      onRetry(attempt)
      await new Promise(r => setTimeout(r, 1500 * attempt))
    }
  }
}

const ORIGEN: Record<AptParsedSheet['detectedBy'], string> = {
  nombre: 'por nombre de hoja', encabezados: 'reconocida por sus columnas', tipodocto: 'filas enrutadas por TIPODOCTO',
}

// Vista previa: una fila por tipo de movimiento con lo que se enviará
function PreviewTable({ sheets }: { sheets: AptParsedSheet[] }) {
  const notes = sheets.flatMap(s => {
    const st = s.stats
    const excl = st.filas - st.validas
    const label = APT_KIND_LABEL[s.kind]
    const otros = Object.entries(st.descartadas).filter(([m]) => m !== MOTIVO_FUERA_APT)
    return [
      st.sinFecha > 0 && `${label}: ${fmtInt(st.sinFecha)} fila(s) sin fecha${st.totalizadoras > 0 ? ` (incluye ${fmtInt(st.totalizadoras)} totalizadora/vacía)` : ''}`,
      st.sinProducto > st.totalizadoras && `${label}: ${fmtInt(st.sinProducto - st.totalizadoras)} fila(s) con fecha pero sin producto`,
      excl > 0 && `${label}: ${fmtInt(excl)} fila(s) se guardarán como excluidas (se ven en Calidad de datos)`,
      st.sinPeso > 0 && `${label}: ${fmtInt(st.sinPeso)} fila(s) válidas sin PesoTotalProduccido (no suman TN)`,
      ...otros.map(([m, n]) => `${label}: ${fmtInt(n)} fila(s) descartadas (${m})`),
    ].filter((x): x is string => !!x)
  })
  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <tr className="border-b border-slate-200">
              <th className="px-3 py-2 text-left font-bold">Tipo de movimiento</th>
              <th className="px-2 py-2 text-left font-bold">Origen</th>
              <th className="px-2 py-2 text-right font-bold">Filas válidas</th>
              <th className="px-2 py-2 text-left font-bold">Fechas</th>
              <th className="px-2 py-2 text-right font-bold">TN</th>
              <th className="px-3 py-2 text-right font-bold" title="Filas de bodegas que no son 647, 540 ni ST VENTAS: no se envían">Descartadas por bodega</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sheets.map(s => {
              const st = s.stats
              return (
                <tr key={s.kind} className="hover:bg-slate-50">
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className={`flex items-center gap-2 text-xs font-black uppercase tracking-wider ${KIND_STYLE[s.kind].text}`}>
                      <span className={`h-2 w-2 rounded-full ${KIND_STYLE[s.kind].dot}`} />{APT_KIND_LABEL[s.kind]}
                    </span>
                  </td>
                  <td className="max-w-[260px] px-2 py-2 text-xs text-slate-500">
                    <span className="flex items-center gap-1.5 truncate" title={`${s.fileName} › ${s.sheetName} · encabezado en fila ${s.headerRow}`}>
                      <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                      <span className="truncate">“{s.sheetName}” · {ORIGEN[s.detectedBy]}</span>
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right font-bold tabular-nums text-slate-800">
                    {fmtInt(st.validas)}
                    {st.filas > st.validas && <span className="ml-1 text-[11px] font-normal text-amber-600" title="Filas que se guardan como excluidas">(+{fmtInt(st.filas - st.validas)})</span>}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums text-slate-700">{st.desde ? `${fmtDate(st.desde)} – ${fmtDate(st.hasta)}` : '—'}</td>
                  <td className="px-2 py-2 text-right font-semibold tabular-nums text-[#002855]">{fmtTn(st.tn)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${st.fueraApt ? 'text-slate-600' : 'text-slate-300'}`}>{fmtInt(st.fueraApt)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {notes.length > 0 && (
        <ul className="space-y-1 border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
          {notes.map(n => <li key={n} className={n.includes('excluidas') ? 'text-amber-700' : ''}>· {n}</li>)}
        </ul>
      )}
    </div>
  )
}

// Qué reportes del ERP subir cada día
function ReportHelp() {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
      <p className="flex items-center gap-1.5 font-bold text-slate-700"><Info className="h-3.5 w-3.5" /> Reportes del ERP a subir cada día</p>
      <ul className="mt-1.5 space-y-1">
        <li><b className={KIND_STYLE.ENTRADA.text}>ENTRADA</b>: P/E Producción (ingresos de producción al 647).</li>
        <li><b className={KIND_STYLE.SALIDA.text}>SALIDA</b>: Despacho ventas (guías al cliente).</li>
        <li>
          <b className={KIND_STYLE.TRASPASO_SAL.text}>Traspasos de almacén</b>: los dos reportes, <b>Salidas</b> y <b>Entradas</b>, del mismo rango de fechas
          (cada traspaso tiene un lado origen y un lado destino).
        </li>
        <li>
          <b className={KIND_STYLE.CONSUMO.text}>Opcional</b>: el reporte de salidas totales, para los consumos internos (V/C) y las guías de recojo.
          Si trae despachos o traspasos, se usan sin duplicar.
        </li>
      </ul>
      <p className="mt-1.5 text-slate-500">
        Puede subir varios archivos a la vez (hasta {MAX_FILES}). Cada fila se clasifica por TIPODOCTO y el signo de Cantidad, y solo se
        guardan las bodegas de APT (647, 540 y ST VENTAS).
      </p>
    </div>
  )
}

export function UploadPanel({ state }: { state: AptState | null }) {
  const [phase, setPhase] = useState<Phase>({ step: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [pendingRebuild, setPendingRebuild] = useState<string | null>(null)
  const [last, setLast] = useState<AptUploadSummary | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef(false)
  // Cobertura de fechas con la carga en vista previa: huecos, días a reemplazar y desfase ENTRADA/SALIDA
  const [cov, setCov] = useState<{ key: string; data: AptCoverage | null } | null>(null)
  const [ack, setAck] = useState('')
  const busy = phase.step === 'reading' || phase.step === 'sending' || phase.step === 'applying' || phase.step === 'rebuilding'

  // Evita cerrar la pestaña a mitad del envío
  useEffect(() => {
    if (phase.step !== 'sending' && phase.step !== 'applying' && phase.step !== 'rebuilding') return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [phase.step])

  const pick = async (list: FileList | File[] | null) => {
    const files = Array.from(list || [])
    if (!files.length || busy) return
    setError(null)
    setLast(null)
    if (files.length > MAX_FILES) return setError(`Seleccione hasta ${MAX_FILES} archivos (libro con ENTRADA y SALIDA, reportes de traspasos o de salidas totales).`)
    const bad = files.find(f => !/\.xlsx?$/i.test(f.name))
    if (bad) return setError(`${bad.name} no es un archivo de Excel (.xlsx o .xls).`)
    const big = files.find(f => f.size > MAX_MB * 1024 * 1024)
    if (big) return setError(`${big.name} supera ${MAX_MB} MB.`)
    setPhase({ step: 'reading', message: 'Leyendo archivo…' })
    try {
      const result = await readFiles(files, message => setPhase({ step: 'reading', message }))
      setPhase({ step: 'preview', files, result })
    } catch (e) {
      setPhase({ step: 'idle' })
      setError(e instanceof Error ? e.message : 'No se pudo leer el archivo')
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const confirm = async () => {
    if (phase.step !== 'preview') return
    const { files, result } = phase
    const total = result.sheets.reduce((a, s) => a + s.rows.length, 0)
    cancelRef.current = false
    setError(null)
    let id: string | null = null
    try {
      id = (await aptApi.uploadBegin(files.map(f => f.name).join(' + '))).id
      let sent = 0
      for (const s of result.sheets) {
        for (let i = 0; i < s.rows.length; i += BATCH) {
          if (cancelRef.current) throw new Error('Carga cancelada por el usuario. No se modificó ningún dato.')
          const batch = s.rows.slice(i, i + BATCH)
          const kind = APT_KIND_LABEL[s.kind]
          setPhase({ step: 'sending', sent, total, kind, retry: 0 })
          await withRetry(() => aptApi.uploadRows(id as string, s.kind, batch),
            n => setPhase({ step: 'sending', sent, total, kind, retry: n }))
          sent += batch.length
        }
      }
      setPhase({ step: 'applying' })
      const res = await aptApi.uploadApply(id)
      const sum = (res.summary || {}) as AptUploadSummary
      setLast(sum)
      setPhase({ step: 'idle' })
      const part = (k: string, x?: AptUploadSummaryKind) =>
        x ? `${k}: ${fmtInt(x.validas)} válidas, ${fmtInt(x.excluidas)} excluidas, ${fmtInt(x.reemplazadas)} reemplazadas, ${fmtTn(x.tn)} TN` : null
      if (res.warning) {
        setPendingRebuild(res.warning)
        toast.warning('Carga aplicada; recálculo pendiente', { description: 'No vuelva a subir el archivo. Use Reintentar recálculo.' })
      } else {
        setPendingRebuild(null)
        toast.success('Carga aplicada; FIFO y flujo multi-almacén recalculados', {
        description: APT_KINDS.map(k => part(APT_KIND_LABEL[k], sum[summaryKey(k)])).filter(Boolean).join(' · '),
        duration: 8000,
        })
      }
      window.dispatchEvent(new Event('apt:updated'))
    } catch (e) {
      if (id) await aptApi.uploadDiscard(id).catch(() => undefined)
      const msg = e instanceof Error ? e.message : 'No se pudo completar la carga'
      setError(msg)
      setPhase({ step: 'preview', files, result })
      toast.error('La carga no se aplicó', { description: msg })
    }
  }

  const preview = phase.step === 'preview' ? phase.result : null
  const previewRanges = Object.fromEntries((preview?.sheets || []).filter(s => s.stats.desde && s.stats.hasta)
    .map(s => [s.kind, { desde: s.stats.desde as string, hasta: s.stats.hasta as string }]))
  const covKey = preview ? JSON.stringify(previewRanges) : ''
  useEffect(() => {
    if (!covKey) return
    let alive = true
    aptApi.coverage(JSON.parse(covKey)).then(d => { if (alive) setCov({ key: covKey, data: d }) })
      .catch(() => { if (alive) setCov({ key: covKey, data: null }) })
    return () => { alive = false }
  }, [covKey])
  const coverage = cov?.key === covKey ? cov.data : null
  const blocking = !!coverage?.alertas.some(a => a.nivel !== 'info')
  const confirmed = !blocking || ack === covKey
  const rango = (s: AptParsedSheet) => `del ${fmtDate(s.stats.desde)} al ${fmtDate(s.stats.hasta)}`
  const replaceParts = (preview?.sheets || []).filter(s => !!s.stats.desde).map(s => ({ kind: s.kind, rango: rango(s) }))

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div>
          <h3 className="text-sm font-bold text-slate-800">Carga diaria de ENTRADA, SALIDA y traspasos</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Libro del ERP con las hojas ENTRADA y SALIDA (o archivos separados) y los reportes de traspasos de almacén. Puede ser el acumulado o solo los días nuevos.
          </p>
        </div>
        {state?.data_max && <span className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500">Datos actuales: {fmtDate(state.data_min)} – {fmtDate(state.data_max)}</span>}
      </header>

      <div className="space-y-4 p-4">
        {(phase.step === 'idle' || phase.step === 'reading') && (
          <div
            role="button" tabIndex={0} aria-label="Seleccionar archivos de Excel"
            onClick={() => !busy && inputRef.current?.click()}
            onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !busy) inputRef.current?.click() }}
            onDragOver={e => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files) }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-center transition-colors ${
              drag ? 'border-[#002855] bg-[#002855]/5' : 'border-slate-300 bg-slate-50 hover:border-[#002855]/50 hover:bg-slate-100/60'}`}>
            {phase.step === 'reading' ? (
              <>
                <Loader2 className="h-8 w-8 animate-spin text-[#002855]" />
                <p className="font-semibold text-slate-700">{phase.message}</p>
                <p className="text-xs text-slate-500">Un libro de ~15 MB tarda unos segundos.</p>
              </>
            ) : (
              <>
                <Upload className="h-8 w-8 text-slate-400" />
                <p className="font-semibold text-slate-700">Arrastre aquí el archivo o haga clic para seleccionarlo</p>
                <p className="text-xs text-slate-500">.xlsx o .xls · hasta {MAX_FILES} archivos · las hojas de análisis del libro se ignoran</p>
              </>
            )}
            <input ref={inputRef} type="file" accept=".xlsx,.xls" multiple className="hidden" onChange={e => pick(e.target.files)} />
          </div>
        )}

        {preview && (
          <div className="space-y-3">
            <PreviewTable sheets={preview.sheets} />
            {preview.warnings.map(w => (
              <p key={w} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
              </p>
            ))}
            {replaceParts.length > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-[#002855]/20 bg-[#002855]/5 px-3 py-2.5 text-sm text-[#002855]">
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Se reemplazarán los movimientos de{' '}
                  {replaceParts.map((p, i) => (
                    <Fragment key={p.kind}>{i > 0 && (i === replaceParts.length - 1 ? ' y de ' : ', de ')}<b>{APT_KIND_LABEL[p.kind]}</b> {p.rango}</Fragment>
                  ))}{' '}
                  ya cargados.
                  {' '}Los días fuera de ese rango se conservan.
                </p>
              </div>
            )}
            {coverage && <CoverageAlerts coverage={coverage} preview />}
            {blocking && (
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs text-slate-700">
                <input type="checkbox" className="mt-0.5 accent-[#cf152d]" checked={ack === covKey} onChange={e => setAck(e.target.checked ? covKey : '')} />
                Entiendo que la secuencia de fechas queda incompleta y quiero cargar este archivo de todos modos (podré subir las fechas faltantes después).
              </label>
            )}
            {preview.ignored.length > 0 && (
              <details className="text-xs text-slate-400">
                <summary className="cursor-pointer select-none">Hojas o partes no usadas ({preview.ignored.length})</summary>
                <ul className="mt-1 space-y-0.5 pl-3">
                  {preview.ignored.map((i, n) => (
                    <li key={n}>· {i.reason.startsWith(i.sheetName) ? i.reason : `${i.sheetName}: ${i.reason}`} <span className="text-slate-300">({i.fileName})</span></li>
                  ))}
                </ul>
              </details>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button onClick={() => { setPhase({ step: 'idle' }); setError(null) }}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                Cancelar
              </button>
              <button onClick={confirm} disabled={!confirmed}
                className="flex items-center gap-1.5 rounded-lg bg-[#cf152d] px-4 py-2 text-sm font-bold text-white shadow-sm hover:bg-[#b01226] disabled:cursor-not-allowed disabled:opacity-50">
                <CheckCircle2 className="h-4 w-4" /> Confirmar carga ({fmtInt(preview.sheets.reduce((a, s) => a + s.rows.length, 0))} filas)
              </button>
            </div>
          </div>
        )}

        {phase.step === 'sending' && (
          <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 font-semibold text-slate-700">
                <Loader2 className="h-4 w-4 animate-spin text-[#002855]" /> Enviando {phase.kind || 'filas'}…
              </span>
              <span className="tabular-nums text-slate-600">{fmtInt(phase.sent)} / {fmtInt(phase.total)} filas</span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-[#002855] transition-all duration-300" style={{ width: `${phase.total ? (phase.sent / phase.total) * 100 : 0}%` }} />
            </div>
            {phase.retry > 0 && <p className="text-xs text-amber-700">Falla de red: reintento {phase.retry} de {RETRIES - 1}…</p>}
            <div className="flex justify-end">
              <button onClick={() => { cancelRef.current = true }} className="text-xs font-semibold text-slate-500 hover:text-red-600">Cancelar envío</button>
            </div>
          </div>
        )}

        {(phase.step === 'applying' || phase.step === 'rebuilding') && (
          <div className="flex items-center gap-3 rounded-xl border border-[#002855]/20 bg-[#002855]/5 p-4 text-sm text-[#002855]">
            <Loader2 className="h-5 w-5 animate-spin" />
            <div>
              <p className="font-bold">Recalculando FIFO y flujo multi-almacén…</p>
              <p className="text-xs">{phase.step === 'rebuilding' ? 'Actualizando la estadía y el flujo de los movimientos ya guardados. No se vuelve a cargar el archivo.' : 'Aplicando la carga y actualizando la estadía y el flujo. Puede tardar unos segundos.'}</p>
            </div>
          </div>
        )}

        {pendingRebuild && (
          <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <p>{pendingRebuild}</p>
            <p>No vuelva a cargar el archivo: los movimientos ya fueron guardados.</p>
            <button type="button" disabled={busy} className="mt-2 min-h-11 rounded-lg border border-amber-400 px-3 font-semibold disabled:opacity-50"
              onClick={async () => {
                setPhase({ step: 'rebuilding' })
                try {
                  await aptApi.rebuildModels()
                  setPendingRebuild(null)
                  toast.success('Estadía y flujo recalculados')
                  window.dispatchEvent(new Event('apt:updated'))
                } catch (e) {
                  setPendingRebuild(`La carga sigue aplicada. ${e instanceof Error ? e.message : 'No se pudo recalcular'}`)
                } finally { setPhase({ step: 'idle' }) }
              }}>Reintentar recálculo</button>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="flex-1">{error}</p>
            <button onClick={() => setError(null)} aria-label="Cerrar mensaje" className="text-red-400 hover:text-red-700"><X className="h-4 w-4" /></button>
          </div>
        )}

        {last && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
            <p className="flex items-center gap-2 font-bold"><CheckCircle2 className="h-4 w-4" /> Carga aplicada</p>
            {APT_KINDS.map(kind => {
              const x = last[summaryKey(kind)]
              return x && (
                <p key={kind} className="mt-1 text-xs tabular-nums">
                  <b>{APT_KIND_LABEL[kind]}</b>: {fmtInt(x.validas)} válidas · {fmtInt(x.excluidas)} excluidas ·{' '}
                  {fmtInt(x.reemplazadas)} reemplazadas · {fmtTn(x.tn)} TN · {fmtDate(x.desde)} – {fmtDate(x.hasta)}
                </p>
              )
            })}
          </div>
        )}

        {phase.step === 'idle' && !last && !error && <ReportHelp />}
        {phase.step === 'idle' && !last && !error && (
          <p className="flex items-start gap-2 text-xs text-slate-500">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Las cargas se consolidan: cada una reemplaza, por tipo, solo el rango de fechas que trae el archivo y conserva el resto
            (por ejemplo, 02/01–30/09 y luego 01/10–10/10 quedan como 02/01–10/10). El sistema alerta si la secuencia de fechas se rompe.
          </p>
        )}
      </div>
    </section>
  )
}
