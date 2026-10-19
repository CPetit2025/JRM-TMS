'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Boxes, CalendarClock, Camera, FileUp, Loader2, RefreshCw } from 'lucide-react'
import { INV_UPDATED, invApi, recalcular } from '@/lib/inventario/api'
import type { InvStatus } from '@/lib/inventario/types'
import { useAmbito } from './ambito'
import { fmtDate, fmtDateTime } from '@/lib/apt/format'

// Cabecera de la sección Inventario multi-almacén: rango de datos, foto de stock, estado del recálculo y carga
export function InvHeader() {
  const [st, setSt] = useState<InvStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const apt = useAmbito() === 'apt'
  useEffect(() => {
    let alive = true
    const load = () => { invApi.status().then(s => { if (alive) setSt(s) }).catch(() => { if (alive) setSt(null) }) }
    load()
    window.addEventListener(INV_UPDATED, load)
    return () => { alive = false; window.removeEventListener(INV_UPDATED, load) }
  }, [])
  const s = st?.state
  const run = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await recalcular()
      if (r.pending) setMsg('El recálculo continúa en el servidor y termina solo en unos minutos.')
    } catch (e) { setMsg(e instanceof Error ? e.message : 'No se pudo recalcular') } finally { setBusy(false) }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-[#002855] to-[#0b3d7a] text-white shadow">
          <Boxes className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-lg font-black tracking-tight text-slate-900">Inventario multi‑almacén</h1>
          <p className="text-xs text-slate-500">{apt ? 'APT: almacenes 647 · 540 · ST' : 'Todas las bodegas del ERP'} · Stock disponible, contratos / OT, estadía, trazabilidad de lotes y flujo entre almacenes</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="flex items-center gap-1.5 rounded-lg border border-[#002855]/20 bg-[#002855]/5 px-3 py-1.5 font-semibold text-[#002855]">
          <CalendarClock className="h-3.5 w-3.5" /> Datos: {fmtDate(s?.data_min)} – {fmtDate(s?.data_max)}
        </span>
        <span className={`hidden items-center gap-1.5 rounded-lg border px-3 py-1.5 md:flex ${s?.snapshot_cutoff ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}
          title={s?.snapshot_cutoff ? 'El saldo inicial viene de la foto de stock del ERP' : 'Sin foto de stock: el saldo anterior a los datos se infiere'}>
          <Camera className="h-3.5 w-3.5" /> {s?.snapshot_cutoff ? `Foto de stock al ${fmtDate(s.snapshot_cutoff)}` : 'Saldo inicial inferido'}
        </span>
        {s?.rebuilt_at && <span className="hidden rounded-lg border border-slate-200 px-3 py-1.5 text-slate-500 lg:inline">Recalculado: {fmtDateTime(s.rebuilt_at)}</span>}
        {s?.dirty && (
          <span className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 font-bold text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" /> Recálculo pendiente
          </span>
        )}
        {st?.can_load && (
          <button type="button" onClick={run} disabled={busy} className="flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-semibold text-[#002855] hover:bg-slate-50 disabled:opacity-60">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Recalcular
          </button>
        )}
        {st?.can_load && (
          <Link href="/apt/datos" className="flex min-h-9 items-center gap-1.5 rounded-lg bg-[#cf152d] px-3 py-1.5 font-bold text-white shadow-sm hover:bg-[#b01226]">
            <FileUp className="h-3.5 w-3.5" /> Cargar Entradas / Salidas
          </Link>
        )}
        {msg && <span role="alert" className="w-full text-right text-red-700">{msg}</span>}
      </div>
    </div>
  )
}
