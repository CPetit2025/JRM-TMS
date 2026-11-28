'use client'

import { useMemo, useState } from 'react'
import { Download, FileText, Loader2, Search } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { ChartCard, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { Table, td, tdNum, th } from '@/components/inventario/parts'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { invApi } from '@/lib/inventario/api'
import { fmtN, fmtPeso, fmtQty } from '@/lib/inventario/format'
import { fmtDateTime } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import { SINC_ESTADO, SINC_MOTIVO } from '@/lib/inventario/sinceramiento'
import type { InvSinc } from '@/lib/inventario/types'
import { SincActa, SincActaBloque } from './SincActa'

type Accion = 'autorizar' | 'rechazar' | 'anular' | 'revertir'
const ACCION: Record<Accion, { label: string; cls: string; motivo: boolean; texto: string }> = {
  autorizar: { label: 'Autorizar', cls: 'bg-[#002855] text-white', motivo: false, texto: 'El stock de estos lotes sale del APT hacia el almacén virtual SF en el próximo recálculo (unos 2 minutos).' },
  rechazar: { label: 'Rechazar', cls: 'border border-red-300 bg-white text-red-700', motivo: true, texto: 'La propuesta queda sin efecto; el stock no cambia.' },
  anular: { label: 'Anular', cls: 'border border-slate-300 bg-white text-slate-700', motivo: false, texto: 'Retira su propuesta; el stock no cambia.' },
  revertir: { label: 'Revertir', cls: 'border border-amber-300 bg-white text-amber-800', motivo: true, texto: 'El stock vuelve del almacén SF al APT en el próximo recálculo.' },
}
const kgDe = (s: InvSinc) => s.lineas.reduce((t, l) => t + l.kg, 0)
// Lo que sigue en SF (el ERP aún no lo regularizó)
const kgSf = (s: InvSinc) => s.lineas.reduce((t, l) => t + l.en_sf * (l.peso_unit ?? 0), 0)
type Vista = 'bandeja' | 'sf' | 'todas'

/** Sinceramiento del stock APT: bandeja de la Jefatura, stock en el almacén virtual SF e historial con su acta */
export function SinceramientoPanel() {
  const q = useInvQuery('sinc', () => invApi.sinc(), { keepPrevious: true })
  const [vista, setVista] = useState<Vista>('bandeja')
  const [txt, setTxt] = useState('')
  const [acta, setActa] = useState<InvSinc | null>(null)
  const [bloque, setBloque] = useState<string | null>(null)
  const [dec, setDec] = useState<{ s: InvSinc; a: Accion } | null>(null)
  const [aviso, setAviso] = useState('')
  const d = q.data
  const filas = useMemo(() => {
    const t = txt.trim().toUpperCase()
    return (d?.filas ?? []).filter(s => (vista === 'todas' || (vista === 'bandeja' ? s.estado === 'PROPUESTA' : s.estado === 'AUTORIZADA'))
      && (!t || `${s.numero} ${s.ot} ${s.cliente ?? ''} ${s.lineas.map(l => `${l.lote} ${l.producto} ${l.glosa ?? ''}`).join(' ')}`.toUpperCase().includes(t)))
  }, [d, vista, txt])
  if (q.loading && !d) return <LoadingBlock label="Leyendo los sinceramientos…" />
  if (q.error && !d) return <ErrorBlock message={q.error} onRetry={q.reload} />
  const todas = d?.filas ?? []
  const pend = todas.filter(s => s.estado === 'PROPUESTA'), sf = todas.filter(s => s.estado === 'AUTORIZADA')
  const acciones = (s: InvSinc): Accion[] => {
    const mio = s.propuesto_por === d?.uid
    if (s.estado === 'PROPUESTA') return [...(d?.puede_autorizar && !mio ? ['autorizar', 'rechazar'] as Accion[] : []), ...(mio ? ['anular'] as Accion[] : [])]
    return s.estado === 'AUTORIZADA' && d?.puede_autorizar ? ['revertir'] : []
  }
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-3">
      <KpiCard label="Por autorizar" value={fmtN(pend.length)} hint={fmtPeso(pend.reduce((t, s) => t + kgDe(s), 0))} tone={pend.length ? 'warn' : 'default'} onClick={() => setVista('bandeja')} active={vista === 'bandeja'} />
      <KpiCard label="En almacén virtual SF" value={fmtPeso(sf.reduce((t, s) => t + kgSf(s), 0))} hint={`${fmtN(sf.length)} actas · ${fmtN(sf.reduce((t, s) => t + s.lineas.length, 0))} lotes · pendiente de regularizar en el ERP`} onClick={() => setVista('sf')} active={vista === 'sf'} />
      <KpiCard label="Historial" value={fmtN(todas.length)} hint="Todas las actas, incluidas rechazadas, anuladas y revertidas" onClick={() => setVista('todas')} active={vista === 'todas'} />
    </div>
    {aviso && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800">{aviso}</p>}
    <ChartCard title={vista === 'bandeja' ? 'Bandeja de autorización' : vista === 'sf' ? 'Stock en el almacén virtual SF' : 'Historial de sinceramientos'}
      subtitle={vista === 'bandeja' ? (d?.puede_autorizar ? 'Autoriza la Jefatura de Distribución; nadie autoriza lo que propuso' : 'Solo la Jefatura de Distribución autoriza') : vista === 'sf' ? 'Stock que salió del APT por no existir físicamente' : `${fmtN(filas.length)} actas`}
      actions={<div className="flex flex-wrap gap-2">{vista === 'sf' && <button type="button" onClick={() => exportarSf(filas)} disabled={!filas.length}
        className="flex min-h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#002855] disabled:opacity-50"><Download className="h-4 w-4" aria-hidden /> Pendientes ERP (Excel)</button>}
        <label className="flex min-h-9 w-64 items-center gap-2 rounded-lg border border-slate-300 px-2 text-sm"><Search className="h-4 w-4 text-slate-400" aria-hidden />
        <input value={txt} onChange={e => setTxt(e.target.value)} placeholder="Acta, OT, cliente, lote o producto" aria-label="Buscar sinceramientos" className="w-full outline-none" /></label></div>}>
      <p className="mb-3 text-xs text-slate-500">En Contratos / OT: abra la OT y marque sus lotes, o marque varias OT en la lista para sincerarlas en bloque. Cuando una carga del ERP ya trae ese saldo ajustado, el acta pasa sola a «Regularizada en ERP».
        {d && !d.puede_proponer && ' Su usuario no puede proponer (permiso «APT: proponer sinceramiento»).'}</p>
      {vista === 'sf'
        ? <Table empty={!filas.length} head={<tr><th className={th}>Acta</th><th className={th}>OT</th><th className={th}>Bodega de origen</th><th className={th}>Producto · lote</th><th className={`${th} text-right`}>En SF</th><th className={`${th} text-right`}>Regularizado en ERP</th><th className={`${th} text-right`}>Peso en SF</th><th className={th}>Autorizado</th></tr>}>
            {filas.flatMap(s => s.lineas.map((l, i) => <tr key={`${s.id}|${i}`} className="hover:bg-slate-50">
              <td className={td}><button type="button" onClick={() => setActa(s)} className="font-semibold text-[#002855] underline">{s.numero}</button></td>
              <td className={td}><p className="font-semibold">{s.ot}</p><p className="text-[11px] text-slate-500">{s.cliente ?? ''}</p></td>
              <td className={td}>{l.bodega}</td>
              <td className={td}><p className="font-semibold">{l.lote}</p><p className="font-mono text-[11px] text-slate-500">{l.producto}</p><p className="max-w-72 text-slate-700">{l.glosa ?? '—'}</p></td>
              <td className={tdNum}>{fmtQty(l.en_sf)} <span className="text-slate-400">{l.unidad ?? ''}</span></td>
              <td className={tdNum}>{l.cantidad - l.en_sf > 0 ? fmtQty(l.cantidad - l.en_sf) : '—'}</td>
              <td className={tdNum}>{l.peso_unit === null ? <span className="text-slate-400">Sin peso</span> : fmtPeso(l.en_sf * l.peso_unit)}</td>
              <td className={td}>{fmtDateTime(s.autorizado_at)}<p className="text-[11px] text-slate-500">{s.autorizador ?? ''}</p></td>
            </tr>))}
          </Table>
        : <Table empty={!filas.length} head={<tr><th className={th}>Acta</th><th className={th}>OT</th><th className={th}>Motivo</th><th className={`${th} text-right`}>Lotes</th><th className={`${th} text-right`}>Peso</th><th className={th}>Estado</th><th className={th}>Propuso</th><th className={th}>Decidió</th><th className={th}>Acciones</th></tr>}>
            {filas.map(s => <tr key={s.id} className="hover:bg-slate-50">
              <td className={td}><p className="font-bold text-[#002855]">{s.numero}</p>{s.bloque && <p className="text-[11px] text-slate-500">Bloque {s.bloque}</p>}
                {s.directo && <span className="rounded bg-blue-50 px-1 text-[10px] font-semibold text-[#002855]">Directo Jefatura</span>}</td>
              <td className={td}><p className="font-semibold">{s.ot}</p><p className="text-[11px] text-slate-500">{s.cliente ?? ''}</p></td>
              <td className={td}><p>{SINC_MOTIVO[s.motivo]}</p><p className="max-w-64 truncate text-[11px] text-slate-500" title={s.observacion}>{s.observacion}</p></td>
              <td className={tdNum}>{fmtN(s.lineas.length)}</td>
              <td className={tdNum}>{fmtPeso(kgDe(s))}</td>
              <td className={td}><span className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold ${SINC_ESTADO[s.estado].cls}`}>{SINC_ESTADO[s.estado].label}</span></td>
              <td className={td}>{s.proponente ?? '—'}<p className="text-[11px] text-slate-500">{fmtDateTime(s.propuesto_at)}</p></td>
              <td className={td}>{s.estado === 'REVERTIDA' ? s.revertidor : s.decisor ?? '—'}<p className="text-[11px] text-slate-500">{fmtDateTime(s.estado === 'REVERTIDA' ? s.revertido_at : s.decidido_at)}</p></td>
              <td className={td}><div className="flex flex-wrap gap-1">
                <button type="button" onClick={() => setActa(s)} className="flex min-h-8 items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 text-xs font-semibold text-[#002855]"><FileText className="h-3.5 w-3.5" aria-hidden /> Acta</button>
                {s.bloque && <button type="button" onClick={() => setBloque(s.bloque)} className="flex min-h-8 items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 text-xs font-semibold text-[#002855]"><FileText className="h-3.5 w-3.5" aria-hidden /> Acta del bloque</button>}
                {acciones(s).map(a => <button key={a} type="button" onClick={() => setDec({ s, a })} className={`min-h-8 rounded-lg px-2 text-xs font-semibold ${ACCION[a].cls}`}>{ACCION[a].label}</button>)}
              </div></td>
            </tr>)}
          </Table>}
    </ChartCard>
    {acta && <SincActa s={acta} onClose={() => setActa(null)} />}
    {bloque && <SincActaBloque bloque={bloque} actas={todas.filter(s => s.bloque === bloque).reverse()} onClose={() => setBloque(null)} />}
    {dec && <Decidir s={dec.s} a={dec.a} onClose={() => setDec(null)} onDone={m => { setDec(null); setAviso(m); q.reload() }} />}
  </div>
}

// Reporte para regularizar en el ERP: lo que sigue en SF, por bodega · producto · lote
function exportarSf(filas: InvSinc[]) {
  exportAptXlsx(`pendientes-regularizar-erp-${new Date().toISOString().slice(0, 10)}`, { 'Pendientes ERP': filas.flatMap(s => s.lineas.filter(l => l.en_sf > 0).map(l => ({
    Acta: s.numero, Bloque: s.bloque ?? '', OT: s.ot, Cliente: s.cliente ?? '', Motivo: SINC_MOTIVO[s.motivo], 'Bodega de origen': l.bodega, Producto: l.producto,
    Glosa: l.glosa ?? '', Lote: l.lote, Unidad: l.unidad ?? '', 'Cantidad a regularizar': l.en_sf, 'Kg a regularizar': l.peso_unit === null ? '' : Math.round(l.en_sf * l.peso_unit * 10) / 10,
    Autorizado: s.autorizado_at ?? '', Autorizó: s.autorizador ?? '', Directo: s.directo ? 'Sí' : 'No' }))) })
}

function Decidir({ s, a, onClose, onDone }: { s: InvSinc; a: Accion; onClose: () => void; onDone: (m: string) => void }) {
  const [motivo, setMotivo] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const cfg = ACCION[a]
  const ir = async () => {
    setBusy(true); setError('')
    try {
      const r = await invApi.sincDecidir({ id: s.id, accion: a, motivo: motivo.trim() || undefined })
      onDone(`${r.numero}: ${SINC_ESTADO[r.estado as InvSinc['estado']]?.label ?? r.estado}. ${a === 'autorizar' || a === 'revertir' ? 'El stock se actualiza en el próximo recálculo (unos 2 minutos).' : ''}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo registrar') } finally { setBusy(false) }
  }
  return <Modal isOpen onClose={onClose} title={`${cfg.label} ${s.numero}`}
    footer={<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold">Cancelar</button>
      <button type="button" disabled={busy || (cfg.motivo && motivo.trim().length < 5)} onClick={() => void ir()} className={`flex min-h-10 items-center gap-2 rounded-lg px-4 text-sm font-bold disabled:opacity-50 ${cfg.cls}`}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} {cfg.label}</button></div>}>
    <p className="text-sm text-slate-700">OT <b>{s.ot}</b> · {s.lineas.length} lote(s) · {fmtPeso(kgDe(s))} · {SINC_MOTIVO[s.motivo]}</p>
    <p className="mt-2 text-sm text-slate-600">{cfg.texto}</p>
    <label className="mt-3 block text-sm font-semibold text-slate-700">Motivo{cfg.motivo ? '' : ' (opcional)'}
      <textarea value={motivo} onChange={e => setMotivo(e.target.value)} rows={3} className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 font-normal" /></label>
    {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p>}
  </Modal>
}
