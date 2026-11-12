'use client'

import Link from 'next/link'
import { DispatchNav } from './DispatchNav'
import { PrepickingChecklist } from './PrepickingChecklist'
import { DISPATCH_STAGES, type TaskStage } from '@/lib/warehouse/dispatch'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Camera, Check, Download, Loader2, PackagePlus, Play, Printer, RotateCcw, ScanLine, Truck, Undo2 } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'
import { pendingWarehouseScans, queueWarehouseScan, removeFailedWarehouseScan, syncWarehouseScans } from '@/lib/warehouse/offline'
import { Capacitor, registerPlugin } from '@capacitor/core'
import type { WarehouseScanOutbox } from '@/lib/offline/db'
import { GroupedBultoLabel } from '@/components/warehouse/GroupedBultoLabel'
import { fitScale, useLabelFormat } from '@/lib/warehouse/label-format'
import { AUDIT, STATE, buildBultoContentPdf, buildPackingListPdf, printPdf, fmt, fmtDate, itemLines, needsContentSheet, unitLabel, type LoadUnit, type BoardRow, type PackingSnapshot, type TaskLpn, type TaskLpns } from '@/lib/warehouse/packing-list'

const nativeWarehouseScanner = registerPlugin<{ scan: () => Promise<{ rawValue: string }> }>('WarehouseBarcodeScanner')
type BarcodeDetectorLike = { detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>> }
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike
const approved = ['APROBADA', 'APROBADO', 'ASIGNADA']
const btn = 'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-bold disabled:opacity-50'

