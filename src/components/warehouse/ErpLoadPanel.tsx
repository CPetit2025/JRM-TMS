'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Upload } from 'lucide-react'
import { readErpFiles } from '@/components/erp/ErpCarga'
import { uploadErpFile } from '@/lib/erp/api'
import { ERP_KIND_LABEL } from '@/lib/erp/parse'
import { derivarDia } from '@/lib/erp/derive'

type ImportRow = { kind: 'STOCK' | 'CONTRATOS'; status: string; file_name: string; cut_at: string | null; rows_loaded: number; retained: boolean; applied_at: string | null; created_at: string }
const fmt = (n: number | null | undefined) => n == null ? '—' : Number(n).toLocaleString('es-PE', { maximumFractionDigits: 0 })
const fmtDate = (v: string | null | undefined) => v ? new Date(v).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : '—'

/** Carga de los dos Excel del ERP (Actualizable y Stock) y derivación del día. El robot del ERP usa los ids #erp-*. */
export function ErpLoadPanel() {
  const [imports, setImports] = useState<ImportRow[]>([])
  const [files, setFiles] = useState<{ contratos: File | null; stock: File | null }>({ contratos: null, stock: null })
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const { data, error } = await createClient().rpc('erp_imports_recent', { p_limit: 10 })
    if (error) setError(error.message); else setImports((data || []) as ImportRow[])
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const apply = async () => {
    const chosen = [files.contratos, files.stock].filter((f): f is File => !!f)
    if (!chosen.length) return
    setBusy(true); setError(''); setNotice('')
    try {
      const parsed = await readErpFiles(chosen, setProgress)
      if (parsed.errors.length) throw new Error(parsed.errors.join(' '))
      if (!parsed.files.length) throw new Error('Los archivos no tienen el formato del Actualizable Despacho ni del Stock Bodega Despacho.')
      const done: string[] = []
      for (const f of parsed.files) {
        const out = await uploadErpFile(f, setProgress)
        done.push(`${ERP_KIND_LABEL[f.kind]}: ${fmt(out.rows)} filas`)
      }
      // Modelo de almacén: movimientos del día → inventario, APT y analítica. No deshace la carga si no se puede.
      let modelo = ''
      try {
        const d = await derivarDia(setProgress)
        modelo = d ? ` Movimientos del día: ${d.resumen.guias} guías, ${d.resumen.traspasos} traspasos, ${d.resumen.ingresos} ingresos y ${d.resumen.ajustes} ajustes.${d.avisos.length ? ' ' + d.avisos.join(' ') : ''}` : ''
      } catch (e) { modelo = ` Movimientos del día no derivados: ${e instanceof Error ? e.message : 'error'}` }
      setNotice(`Carga aplicada. ${done.join(' · ')}.${modelo}`)
      setFiles({ contratos: null, stock: null })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar')
    }
    setProgress(''); setBusy(false)
  }

  const field = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal'
  return <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
    <div>
      <h2 className="flex items-center gap-2 font-bold text-[#002855]"><Upload size={16}/>Carga ERP</h2>
      <p className="text-xs text-slate-500">Actualizable Despacho y Stock Bodega Despacho. Cada carga reemplaza a la anterior del mismo tipo; el robot del ERP la hace sola varias veces al día.</p>
    </div>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {notice && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
    <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <label className="text-sm font-semibold">{ERP_KIND_LABEL.CONTRATOS}
        <input id="erp-file-contratos" type="file" accept=".xlsx,.xlsm,.xls" disabled={busy} onChange={e => setFiles(f => ({ ...f, contratos: e.target.files?.[0] || null }))} className={field}/></label>
      <label className="text-sm font-semibold">{ERP_KIND_LABEL.STOCK}
        <input id="erp-file-stock" type="file" accept=".xlsx,.xlsm,.xls" disabled={busy} onChange={e => setFiles(f => ({ ...f, stock: e.target.files?.[0] || null }))} className={field}/></label>
      <button id="erp-apply" type="button" disabled={busy || (!files.contratos && !files.stock)} onClick={() => void apply()} className="rounded-lg bg-[#002855] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">{busy ? 'Cargando…' : 'Aplicar carga'}</button>
    </div>
    {progress && <p className="text-xs text-slate-600">{progress}</p>}
    {imports.length > 0 && <ul className="divide-y border-t text-xs text-slate-600">{imports.slice(0, 6).map(i =>
      <li key={i.created_at + i.kind} className="flex flex-wrap gap-x-3 py-1.5">
        <b className="text-slate-800">{i.kind === 'STOCK' ? 'Stock' : 'Actualizable'}</b>
        <span>{i.status === 'ACTIVA' ? 'vigente' : 'reemplazada'}{i.retained ? ' · retenida por inventario' : ''}</span>
        <span>corte {fmtDate(i.cut_at)}</span><span>{fmt(i.rows_loaded)} filas</span><span className="truncate">{i.file_name}</span>
      </li>)}</ul>}
  </section>
}
