'use client'

import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, Upload, XCircle } from 'lucide-react'
import { ChartCard, ErrorBlock, LoadingBlock } from '@/components/apt/ui'
import { Table, td, tdNum, th } from '@/components/inventario/parts'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { VerificationPanel } from '@/components/inventario/VerificationPanel'
import { syncLegacyApt } from '@/lib/inventario/legacy'
import { syncAnalitica, syncPesoServicios } from '@/lib/inventario/vinculacion'
import { VinculacionPanel } from '@/components/inventario/VinculacionPanel'
import { invApi, notifyInvUpdated, recalcular, resetUpload as uploadsReset, uploadPart } from '@/lib/inventario/api'
import { CLASES, CLASE_LABEL, KINDS, KIND_LABEL, fmtN, fmtPeso } from '@/lib/inventario/format'
import { INV_SIDE_LABEL, parseInventoryWorkbooks, type InvParseResult } from '@/lib/inventario/parse'
import { fmtDate, fmtDateTime } from '@/lib/apt/format'
import Link from 'next/link'
import { ErpVigencia, readErpFiles } from '@/components/erp/ErpCarga'
import { erpAltaAutomatica, erpApi, erpDeriveEstado, erpLogError, erpSincronizarClientes, uploadErpFile } from '@/lib/erp/api'
import { derivarDia, type DeriveResumen } from '@/lib/erp/derive'
import { ERP_KIND_LABEL, type ErpParseResult } from '@/lib/erp/parse'

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

type PartResult = { ok: boolean; text: string }

const BASE_LABEL = { DATA: 'inventario calculado con el DATA', ERP: 'stock del día anterior', VACIA: 'sin base (primera carga)' } as const
function derivedText(r: DeriveResumen, avisos: string[]) {
  return `Movimientos del ${fmtDate(r.desde)} al ${fmtDate(r.hasta)} generados desde el ERP (base: ${BASE_LABEL[r.base_fuente]} al ${fmtDate(r.base_fecha)}): `
    + `${fmtN(r.guias)} guías (${fmtN(r.despachos)} líneas de despacho), ${fmtN(r.traspasos)} traspasos, ${fmtN(r.ingresos)} ingresos y ${fmtN(r.ajustes)} ajustes. `
    + 'Inventario, APT clásico, Analítica y peso de servicios actualizados.'
    + (r.bodegas_sin_stock.length ? ` Sin datos en el Stock: ${r.bodegas_sin_stock.join(', ')} (no se modifica).` : '')
    + (avisos.length ? ` ${avisos.join(' ')}` : '')
}

function errorText(e: unknown) {
  return e instanceof Error && /statement timeout|canceling statement|timeout|fetch|network/i.test(e.message)
    ? 'la conexión o el procesamiento se interrumpió (se reanuda desde el último bloque confirmado, sin duplicar)'
    : e instanceof Error ? e.message : 'no se pudo cargar'
}