export function TaskWorkspace({ id, stage }: { id: string; stage: TaskStage }) {
  const stageConfig = DISPATCH_STAGES[stage]
  const picking = stage === 'picking'
  const loadingStage = stage === 'carga'
  const { hasAccess } = usePermissions()
  const labelFormat = useLabelFormat('LPN')
  const [task, setTask] = useState<BoardRow | null>(null)
  const [data, setData] = useState<TaskLpns>({ lpns: [], loose: [], packing_lists: [] })
  const [units, setUnits] = useState<LoadUnit[]>([])
  const [loadUnit, setLoadUnit] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [camera, setCamera] = useState(false)
  const [pending, setPending] = useState<WarehouseScanOutbox[]>([])
  const [label, setLabel] = useState<TaskLpn | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const known = useRef<Set<string>>(new Set())

  const load = useCallback(async () => {
    const db = createClient()
    const [board, lpns, loadUnits] = await Promise.all([db.rpc('wh_task_board', { p_scope: 'tareas', p_task_id: id }), db.rpc('wh_task_lpns', { p_task_id: id }), db.rpc('wh_task_load_units', { p_task_id: id })])
    if (board.error || lpns.error || loadUnits.error) { setError((board.error || lpns.error || loadUnits.error)!.message); setLoading(false); return null }
    setUnits((loadUnits.data || []) as LoadUnit[])
    setTask(((board.data || []) as BoardRow[])[0] || null)
    const next = lpns.data as TaskLpns
    setData(next)
    // Lo recién escaneado queda seleccionado para consolidar; lo que salió de la lista, deseleccionado.
    const loose = new Set(next.loose.map(p => p.package_code))
    const added = [...loose].filter(c => !known.current.has(c))
    known.current = loose
    setSelected(prev => {
      const keep = new Set([...prev].filter(c => loose.has(c)))
      for (const c of added) keep.add(c)
      return keep
    })
    setLoading(false)
    return next
  }, [id])

  const syncQueue = useCallback(async () => {
    const result = await syncWarehouseScans(id)
    setPending(result.pending)
    if (result.synced) { setMessage(`${result.synced} lectura(s) offline sincronizadas.`); await load() }
    if (result.error) setError(`Lecturas pendientes: ${result.error}`)
  }, [id, load])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(); void syncQueue()
    const timer = window.setInterval(() => void load(), 15000)
    const online = () => void syncQueue()
    window.addEventListener('online', online)
    return () => { window.clearInterval(timer); window.removeEventListener('online', online); stream.current?.getTracks().forEach(t => t.stop()) }
  }, [load, syncQueue])

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) => {
    setBusy(true); setError(''); setMessage('')
    const { error } = await fn()
    if (error) setError(error.message); else { setMessage(ok); await load() }
    setBusy(false)
    return !error
  }
  const action = (name: string, ok: string, reason?: string) => run(() => createClient().rpc('wh_task_action', { p_task_id: id, p_action: name, p_reason: reason || null }), ok)

  const scan = async (e?: React.FormEvent, valueOverride?: string) => {
    e?.preventDefault()
    const value = (valueOverride ?? code).trim()
    if (!value || !task) return
    setBusy(true); setError(''); setMessage('')
    const db = createClient()
    const event = loadingStage ? 'LOAD' : 'PICK'
    if ((!picking && !loadingStage) || (picking && !['PICKING', 'PACKING'].includes(task.status)) || (loadingStage && (task.status !== 'READY_FOR_LOAD' || !data.packing_lists.some(p => p.status === 'LIBERADO')))) { setError('La etapa actual no permite esta lectura.'); setBusy(false); return }
    if (event === 'LOAD' && units.length && !loadUnit) { setError('Seleccione la unidad que se está cargando.'); setBusy(false); return }
    const { data: { user } } = await db.auth.getUser()
    const payload = { source: 'camera-or-keyboard', ...(event === 'LOAD' && loadUnit ? { load_unit_id: loadUnit } : {}) }
    const queue = async (text: string) => {
      if (!user) { setError('No hay sesión activa para guardar la lectura offline.'); return }
      await queueWarehouseScan({ profile_id: user.id, task_id: id, scanned_code: value, event_type: event, payload })
      setPending(await pendingWarehouseScans(id)); setMessage(text); setCode('')
    }
    if (!navigator.onLine) await queue('Lectura guardada en este dispositivo; se sincronizará al recuperar conexión.')
    else {
      const { error } = await db.rpc('wh_record_scan', { p_task_id: id, p_code: value, p_event: event, p_client_event_id: crypto.randomUUID(), p_payload: payload })
      if (error) {
        if (/fetch|network|timeout|load failed/i.test(error.message)) await queue('Conexión interrumpida. Lectura guardada para sincronización.')
        else setError(`${value}: ${error.message}`)
      } else { setMessage(`${value} ${event === 'PICK' ? 'recogido' : 'cargado'}.`); setCode(''); await load() }
    }
    setBusy(false)
    requestAnimationFrame(() => input.current?.focus())
  }

  // Ítems de la etiqueta del bulto agrupado, desde la versión recargada del LPN (producto + lote, cantidades sumadas).
  // Recién consolidado, el LPN impreso aún no trae autor, fecha ni paquetes: se toman de su versión recargada.
  const labelLpn = (label && data.lpns.find(l => l.id === label.id)) || label
  const labelItems = Object.values((labelLpn?.packages || []).reduce<Record<string, { key: string; product_code: string; lot: string | null; unit: string | null; quantity: number }>>((acc, p) => {
    const key = `${p.product_code}|${p.lot || ''}`
    acc[key] = { key, product_code: p.product_code, lot: p.lot, unit: p.unit, quantity: (acc[key]?.quantity || 0) + Number(p.quantity) }
    return acc
  }, {}))

  // Más de 4 ítems no caben en la etiqueta: se descarga la hoja de contenido (A5 o A4) para pegarla junto a ella.
  const contentSheet = async (l: TaskLpn) => {
    if (!task) return
    setError('')
    try {
      const { pdf, format } = await buildBultoContentPdf(l, task)
      pdf.save(`contenido-${l.lpn_code}.pdf`)
      setMessage(`El bulto ${l.lpn_code} tiene ${itemLines(l.packages)} ítems: se descargó su hoja de contenido (${format.toUpperCase()}) para imprimirla y pegarla junto a la etiqueta.`)
    } catch {
      setError(`El bulto ${l.lpn_code} está conservado. No se pudo descargar su hoja de contenido; vuelva a intentarlo con el botón Contenido.`)
    }
  }

  const printLabel = async (lpn: TaskLpn) => {
    const db = createClient()
    const { error } = lpn.print_count === 0
      ? await db.rpc('wh_print_lpn_label', { p_lpn_id: lpn.id })
      : await (async () => {
        const reason = window.prompt('Motivo de reimpresión de la etiqueta:')
        return reason?.trim() ? db.rpc('wh_reprint_lpn_label', { p_lpn_code: lpn.lpn_code, p_reason: reason }) : { error: { message: 'Reimpresión cancelada.' } }
      })()
    if (error) { setError(error.message); return }
    setLabel(lpn)
    // Con más de 4 ítems la etiqueta va con su hoja de contenido: se imprime a continuación, sin descargarla.
    window.setTimeout(() => { window.print(); void load(); if (needsContentSheet(lpn.packages) && task) void buildBultoContentPdf(lpn, task).then(({ pdf }) => printPdf(pdf, `contenido-${lpn.lpn_code}.pdf`)).catch(() => setError(`No se pudo imprimir la hoja de contenido de ${lpn.lpn_code}; use el botón Contenido.`)) }, 100)
  }

  const consolidate = async () => {
    const codes = [...selected]
    if (!codes.length) return
    setBusy(true); setError(''); setMessage('')
    try {
      const { data: lpn, error } = await createClient().rpc('wh_consolidate_lpn', { p_task_id: id, p_package_codes: codes, p_client_event_id: crypto.randomUUID() })
      if (error) { setError(error.message); return }
      setMessage(`LPN lógico ${lpn.lpn_code} creado con ${lpn.package_count} paquete(s). Conserve las etiquetas existentes; no necesita imprimir otra.`)
      // La RPC de consolidación solo devuelve totales; el detalle autorizado se obtiene al recargar.
      const refreshed = await load()
      const grouped = refreshed?.lpns.find(l => l.id === lpn.id)
      if (!grouped) {
        setError(`El LPN ${lpn.lpn_code} fue creado, pero no se pudo recuperar su contenido. Actualice la página y use el botón Contenido si tiene más de cuatro ítems.`)
        return
      }
      if (needsContentSheet(grouped.packages)) setMessage(m => `${m} Tiene ${itemLines(grouped.packages)} ítems: su hoja de contenido se imprimirá junto con la etiqueta del LPN.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      requestAnimationFrame(() => input.current?.focus())
    }
  }

  const undo = (lpn: TaskLpn) => {
    const reason = window.prompt(`Motivo para deshacer ${lpn.lpn_code} (los paquetes vuelven a "recogidos"):`)
    if (reason?.trim()) void run(() => createClient().rpc('wh_lpn_undo', { p_lpn_id: lpn.id, p_reason: reason }), `${lpn.lpn_code} deshecho.`)
  }
  const remove = (lpn: TaskLpn, pkg: string) => {
    const reason = window.prompt(`Motivo para quitar ${pkg} de ${lpn.lpn_code}:`)
    if (!reason?.trim()) return
    const release = window.confirm('¿Devolver el paquete a stock? (Aceptar = devolver a stock · Cancelar = queda recogido en esta tarea)')
    void run(() => createClient().rpc('wh_lpn_remove_package', { p_lpn_id: lpn.id, p_package_code: pkg, p_release: release, p_reason: reason }), `${pkg} retirado de ${lpn.lpn_code}.`)
  }
  const unitOf = (lpnId: string) => units.find(u => u.lpn_ids.includes(lpnId))
  const releasedSnapshot = async () => {
    const current = data.packing_lists.find(p => p.status === 'LIBERADO')
    if (!current) return null
    const { data: snapshot, error } = await createClient().rpc('wh_print_packing_list', { p_id: current.id })
    if (error) { setError(error.message); return null }
    return { current, snapshot: snapshot as PackingSnapshot }
  }
  const downloadPackingList = async () => {
    const r = await releasedSnapshot()
    if (r) (await buildPackingListPdf(r.snapshot)).save(`${r.current.packing_list_number}-v${r.current.version}.pdf`)
  }
  const startCamera = async () => {
    if (Capacitor.isNativePlatform()) {
      try { const result = await nativeWarehouseScanner.scan(); await scan(undefined, result.rawValue) }
      catch (e) { const text = e instanceof Error ? e.message : String(e); if (!/cancel/i.test(text)) setError(text) }
      return
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      // El <video> está siempre montado: antes solo existía tras setCamera(true) y la cámara nunca se conectaba
      stream.current = media; setCamera(true)
      if (!video.current) throw new Error('No se pudo mostrar la cámara.')
      video.current.srcObject = media; await video.current.play()
      // iPhone y Chrome en Windows no traen BarcodeDetector: se usa el lector ZXing (WebAssembly)
      const Detector = (window as Window & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector
        ?? (await import('barcode-detector/ponyfill')).BarcodeDetector as unknown as BarcodeDetectorConstructor
      const detector = new Detector({ formats: ['code_128', 'qr_code', 'ean_13', 'ean_8'] })
      const loop = async () => {
        if (!video.current || !stream.current) return
        try {
          const found = await detector.detect(video.current)
          if (found?.[0]?.rawValue) { stream.current.getTracks().forEach(t => t.stop()); stream.current = null; setCamera(false); await scan(undefined, found[0].rawValue); return }
        } catch {}
        requestAnimationFrame(() => void loop())
      }
      requestAnimationFrame(() => void loop())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo activar la cámara.')
      stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; setCamera(false)
    }
  }

  if (loading) return <div className="p-12 text-center text-slate-500"><Loader2 className="mx-auto animate-spin"/>Cargando tarea…</div>
  if (!task) return <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-rose-800">{error || 'No se encontró esta tarea.'} <Link href={stageConfig.path} className="underline">Volver a {stageConfig.title}</Link></div>

  const state = STATE[task.display_state] || { label: task.status, style: 'bg-slate-100 text-slate-700' }
  const pickPerm = ['almacen-picking', 'almacen-packing', 'almacen-supervisor'].some(hasAccess)
  const loadPerm = ['almacen-carga', 'almacen-supervisor'].some(hasAccess)
  const preparing = picking && pickPerm && ['PICKING', 'PACKING'].includes(task.status)
  const released = data.packing_lists.find(p => p.status === 'LIBERADO')
  const selection = data.loose.filter(p => selected.has(p.package_code))
  const lots = [task.contract_code, task.components, task.lots].filter(Boolean).join(' · ')

  return <div className="w-full space-y-4">
    <DispatchNav stage={stage} taskId={id}/>
    <h1 className="text-2xl font-black text-[#002855] print:hidden">{stageConfig.title}</h1>
    <p className="text-sm text-slate-600 print:hidden">{stageConfig.description}</p>
    <Link href={stageConfig.path} className="inline-flex items-center gap-2 text-sm font-semibold text-blue-800 print:hidden"><ArrowLeft size={16}/>{stageConfig.title}</Link>
    <header className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm print:hidden">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3 sm:gap-x-6">
          <div><dt className="text-xs text-slate-500">Solicitud</dt><dd className="text-lg font-black text-[#002855]">{task.request_number || task.task_code}</dd></div>
          <div><dt className="text-xs text-slate-500">OT / lote</dt><dd className="font-bold">{lots || '—'}</dd></div>
          <div><dt className="text-xs text-slate-500">Cliente</dt><dd className="font-semibold">{task.client_name || '—'}</dd></div>
          <div><dt className="text-xs text-slate-500">Responsable</dt><dd>{task.picker_name || '—'}</dd></div>
          <div><dt className="text-xs text-slate-500">Estado</dt><dd><span className={`rounded-full px-2 py-0.5 text-xs font-bold ${state.style}`}>{state.label}</span></dd></div>
          <div><dt className="text-xs text-slate-500">Inicio</dt><dd>{fmtDate(task.assigned_at)}</dd></div>
        </dl>
        <div className="flex flex-wrap gap-2">
          {picking && (hasAccess('almacen-picking') || hasAccess('almacen-supervisor')) && ['PENDING', 'PARTIAL'].includes(task.status) && <button disabled={busy || !approved.includes(task.request_status?.toUpperCase())} onClick={() => void action('START_PICKING', 'Picking iniciado.')} className={`${btn} bg-[#002855] text-white`}><Play size={16}/>Iniciar picking</button>}
          {picking && task.status === 'PAUSED' && hasAccess('almacen-supervisor') && <button disabled={busy} onClick={() => void action('RESUME', 'Picking reanudado.')} className={`${btn} bg-[#002855] text-white`}><Play size={16}/>Reanudar</button>}
          {preparing && <button disabled={busy || data.loose.length > 0 || data.lpns.length === 0} title={data.loose.length ? 'Consolide primero los paquetes recogidos' : ''} onClick={() => void action('FINISH_PICKING', 'Picking finalizado: queda en auditoría.')} className={`${btn} bg-emerald-700 text-white`}><Check size={16}/>Finalizar picking</button>}
          {picking && pickPerm && task.status === 'READY_FOR_LOAD' && !released && <button disabled={busy} onClick={() => void action('REOPEN_PICKING', 'Picking reabierto.')} className={`${btn} border border-slate-300`}><RotateCcw size={16}/>Reabrir picking</button>}
          {loadingStage && loadPerm && task.status === 'READY_FOR_LOAD' && released && <button disabled={busy} onClick={() => void action('LOAD', 'Carga confirmada.')} className={`${btn} bg-emerald-700 text-white`}><Truck size={16}/>Confirmar carga completa</button>}
          {loadingStage && loadPerm && task.status === 'READY_FOR_LOAD' && released && hasAccess('almacen-supervisor') && <button disabled={busy} onClick={() => { const r = window.prompt('Motivo y alcance de la excepción parcial:'); if (r?.trim()) void action('LOAD_PARTIAL', 'Carga parcial registrada.', r) }} className={`${btn} border border-amber-300 text-amber-900`}>Carga parcial</button>}
          {picking && hasAccess('almacen-supervisor') && ['PICKING', 'PACKING', 'READY_FOR_LOAD'].includes(task.status) && <button disabled={busy} onClick={() => { const r = window.prompt('Motivo de pausa:'); if (r?.trim()) void action('PAUSE', 'Tarea pausada.', r) }} className={`${btn} border border-amber-300 text-amber-900`}>Pausar</button>}
        </div>
      </div>
    </header>

    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 print:hidden">{error}</p>}
    {message && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 print:hidden">{message}</p>}
    {pending.length > 0 && <section className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 print:hidden">
      <div className="flex flex-wrap items-center justify-between gap-2"><b>{pending.length} lectura(s) pendientes de sincronizar en este dispositivo.</b><button onClick={() => void syncQueue()} className="rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-bold text-white">Sincronizar</button></div>
      {pending.map(row => <div key={row.client_event_id} className="mt-2 flex items-center justify-between gap-2 border-t border-amber-200 pt-2 text-xs"><span>{row.event_type} · {row.scanned_code}{row.last_error ? ` · ${row.last_error}` : ''}</span><button onClick={async () => { await removeFailedWarehouseScan(row.client_event_id); setPending(await pendingWarehouseScans(id)) }} className="underline">Descartar</button></div>)}
    </section>}

    {loadingStage && !released && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 print:hidden">La carga está bloqueada hasta finalizar Picking, aprobar todos los bultos y liberar el Packing List.</p>}
    {loadingStage && !units.length && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 print:hidden">Todavía no hay unidades de carga. <Link href={`/almacen/packing-list/${id}`} className="font-bold underline">Ir a Packing List</Link> para distribuir los bultos entre UT1, UT2 o placas.</p>}
    {picking && <PrepickingChecklist taskId={task.id} requestNumber={task.request_number} client={task.client_name}/>}
    {picking && <p className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 print:hidden">Auditoría puede revisar cada bulto cerrado mientras continúa la preparación. No necesita esperar al fin de Picking.</p>}

    {(preparing || (loadingStage && loadPerm && task.status === 'READY_FOR_LOAD' && released)) && <section className="rounded-xl border border-slate-200 bg-white p-4 print:hidden">
      {task.status === 'READY_FOR_LOAD' && units.length > 0 && <label className="mb-3 block text-sm font-semibold text-[#002855]">Unidad que se está cargando
        <select value={loadUnit} onChange={e => setLoadUnit(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-2 text-base">
          <option value="">Seleccione la unidad…</option>
          {units.map(u => <option key={u.id} value={u.id}>{unitLabel(u)} · cargados {u.loaded_count}/{u.lpn_count}</option>)}
        </select></label>}
      <form onSubmit={scan} className="flex gap-2">
        <input ref={input} value={code} onChange={e => setCode(e.target.value)} autoFocus inputMode="text" autoComplete="off" placeholder={task.status === 'READY_FOR_LOAD' ? 'Escanee LPN o paquete para cargar…' : 'Escanee el código del paquete o del LPN de recepción…'} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-3 text-base"/>
        <button disabled={busy || !code.trim()} className={`${btn} bg-[#002855] text-white`}>{busy ? <Loader2 size={17} className="animate-spin"/> : <ScanLine size={17}/>}<span className="hidden sm:inline">Registrar</span></button>
        <button type="button" aria-label={camera ? 'Cerrar cámara' : 'Escanear con cámara'} onClick={() => camera ? (stream.current?.getTracks().forEach(t => t.stop()), stream.current = null, setCamera(false)) : void startCamera()} className={`${btn} border border-slate-300`}><Camera size={17}/></button>
      </form>
      <video ref={video} playsInline muted className={camera ? 'mt-3 max-h-64 w-full rounded-lg bg-black object-contain' : 'hidden'}/>
    </section>}

    {preparing && <section className="overflow-hidden rounded-xl border border-slate-200 bg-white print:hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <h2 className="font-bold text-[#002855]">Recogidos sin consolidar ({data.loose.length})</h2>
        <button disabled={busy || !selection.length} onClick={() => void consolidate()} className={`${btn} bg-[#002855] text-white`}><PackagePlus size={16}/>Consolidar {selection.length} en LPN · {fmt(selection.reduce((s, p) => s + Number(p.quantity), 0), 3)} und · {fmt(selection.reduce((s, p) => s + Number(p.weight_kg || 0), 0))} kg</button>
      </header>
      {data.loose.length === 0 ? <p className="p-4 text-sm text-slate-500">Escanee paquetes: aparecerán aquí listos para consolidar.</p>
        : data.loose.map(p => <label key={p.package_code} className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-sm last:border-0">
          <input type="checkbox" className="h-5 w-5" checked={selected.has(p.package_code)} onChange={e => setSelected(prev => { const n = new Set(prev); if (e.target.checked) n.add(p.package_code); else n.delete(p.package_code); return n })}/>
          <span className="flex-1"><b className="font-mono">{p.package_code}</b><small className="ml-2 text-slate-500">{p.product_code} · {p.description}{p.lot ? ` · lote ${p.lot}` : ''}</small></span>
          <span className="whitespace-nowrap font-semibold">{fmt(p.quantity, 3)} {p.unit} · {p.weight_kg == null ? '—' : `${fmt(p.weight_kg)} kg`}</span>
        </label>)}
    </section>}

    {loadingStage && units.length > 0 && <section className="rounded-xl border border-slate-200 bg-white p-3 print:hidden"><h2 className="font-bold text-[#002855]">Unidades asignadas</h2><p className="text-sm text-slate-600">La distribución se gestiona desde Packing List.</p>{units.map(u => <p key={u.id} className="py-1 text-sm">{unitLabel(u)} · {u.lpn_count} LPN · {u.package_count} paquetes · {fmt(u.weight_kg)} kg · cargados {u.loaded_count}/{u.lpn_count}</p>)}</section>}

    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white print:hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <h2 className="font-bold text-[#002855]">LPN ({data.lpns.length})</h2>
        {released && <button onClick={() => void downloadPackingList()} className={`${btn} bg-emerald-700 text-white`}><Download size={16}/>Packing List {released.packing_list_number} v{released.version}</button>}
      </header>
      {data.lpns.length === 0 ? <p className="p-4 text-sm text-slate-500">Todavía no hay LPN.</p> : data.lpns.map(l => {
        const audit = AUDIT[l.audit_status] || AUDIT.PENDIENTE
        const issues = l.audits.filter(a => a.audit_rev === l.audit_rev && ['OBSERVADO', 'RECHAZADO', 'COMENTARIO'].includes(a.result))
        const editable = picking && pickPerm && ['OPEN', 'CLOSED'].includes(l.status) && ['PICKING', 'PACKING', 'READY_FOR_LOAD'].includes(task.status) && (l.audit_status !== 'APROBADO' || hasAccess('almacen-supervisor'))
        return <div key={l.id} className="border-b last:border-0">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
            <button onClick={() => setOpen(open === l.id ? '' : l.id)} className="font-mono font-bold text-[#002855] underline-offset-2 hover:underline">{l.lpn_code}</button>
            <span className="text-slate-600">{l.package_count} paq · {fmt(l.quantity, 3)} und · {fmt(l.weight_kg)} kg</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${audit.style}`}>{audit.label}</span>
            <span className="ml-auto flex flex-wrap items-center gap-1.5">
              {unitOf(l.id) && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold">{unitLabel(unitOf(l.id)!)}</span>}
              {picking && pickPerm && l.status === 'CLOSED' && <button disabled={busy} onClick={() => void printLabel(l)} className={`${btn} border border-slate-300 px-2 py-1 text-xs`}><Printer size={14}/>{l.print_count ? 'Reimprimir' : 'Etiqueta'}</button>}
              {picking && pickPerm && l.status === 'CLOSED' && needsContentSheet(l.packages) && <button disabled={busy} onClick={() => void contentSheet(l)} className={`${btn} border border-slate-300 px-2 py-1 text-xs`}><Download size={14}/>Contenido</button>}
              {editable && <button disabled={busy} onClick={() => undo(l)} className={`${btn} border border-slate-300 px-2 py-1 text-xs`}><Undo2 size={14}/>Deshacer</button>}
            </span>
          </div>
          {issues.map(a => <p key={a.id} className={`mx-3 mb-2 rounded-lg px-3 py-2 text-sm ${a.result === 'RECHAZADO' ? 'bg-rose-50 text-rose-900' : 'bg-amber-50 text-amber-950'}`}><b>{a.result === 'COMENTARIO' ? 'Comentario' : AUDIT[a.result]?.label}</b>{a.package_code ? ` · ${a.package_code}` : ''}: {a.comment || 'Ver evidencia'} <small className="text-slate-500">— {a.actor_name}, {fmtDate(a.created_at)}</small></p>)}
          {open === l.id && <div className="bg-slate-50 px-3 py-2">{l.packages.map(p => <div key={p.package_code} className="flex flex-wrap items-center gap-2 py-1 text-sm">
            <span className="font-mono">{p.package_code}</span><small className="flex-1 text-slate-500">{p.product_code} · {p.description}{p.lot ? ` · lote ${p.lot}` : ''}</small>
            <span>{fmt(p.quantity, 3)} {p.unit} · {p.weight_kg == null ? '—' : `${fmt(p.weight_kg)} kg`}</span>
            {editable && <button disabled={busy} onClick={() => remove(l, p.package_code)} className="text-xs font-semibold text-rose-700 underline">Quitar</button>}
          </div>)}</div>}
        </div>
      })}
    </section>

    {label && <div id="lpn-label" className="hidden print:block">
      <GroupedBultoLabel code={label.lpn_code} customer={task.client_name} contract={task.contract_code} request={task.request_number}
        items={labelItems} packages={label.package_count} weightKg={Number(label.weight_kg)} preparedBy={labelLpn?.created_by_name || null} date={labelLpn?.created_at || null}/>
    </div>}
    <style jsx global>{`@page{size:${labelFormat.width_mm}mm ${labelFormat.height_mm}mm;margin:0}@media print{body *{visibility:hidden}#lpn-label,#lpn-label *{visibility:visible}#lpn-label{position:fixed;left:0;top:0;width:152.4mm;height:101.6mm;overflow:hidden;box-sizing:border-box;padding:0;zoom:${fitScale(labelFormat, 152.4, 101.6)}}}`}</style>
  </div>
}
