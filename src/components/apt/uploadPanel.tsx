'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Info, Loader2, RefreshCw, Upload, X } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import { fmtDate, fmtInt, fmtTn } from '@/lib/apt/format'
import { parseWorkbooks, type AptParseResult, type AptParsedSheet } from '@/lib/apt/parseWorkbook'
import type { AptCoverage, AptState, AptUploadSummaryKind } from '@/lib/apt/types'
import { CoverageAlerts } from './uploadCoverage'

// Carga diaria de ENTRADA / SALIDA: lectura en el navegador, vista previa, envío por lotes y recálculo FIFO

const BATCH = 1000
const MAX_MB = 60
const RETRIES = 3

type Phase =
  | { step: 'idle' }
  | { step: 'reading'; message: string }
  | { step: 'preview'; files: File[]; result: AptParseResult }
  | { step: 'sending'; sent: number; total: number; kind: string; retry: number }
  | { step: 'applying' }

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

function SheetCard({ s }: { s: AptParsedSheet }) {
  const st = s.stats
  const excl = st.filas - st.validas
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`text-xs font-black uppercase tracking-wider ${s.kind === 'ENTRADA' ? 'text-blue-700' : 'text-teal-700'}`}>
            {s.kind === 'ENTRADA' ? 'ENTRADA · P/E Producción' : 'SALIDA · Despacho Ventas'}
          </p>
          <p className="mt-0.5 truncate text-xs text-slate-500" title={`${s.fileName} › ${s.sheetName}`}>
            Hoja “{s.sheetName}” de {s.fileName} · encabezado en fila {s.headerRow}{s.detectedBy === 'encabezados' ? ' · reconocida por sus columnas' : ''}
          </p>
        </div>
        <FileSpreadsheet className="h-5 w-5 shrink-0 text-slate-300" />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div><dt className="text-[11px] uppercase text-slate-400">Filas</dt><dd className="font-bold tabular-nums text-slate-800">{fmtInt(st.filas)}</dd></div>
        <div><dt className="text-[11px] uppercase text-slate-400">Con fecha y producto</dt><dd className="font-bold tabular-nums text-slate-800">{fmtInt(st.validas)}</dd></div>
        <div><dt className="text-[11px] uppercase text-slate-400">TN</dt><dd className="font-bold tabular-nums text-[#002855]">{fmtTn(st.tn)}</dd></div>
        <div><dt className="text-[11px] uppercase text-slate-400">Fechas</dt><dd className="font-semibold tabular-nums text-slate-700">{fmtDate(st.desde)} – {fmtDate(st.hasta)}</dd></div>
      </dl>
      {(excl > 0 || st.sinPeso > 0) && (
        <ul className="mt-3 space-y-1 border-t border-slate-100 pt-2 text-xs text-slate-600">
          {st.sinFecha > 0 && <li>· {fmtInt(st.sinFecha)} fila(s) sin fecha{st.totalizadoras > 0 ? ` (incluye ${fmtInt(st.totalizadoras)} totalizadora/vacía)` : ''}</li>}
          {st.sinProducto > st.totalizadoras && <li>· {fmtInt(st.sinProducto - st.totalizadoras)} fila(s) con fecha pero sin producto</li>}
          {excl > 0 && <li className="text-amber-700">· {fmtInt(excl)} fila(s) se guardarán como excluidas (se ven en Calidad de datos)</li>}
          {st.sinPeso > 0 && <li>· {fmtInt(st.sinPeso)} fila(s) válidas sin PesoTotalProduccido (no suman TN)</li>}
        </ul>
      )}
    </div>
  )
}