// Cargas del inventario multi-almacén: reportes de Entradas y Salidas del ERP (todas las bodegas) y, opcional, una foto
// de stock para el saldo inicial. Cada lado reemplaza sus movimientos del rango de fechas del archivo.
export default function InventarioDatosPage() {
  const status = useInvQuery('status', () => invApi.status())
  const cats = useInvQuery('cats', () => invApi.catalogs())
  const ver = useInvQuery('verify', () => invApi.verify())
  const erpEstado = useInvQuery('erp-estado', () => erpApi.estado(), { keepPrevious: true })
  const derivados = useInvQuery('erp-derivados', () => erpDeriveEstado(), { keepPrevious: true })
  const regenerar = async () => {
    if (busy) return
    setError(null); setDone(null)
    try {
      const d = await derivarDia(m => setBusy(m))
      setDone(d ? derivedText(d.resumen, d.avisos) : 'Faltan los dos archivos del ERP (Actualizable y Stock).')
    } catch (e) { setError(errorText(e)) } finally { setBusy(null); notifyInvUpdated(); setLinked(k => k + 1); derivados.reload() }
  }
  const [files, setFiles] = useState<File[]>([])
  const input = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<InvParseResult | null>(null)
  // Actualizable Despacho y Stock Bodega Despacho: van a «ERP: OT, guías y stock», no al inventario
  const [erp, setErp] = useState<ErpParseResult | null>(null)
  const [erpDone, setErpDone] = useState<Record<number, PartResult>>({})
  const [cutoff, setCutoff] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [partial, setPartial] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [results, setResults] = useState<Record<number, PartResult>>({})
  const canLoad = status.data?.can_load ?? false
  const [linked, setLinked] = useState(0)

  const pick = async (files: FileList | null) => {
    if (!files?.length) return
    setError(null); setDone(null); setParsed(null); setPartial(false); setResults({}); setErp(null); setErpDone({})
    setBusy('Leyendo archivos…')
    setFiles([...files])
    try {
      const r = await readFiles([...files], m => setBusy(m))
      if (r.erpFiles.length) {
        const e = await readErpFiles([...files].filter(f => r.erpFiles.includes(f.name)), m => setBusy(m))
        setErp(e)
        if (e.errors.length) { setError(e.errors.join(' ')); void erpLogError('LECTURA', r.erpFiles.join(' · '), e.errors.join(' ')) }
      }
      setParsed(r)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'No se pudo leer el archivo'
      setError(msg)
      void erpLogError('LECTURA', [...files].map(f => f.name).join(' · '), msg)
    } finally { setBusy(null) }
  }
  const upload = async (force = false) => {
    if (!parsed || busy) return
    if (parsed.parts.some(p => p.side === 'STOCK') && !cutoff) { setError('Indique la fecha de corte de la foto de stock.'); return }
    setError(null); setPartial(false); setDone(null)
    // Excel del ERP primero: cada uno reemplaza su foto en «ERP: OT, guías y stock»
    const erpRes = { ...erpDone }
    const erpFailed: string[] = []
    for (const [i, f] of (erp?.files ?? []).entries()) {
      if (erpRes[i]?.ok) continue
      try {
        const r = await uploadErpFile(f, m => setBusy(`${ERP_KIND_LABEL[f.kind]}: ${m}`))
        // Con el Actualizable vigente se dan de alta las OT activas que faltan en el TMS y se corrige el cliente de las OT
        // según el RUC del ERP (con historial y aviso)
        const alta = f.kind === 'CONTRATOS' ? (setBusy('Dando de alta las OT activas del ERP que faltan en el TMS…'), await erpAltaAutomatica()) : null
        const cli = f.kind === 'CONTRATOS' ? (setBusy('Revisando el cliente de las OT con el ERP…'), await erpSincronizarClientes()) : null
        const altas = alta?.success ? alta.madres + alta.hijos : 0
        erpRes[i] = { ok: true, text: `${fmtN(r.rows)} filas aplicadas en ERP: OT, guías y stock${altas
          ? ` · ${fmtN(altas)} OT dadas de alta desde el ERP (${fmtN(alta!.madres)} madre, ${fmtN(alta!.hijos)} subcontratos/errores; sin partida)` : ''}${cli?.corregidas
          ? ` · cliente corregido en ${fmtN(cli.corregidas)} OT${cli.clientes_creados ? ` (${fmtN(cli.clientes_creados)} clientes registrados desde el ERP)` : ''}` : ''}` }
      } catch (e) {
        erpRes[i] = { ok: false, text: errorText(e) }
        erpFailed.push(`${ERP_KIND_LABEL[f.kind]}: ${errorText(e)}`)
      }
      setErpDone({ ...erpRes })
    }
    if (!parsed.parts.length) {
      if (erpFailed.length) { setBusy(null); notifyInvUpdated(); setError(`No se aplicó: ${erpFailed.join(' · ')}. Pulse «Reanudar carga» para completar solo lo pendiente.`); return }
      // Con los dos archivos vigentes se generan los movimientos del día para inventario, APT clásico y Analítica
      try {
        const d = await derivarDia(m => setBusy(m))
        setDone(d ? derivedText(d.resumen, d.avisos) : 'Archivo aplicado. Cargue también el otro archivo del ERP (Actualizable y Stock) para generar los movimientos del día.')
        setParsed(null); setErp(null); setErpDone({})
        if (input.current) input.current.value = ''
      } catch (e) {
        setError(`Los archivos quedaron cargados, pero no se generaron los movimientos del día: ${errorText(e)}. Use «Generar movimientos del día» para reintentar.`)
      } finally { setBusy(null); notifyInvUpdated(); setLinked(k => k + 1); derivados.reload() }
      return
    }
    // Cada parte (Entradas, Salidas, foto) se aplica por separado: si una falla, las demás siguen y se informa cuál falta
    const res: Record<number, PartResult> = { ...results }
    const failed: string[] = []
    let anyPartial = false
    for (const [i, p] of parsed.parts.entries()) {
      setBusy(`${INV_SIDE_LABEL[p.side]} · ${p.sheetName}…`)
      try {
        const r = await uploadPart(p, { cutoff, force, onProgress: m => setBusy(`${INV_SIDE_LABEL[p.side]} (${p.sheetName}): ${m}`) })
        const replaced = Number(r.replaced ?? 0)
        res[i] = { ok: true, text: `${fmtN(Number(r.rows ?? p.rows.length))} filas aplicadas${replaced ? ` · reemplazó ${fmtN(replaced)}` : ''}` }
      } catch (e) {
        anyPartial ||= !!(e as { partial?: boolean }).partial
        res[i] = { ok: false, text: errorText(e) }
        failed.push(`${INV_SIDE_LABEL[p.side]} (${p.sheetName}): ${errorText(e)}`)
      }
      setResults({ ...res })
    }
    try {
      failed.push(...erpFailed)
      if (failed.length) {
        setPartial(anyPartial)
        setError(`No se aplicó: ${failed.join(' · ')}. Lo demás quedó cargado; pulse «Reanudar carga» para completar solo lo pendiente.`)
        return
      }
      // Comprobación: cada lado cargado debe quedar en la base con el rango completo del archivo
      const st = await invApi.status()
      const missing = parsed.parts.filter(p => p.side !== 'STOCK' && p.desde && p.hasta
        && !st.cobertura.some(c => c.side === p.side && c.filas > 0 && c.desde <= p.desde! && c.hasta >= p.hasta!))
      if (missing.length) {
        setError(`La base no muestra ${missing.map(p => `${INV_SIDE_LABEL[p.side]} del ${fmtDate(p.desde)} al ${fmtDate(p.hasta)}`).join(' ni ')}. Vuelva a aplicar la carga.`)
        missing.forEach(p => { uploadsReset(p) })
        return
      }
      const rb = await recalcular(m => setBusy(m))
      // Carga única: los mismos archivos actualizan el APT anterior (peso de servicios, guías, flota); no bloquea
      const movFiles = files.filter(f => !parsed.erpFiles.includes(f.name))
      const movs = parsed.parts.some(p => p.side !== 'STOCK') && movFiles.length > 0
      const legacy = movs ? await syncLegacyApt(movFiles, m => setBusy(m)) : null
      // …y la Analítica APT y Distribución (cada archivo una vez) y el peso APT de los servicios
      const analitica = movs ? await syncAnalitica(movFiles, m => setBusy(m)) : null
      const peso = movs && !legacy ? await syncPesoServicios(m => setBusy(m)) : []
      setDone(`Carga aplicada y comprobada: ${parsed.parts.map(p => `${INV_SIDE_LABEL[p.side]} ${fmtN(p.rows.length)} filas`).join(' · ')}.`
        + (rb.pending ? ' El recálculo sigue en el servidor y termina solo en unos minutos (no vuelva a subir el archivo).' : '')
        + (!movs ? '' : legacy ? ` Aviso: el APT clásico, servicios y guías no se actualizaron (${legacy}).` : ' APT clásico, servicios, guías y flota también actualizados.')
        + (erp?.files.length ? ' Excel del ERP aplicados en ERP: OT, guías y stock.' : '')
        + (analitica ? ` Aviso: la Analítica no se actualizó (${analitica}).` : movs ? ' Analítica actualizada.' : '')
        + (peso.length ? ` ${peso.join(' ')}` : ''))
      setLinked(k => k + 1)
      setParsed(null); setResults({}); setErp(null); setErpDone({})
      if (input.current) input.current.value = ''
    } catch (e) {
      setError(errorText(e))
      setPartial(!!(e as { partial?: boolean }).partial)
    } finally { notifyInvUpdated(); setBusy(null) }
  }
  const save = async (p: { bodega: string; kind: string } | { tipodocto: string; clase: string }) => {
    setError(null)
    try { await invApi.saveCatalog(p); cats.reload(); notifyInvUpdated() } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar') }
  }

  return (
    <div className="space-y-4">
      {canLoad && <ChartCard title="Cargar datos del ERP" subtitle="Los dos Excel del ERP en una sola carga: Actualizable Despacho y Stock Bodega Despacho (actualícelos en Excel y súbalos juntos, una vez al día)">
        <div className="space-y-3">
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center hover:border-[#002855]">
            <FileSpreadsheet className="h-8 w-8 text-slate-400" />
            <span className="text-sm font-semibold text-slate-700">Seleccione Actualizable_Despacho.xlsx y StockBodegaDespacho.xlsx</span>
            <span className="max-w-3xl text-xs text-slate-500">Con los dos, el TMS genera los movimientos del día (despachos por guía, traspasos entre 647 · 540 · ST, ingresos y ajustes) y actualiza el inventario, la estadía, el APT clásico, la Analítica y el peso de los servicios.</span>
            <input ref={input} type="file" accept=".xlsx,.xls" multiple className="sr-only" disabled={!!busy} onChange={e => pick(e.target.files)} />
          </label>
          {parsed && (parsed.parts.length > 0 || !!erp?.files.length) && <div className="space-y-3">
            <Table head={<tr><th className={th}>Tipo</th><th className={th}>Archivo · hoja</th><th className={`${th} text-right`}>Filas</th><th className={th}>Rango</th><th className={`${th} text-right`}>Peso</th><th className={th}>Bodegas</th><th className={th}>Resultado</th></tr>}>
              {parsed.parts.map((p, i) => <tr key={i}>
                <td className={`${td} font-bold`}>{INV_SIDE_LABEL[p.side]}</td><td className={td}>{p.fileName} · {p.sheetName}</td><td className={tdNum}>{fmtN(p.rows.length)}</td>
                <td className={td}>{p.side === 'STOCK' ? <label className="text-xs">Corte <input type="date" value={cutoff} onChange={e => setCutoff(e.target.value)} className="ml-1 min-h-9 rounded border border-slate-300 px-2" /></label> : `${fmtDate(p.desde)} – ${fmtDate(p.hasta)}`}</td>
                <td className={tdNum}>{fmtPeso(p.kg)}</td><td className={`${td} max-w-96 text-[11px] text-slate-600`}>{p.bodegas.join(' · ')}</td>
                <td className={`${td} text-xs`}>{results[i] ? <span className={`flex items-start gap-1 ${results[i].ok ? 'text-emerald-700' : 'text-red-700'}`}>
                  {results[i].ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}{results[i].text}</span> : <span className="text-slate-400">Pendiente</span>}</td>
              </tr>)}
              {erp?.files.map((f, i) => <tr key={`erp${i}`} className="bg-sky-50/60">
                <td className={`${td} font-bold`}>ERP</td><td className={td}>{f.fileName} · {f.sheetName}</td><td className={tdNum}>{fmtN(f.rows.length)}</td>
                <td className={td} colSpan={3}>{ERP_KIND_LABEL[f.kind]}: se carga en <Link href="/apt/erp" className="font-semibold underline">ERP: OT, guías y stock</Link> (no es una foto del inventario)</td>
                <td className={`${td} text-xs`}>{erpDone[i] ? <span className={`flex items-start gap-1 ${erpDone[i].ok ? 'text-emerald-700' : 'text-red-700'}`}>
                  {erpDone[i].ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}{erpDone[i].text}</span> : <span className="text-slate-400">Pendiente</span>}</td>
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
      {erpEstado.data && <ErpVigencia estado={erpEstado.data} />}
      {derivados.data && <ChartCard title="Movimientos generados desde el ERP" subtitle="Un día por carga: lo que cambió en el stock y las guías nuevas respecto del día anterior"
        actions={canLoad ? <button type="button" onClick={() => void regenerar()} disabled={!!busy} className="rounded-lg border border-[#002855] px-3 py-1.5 text-xs font-semibold text-[#002855] disabled:opacity-60">Generar movimientos del día</button> : undefined}>
        <Table empty={!derivados.data.dias.length} head={<tr><th className={th}>Día</th><th className={th}>Base</th><th className={`${th} text-right`}>Guías</th><th className={`${th} text-right`}>Traspasos</th>
          <th className={`${th} text-right`}>Ingresos</th><th className={`${th} text-right`}>Ajustes</th><th className={th}>Bodegas</th><th className={th}>Generado</th></tr>}>
          {derivados.data.dias.map(d => d.es_base ? <tr key={d.fecha} className="text-slate-500"><td className={`${td} font-semibold`}>{fmtDate(d.fecha)}</td>
            <td className={td} colSpan={7}>Base inicial: {d.base_fuente === 'DATA' ? 'stock del inventario calculado con el DATA (Entradas y Salidas) hasta este día' : 'sin stock previo'}</td></tr>
            : <tr key={d.fecha}><td className={`${td} font-semibold`}>{fmtDate(d.fecha)}</td>
            <td className={td}>{BASE_LABEL[d.base_fuente]} ({fmtDate(d.base_fecha)})</td>
            <td className={tdNum}>{fmtN(d.resumen.guias)}</td><td className={tdNum}>{fmtN(d.resumen.traspasos)}</td><td className={tdNum}>{fmtN(d.resumen.ingresos)}</td><td className={tdNum}>{fmtN(d.resumen.ajustes)}</td>
            <td className={`${td} text-[11px]`}>{(d.resumen.bodegas || []).join(' · ')}</td><td className={td}>{fmtDateTime(d.created_at)}</td></tr>)}
        </Table>
      </ChartCard>}
      <VinculacionPanel canLoad={canLoad} reloadKey={linked} />
      {ver.data && <VerificationPanel v={ver.data} full />}
      {status.loading ? <LoadingBlock /> : status.error ? <ErrorBlock message={status.error} onRetry={status.reload} /> : status.data && <>
        <ChartCard title="Cobertura de datos" subtitle={status.data.state.stats.segundos !== undefined ? `Último recálculo: ${fmtN(status.data.state.stats.movimientos)} movimientos, ${fmtN(status.data.state.stats.traspasos_enlazados)} traspasos enlazados, ${status.data.state.stats.segundos} s` : undefined}>
          <Table empty={!status.data.cobertura.length} head={<tr><th className={th}>Lado</th><th className={th}>Desde</th><th className={th}>Hasta</th><th className={`${th} text-right`}>Filas</th><th className={`${th} text-right`}>Días con movimiento</th></tr>}>
            {status.data.cobertura.map(c => <tr key={c.side}><td className={`${td} font-semibold`}>{INV_SIDE_LABEL[c.side]}</td><td className={td}>{fmtDate(c.desde)}</td><td className={td}>{fmtDate(c.hasta)}</td><td className={tdNum}>{fmtN(c.filas)}</td><td className={tdNum}>{fmtN(c.dias)}</td></tr>)}
          </Table>
          {(['E', 'S'] as const).filter(side => !status.data!.cobertura.some(c => c.side === side && c.filas > 0)).map(side =>
            <p key={side} role="alert" className="mt-2 flex items-center gap-2 rounded-lg bg-red-50 p-2 text-xs font-semibold text-red-800"><XCircle className="h-3.5 w-3.5 shrink-0" />
              Faltan las {INV_SIDE_LABEL[side]}: el inventario no puede cuadrar sin ellas. Cargue el reporte (o la hoja) de {INV_SIDE_LABEL[side]} del mismo rango de fechas.</p>)}
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
