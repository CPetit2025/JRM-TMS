'use client'

import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, Upload } from 'lucide-react'
import { ChartCard, ErrorBlock, LoadingBlock } from '@/components/apt/ui'
import { Table, td, tdNum, th } from '@/components/inventario/parts'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { VerificationPanel } from '@/components/inventario/VerificationPanel'
import { syncLegacyApt } from '@/lib/inventario/legacy'
import { invApi, notifyInvUpdated, recalcular, uploadPart } from '@/lib/inventario/api'
import { CLASES, CLASE_LABEL, KINDS, KIND_LABEL, fmtN, fmtPeso } from '@/lib/inventario/format'
import { INV_SIDE_LABEL, parseInventoryWorkbooks, type InvParseResult } from '@/lib/inventario/parse'
import { fmtDate, fmtDateTime } from '@/lib/apt/format'

// Lee en un worker; si el navegador no puede crearlo, en el hilo principal
function readFiles(files: File[], onProgress: (m: string) => void): Promise<InvParseResult> {
  return new Promise((resolve, reject) => {
    const fallback = () => {
      setTimeout(async () => {
        try {
          const inputs = await Promise.all(files.map(async f => ({ name: f.name, data: await f.arrayBuffer() })))
          resolve(parseInventoryWorkbooks(inputs, onProgress))
        } catch (e) { reject(e) }
      }, 50)
    }
    let worker: Worker
    try { worker = new Worker(new URL('../../../../lib/inventario/parse.worker.ts', import.meta.url), { type: 'module' }) } catch { fallback(); return }
    worker.onmessage = (e: MessageEvent<{ type: string; message?: string; result?: InvParseResult }>) => {
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

// Cargas del inventario multi-almacén: reportes de Entradas y Salidas del ERP (todas las bodegas) y, opcional, una foto
// de stock para el saldo inicial. Cada lado reemplaza sus movimientos del rango de fechas del archivo.
export default function InventarioDatosPage() {
  const status = useInvQuery('status', () => invApi.status())
  const cats = useInvQuery('cats', () => invApi.catalogs())
  const ver = useInvQuery('verify', () => invApi.verify())
  const [files, setFiles] = useState<File[]>([])
  const input = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<InvParseResult | null>(null)
  const [cutoff, setCutoff] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [partial, setPartial] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const canLoad = status.data?.can_load ?? false

  const pick = async (files: FileList | null) => {
    if (!files?.length) return
    setError(null); setDone(null); setParsed(null); setPartial(false)
    setBusy('Leyendo archivos…')
    setFiles([...files])
    try { setParsed(await readFiles([...files], m => setBusy(m))) } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo leer el archivo') } finally { setBusy(null) }
  }
  const upload = async (force = false) => {
    if (!parsed || busy) return
    if (parsed.parts.some(p => p.side === 'STOCK') && !cutoff) { setError('Indique la fecha de corte de la foto de stock.'); return }
    setError(null); setPartial(false); setDone(null)
    try {
      for (const p of parsed.parts) {
        setBusy(`${INV_SIDE_LABEL[p.side]} · ${p.fileName}…`)
        await uploadPart(p, { cutoff, force, onProgress: m => setBusy(`${INV_SIDE_LABEL[p.side]}: ${m}`) })
      }
      const rb = await recalcular(m => setBusy(m))
      // Carga única: los mismos archivos actualizan el APT anterior (peso de servicios, guías, flota); no bloquea
      const legacy = parsed.parts.some(p => p.side !== 'STOCK') && files.length ? await syncLegacyApt(files, m => setBusy(m)) : null
      setDone(`Carga aplicada: ${parsed.parts.map(p => `${INV_SIDE_LABEL[p.side]} ${fmtN(p.rows.length)} filas`).join(' · ')}.`
        + (rb.pending ? ' El recálculo sigue en el servidor y termina solo en unos minutos (no vuelva a subir el archivo).' : '')
        + (legacy ? ` Aviso: servicios y guías no se actualizaron (${legacy}).` : ' Servicios, guías y flota también actualizados.'))
      setParsed(null)
      if (input.current) input.current.value = ''
    } catch (e) {
      setError(e instanceof Error && /statement timeout|canceling statement|timeout|fetch|network/i.test(e.message)
        ? 'La conexión o el procesamiento se interrumpió. Pulse «Reanudar carga» para continuar desde el último bloque confirmado, sin duplicar movimientos. Mantenga esta ventana abierta.'
        : e instanceof Error ? e.message : 'No se pudo cargar')
      setPartial(!!(e as { partial?: boolean }).partial)
      notifyInvUpdated()
    } finally { setBusy(null) }
  }
  const save = async (p: { bodega: string; kind: string } | { tipodocto: string; clase: string }) => {
    setError(null)
    try { await invApi.saveCatalog(p); cats.reload(); notifyInvUpdated() } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar') }
  }

  return (
    <div className="space-y-4">
      {canLoad && <ChartCard title="Cargar reportes del ERP" subtitle="Entradas y Salidas (todas las bodegas) y, si tiene, una foto de stock por bodega, producto y lote">
        <div className="space-y-3">
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center hover:border-[#002855]">
            <FileSpreadsheet className="h-8 w-8 text-slate-400" />
            <span className="text-sm font-semibold text-slate-700">Seleccione uno o varios .xlsx</span>
            <span className="text-xs text-slate-500">Columnas: TIPODOCTO, BODEGA, Numero, Fecha, Producto, GLOSA, Cantidad, UNIDAD, NumRel, Lote, PesoUnitario, PesoTotalProduccido…</span>
            <input ref={input} type="file" accept=".xlsx,.xls" multiple className="sr-only" disabled={!!busy} onChange={e => pick(e.target.files)} />
          </label>
          {parsed && <div className="space-y-3">
            <Table head={<tr><th className={th}>Tipo</th><th className={th}>Archivo · hoja</th><th className={`${th} text-right`}>Filas</th><th className={th}>Rango</th><th className={`${th} text-right`}>Peso</th><th className={th}>Bodegas</th></tr>}>
              {parsed.parts.map((p, i) => <tr key={i}>
                <td className={`${td} font-bold`}>{INV_SIDE_LABEL[p.side]}</td><td className={td}>{p.fileName} · {p.sheetName}</td><td className={tdNum}>{fmtN(p.rows.length)}</td>
                <td className={td}>{p.side === 'STOCK' ? <label className="text-xs">Corte <input type="date" value={cutoff} onChange={e => setCutoff(e.target.value)} className="ml-1 min-h-9 rounded border border-slate-300 px-2" /></label> : `${fmtDate(p.desde)} – ${fmtDate(p.hasta)}`}</td>
                <td className={tdNum}>{fmtPeso(p.kg)}</td><td className={`${td} max-w-96 text-[11px] text-slate-600`}>{p.bodegas.join(' · ')}</td>
              </tr>)}
            </Table>
            {parsed.warnings.map((w, i) => <p key={i} className="flex items-start gap-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{w}</p>)}
            {parsed.ignored.length > 0 && <p className="text-xs text-slate-500">Hojas no usadas: {parsed.ignored.map(g => `${g.sheetName} (${g.reason})`).join(' · ')}</p>}
            <p className="text-xs text-slate-500">Al aplicar, cada tipo reemplaza los movimientos que ya existen en su rango de fechas (no se duplican).</p>
            <button type="button" onClick={() => upload(false)} disabled={!!busy} className="flex min-h-11 items-center gap-2 rounded-lg bg-[#cf152d] px-5 text-sm font-bold text-white disabled:opacity-60"><Upload className="h-4 w-4" /> {error ? 'Reanudar carga' : 'Aplicar carga y recalcular'}</button>
          </div>}
          {busy && <p className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />{busy}</p>}
          {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}
            {partial && <button type="button" onClick={() => upload(true)} className="ml-2 font-bold underline">Reemplazar igualmente</button>}</div>}
          {done && <p className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />{done}</p>}
        </div>
      </ChartCard>}
      {ver.data && <VerificationPanel v={ver.data} full />}
      {status.loading ? <LoadingBlock /> : status.error ? <ErrorBlock message={status.error} onRetry={status.reload} /> : status.data && <>
        <ChartCard title="Cobertura de datos" subtitle={status.data.state.stats.segundos !== undefined ? `Último recálculo: ${fmtN(status.data.state.stats.movimientos)} movimientos, ${fmtN(status.data.state.stats.traspasos_enlazados)} traspasos enlazados, ${status.data.state.stats.segundos} s` : undefined}>
          <Table empty={!status.data.cobertura.length} head={<tr><th className={th}>Lado</th><th className={th}>Desde</th><th className={th}>Hasta</th><th className={`${th} text-right`}>Filas</th><th className={`${th} text-right`}>Días con movimiento</th></tr>}>
            {status.data.cobertura.map(c => <tr key={c.side}><td className={`${td} font-semibold`}>{INV_SIDE_LABEL[c.side]}</td><td className={td}>{fmtDate(c.desde)}</td><td className={td}>{fmtDate(c.hasta)}</td><td className={tdNum}>{fmtN(c.filas)}</td><td className={tdNum}>{fmtN(c.dias)}</td></tr>)}
          </Table>
          {status.data.huecos.map((h, i) => <p key={i} className="mt-2 flex items-center gap-2 text-xs text-amber-800"><AlertTriangle className="h-3.5 w-3.5" />{INV_SIDE_LABEL[h.side]}: sin movimientos del {fmtDate(h.desde)} al {fmtDate(h.hasta)} (¿falta cargar esas fechas?)</p>)}
        </ChartCard>
        <ChartCard title="Historial de cargas">
          <Table empty={!status.data.cargas.length} head={<tr><th className={th}>Fecha</th><th className={th}>Tipo</th><th className={th}>Archivo</th><th className={th}>Estado</th><th className={th}>Rango</th><th className={`${th} text-right`}>Filas</th><th className={`${th} text-right`}>Reemplazadas</th><th className={th}>Descartadas</th></tr>}>
            {status.data.cargas.map(c => <tr key={c.id}>
              <td className={td}>{fmtDateTime(c.applied_at ?? c.created_at)}</td><td className={td}>{INV_SIDE_LABEL[c.side]}</td><td className={`${td} max-w-72 truncate`} title={c.file_name}>{c.file_name}</td>
              <td className={td}>{c.status}</td><td className={td}>{c.side === 'STOCK' ? `Corte ${fmtDate(c.cutoff)}` : `${fmtDate(c.desde)} – ${fmtDate(c.hasta)}`}</td>
              <td className={tdNum}>{fmtN(c.filas)}</td><td className={tdNum}>{c.reemplazadas === null ? '—' : fmtN(c.reemplazadas)}</td>
              <td className={`${td} text-[11px] text-slate-500`}>{Object.entries(c.excluidas ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}</td>
            </tr>)}
          </Table>
        </ChartCard>
      </>}
      {cats.error && <ErrorBlock message="No se pudieron consultar los catálogos del inventario." onRetry={cats.reload} />}
      {cats.data && <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard title="Bodegas" subtitle="El tipo define la etapa en el flujo y qué se considera libre o comprometido" info="Las bodegas nuevas se clasifican solas por su nombre; corrija aquí si alguna quedó mal.">
          <Table head={<tr><th className={th}>Bodega</th><th className={`${th} text-right`}>Movimientos</th><th className={th}>Tipo</th></tr>}>
            {cats.data.bodegas.map(b => <tr key={b.code}>
              <td className={td}>{b.code}{b.auto && <span className="ml-1 text-[10px] text-slate-400">(automático)</span>}</td><td className={tdNum}>{fmtN(b.movimientos)}</td>
              <td className={td}><select aria-label={`Tipo de ${b.code}`} value={b.kind} disabled={!cats.data!.can_load} onChange={e => save({ bodega: b.code, kind: e.target.value })} className="min-h-9 rounded border border-slate-300 px-2 text-xs">
                {KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></td>
            </tr>)}
          </Table>
        </ChartCard>
        <ChartCard title="Tipos de documento" subtitle="La clase decide si es producción, compra, traspaso, despacho, consumo…" info="Al cambiar una clase el modelo queda pendiente de recalcular.">
          <Table head={<tr><th className={th}>TIPODOCTO</th><th className={`${th} text-right`}>Movimientos</th><th className={th}>Clase</th></tr>}>
            {cats.data.tipos.map(t => <tr key={t.tipodocto}>
              <td className={td}>{t.tipodocto}{t.auto && <span className="ml-1 text-[10px] text-slate-400">(automático)</span>}</td><td className={tdNum}>{fmtN(t.movimientos)}</td>
              <td className={td}><select aria-label={`Clase de ${t.tipodocto}`} value={t.clase} disabled={!cats.data!.can_load} onChange={e => save({ tipodocto: t.tipodocto, clase: e.target.value })} className="min-h-9 rounded border border-slate-300 px-2 text-xs">
                {CLASES.map(c => <option key={c} value={c}>{CLASE_LABEL[c]}</option>)}</select></td>
            </tr>)}
          </Table>
        </ChartCard>
      </div>}
    </div>
  )
}