export function UploadPanel({ state }: { state: AptState | null }) {
  const [phase, setPhase] = useState<Phase>({ step: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [last, setLast] = useState<{ entrada?: AptUploadSummaryKind; salida?: AptUploadSummaryKind } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef(false)
  // Cobertura de fechas con la carga en vista previa: huecos, días a reemplazar y desfase ENTRADA/SALIDA
  const [cov, setCov] = useState<{ key: string; data: AptCoverage | null } | null>(null)
  const [ack, setAck] = useState('')
  const busy = phase.step === 'reading' || phase.step === 'sending' || phase.step === 'applying'

  // Evita cerrar la pestaña a mitad del envío
  useEffect(() => {
    if (phase.step !== 'sending' && phase.step !== 'applying') return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [phase.step])

  const pick = async (list: FileList | File[] | null) => {
    const files = Array.from(list || [])
    if (!files.length || busy) return
    setError(null)
    setLast(null)
    if (files.length > 2) return setError('Seleccione uno o dos archivos (libro con ENTRADA y SALIDA, o un archivo por hoja).')
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
          setPhase({ step: 'sending', sent, total, kind: s.kind, retry: 0 })
          await withRetry(() => aptApi.uploadRows(id as string, s.kind, batch),
            n => setPhase({ step: 'sending', sent, total, kind: s.kind, retry: n }))
          sent += batch.length
        }
      }
      setPhase({ step: 'applying' })
      const res = await aptApi.uploadApply(id)
      const sum = (res.summary || {}) as { entrada?: AptUploadSummaryKind; salida?: AptUploadSummaryKind }
      setLast(sum)
      setPhase({ step: 'idle' })
      const part = (k: string, x?: AptUploadSummaryKind) =>
        x ? `${k}: ${fmtInt(x.validas)} válidas, ${fmtInt(x.excluidas)} excluidas, ${fmtInt(x.reemplazadas)} reemplazadas, ${fmtTn(x.tn)} TN` : null
      toast.success('Carga aplicada y FIFO recalculado', {
        description: [part('ENTRADA', sum.entrada), part('SALIDA', sum.salida)].filter(Boolean).join(' · '),
        duration: 8000,
      })
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
  const ent = preview?.sheets.find(s => s.kind === 'ENTRADA')
  const sal = preview?.sheets.find(s => s.kind === 'SALIDA')
  const rango = (s?: AptParsedSheet) => (s?.stats.desde ? `del ${fmtDate(s.stats.desde)} al ${fmtDate(s.stats.hasta)}` : null)
  const replaceParts = [ent, sal].filter((s): s is AptParsedSheet => !!s?.stats.desde).map(s => ({ kind: s.kind, rango: rango(s) }))

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div>
          <h3 className="text-sm font-bold text-slate-800">Carga diaria de ENTRADA y SALIDA</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Libro del ERP con las hojas ENTRADA y SALIDA, o dos archivos separados. Puede ser el acumulado o solo los días nuevos.
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
                <p className="text-xs text-slate-500">.xlsx o .xls · uno o dos archivos · las hojas de análisis del libro se ignoran</p>
              </>
            )}
            <input ref={inputRef} type="file" accept=".xlsx,.xls" multiple className="hidden" onChange={e => pick(e.target.files)} />
          </div>
        )}

        {preview && (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              {preview.sheets.map(s => <SheetCard key={s.kind} s={s} />)}
            </div>
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
                    <Fragment key={p.kind}>{i > 0 && ' y de '}<b>{p.kind}</b> {p.rango}</Fragment>
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
              <p className="text-xs text-slate-400">Hojas ignoradas: {preview.ignored.map(i => i.sheetName).join(', ')}.</p>
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

        {phase.step === 'applying' && (
          <div className="flex items-center gap-3 rounded-xl border border-[#002855]/20 bg-[#002855]/5 p-4 text-sm text-[#002855]">
            <Loader2 className="h-5 w-5 animate-spin" />
            <div>
              <p className="font-bold">Recalculando FIFO…</p>
              <p className="text-xs">Reemplazando el rango de fechas y reasignando salidas a ingresos. Puede tardar unos segundos.</p>
            </div>
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
            {(['entrada', 'salida'] as const).map(k => last[k] && (
              <p key={k} className="mt-1 text-xs tabular-nums">
                <b className="uppercase">{k}</b>: {fmtInt(last[k]!.validas)} válidas · {fmtInt(last[k]!.excluidas)} excluidas ·{' '}
                {fmtInt(last[k]!.reemplazadas)} reemplazadas · {fmtTn(last[k]!.tn)} TN · {fmtDate(last[k]!.desde)} – {fmtDate(last[k]!.hasta)}
              </p>
            ))}
          </div>
        )}

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
