'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowDownLeft, ArrowUpRight, ClipboardList, Download, Loader2, Lock, Plus, RefreshCw, Scale, Wallet } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { Modal } from '@/components/ui/modal'
import { PAYMENT_METHODS, errorMessage, exportXlsx, fmtDate, money, rpcOk, todayLima, type Row } from '@/lib/caja'

// Cajas y libro de movimientos (Caja C2). Todo ingreso/egreso queda en cash_movements (inmutable);
// el arqueo cuadra el sistema contra el conteo físico y registra la diferencia.

const supabase = createClient()
const TYPES: Record<string, string> = {
  APERTURA: 'Apertura', REPOSICION: 'Reposición', RETIRO: 'Retiro / depósito', ANTICIPO: 'Anticipo a conductor', GASTO: 'Vale de gasto',
  DEVOLUCION: 'Devolución de conductor', REEMBOLSO: 'Reembolso a conductor', AJUSTE_ARQUEO: 'Ajuste de arqueo', REVERSION: 'Reversión',
}
const BOX_TYPES: Record<string, string> = { CAJA_CHICA: 'Caja chica', RUTA: 'Caja de ruta', BANCO: 'Cuenta bancaria', TARJETA: 'Tarjeta corporativa' }

export default function CajasPage() {
  const { canWrite } = usePermissions()
  const canManage = canWrite('caja-fondos')
  const [boxes, setBoxes] = useState<Row[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [movements, setMovements] = useState<Row[]>([])
  const [closures, setClosures] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState({ from: '', to: '' })
  const [modal, setModal] = useState<null | 'box' | 'movement' | 'arqueo' | 'reposicion'>(null)

  const loadBoxes = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.from('vw_cash_box_balances').select('*').order('is_active', { ascending: false }).order('name')
    if (error) toast.error(error.message)
    setBoxes(data || [])
    setSelected(s => s || data?.[0]?.box_id || null)
    setLoading(false)
  }, [])
  const loadMovements = useCallback(async (boxId: string, r: { from: string; to: string }) => {
    let q = supabase.from('cash_movements').select('*').eq('box_id', boxId).order('created_at', { ascending: false }).limit(500)
    if (r.from) q = q.gte('created_at', `${r.from}T00:00:00-05:00`)
    if (r.to) q = q.lte('created_at', `${r.to}T23:59:59-05:00`)
    const [m, c] = await Promise.all([q, supabase.from('cash_box_closures').select('*').eq('box_id', boxId).order('closure_date', { ascending: false }).limit(30)])
    setMovements(m.data || []); setClosures(c.data || [])
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadBoxes() }, [loadBoxes])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (selected) void loadMovements(selected, range) }, [selected, range, loadMovements])

  const box = boxes.find(b => b.box_id === selected)
  const refresh = () => { void loadBoxes(); if (selected) void loadMovements(selected, range) }
  const totals = useMemo(() => ({
    in: movements.filter(m => m.direction === 1).reduce((s, m) => s + Number(m.amount), 0),
    out: movements.filter(m => m.direction === -1).reduce((s, m) => s + Number(m.amount), 0),
  }), [movements])

  const exportLedger = () => {
    if (!box) return
    exportXlsx(`libro_caja_${box.code}_${todayLima()}.xlsx`, {
      Movimientos: [...movements].reverse().map(m => ({
        Fecha: fmtDate(m.created_at, true), Tipo: TYPES[m.movement_type] || m.movement_type, Descripción: m.description || '',
        Referencia: m.reference || '', 'Forma de pago': m.payment_method || '', Ingreso: m.direction === 1 ? Number(m.amount) : 0, Egreso: m.direction === -1 ? Number(m.amount) : 0,
      })),
      Arqueos: closures.map(c => ({ Fecha: c.closure_date, 'Saldo sistema': Number(c.system_balance), Contado: Number(c.counted_balance), Diferencia: Number(c.difference), Notas: c.notes || '' })),
    })
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><Wallet className="w-6 h-6" />Cajas y fondos</h1>
          <p className="text-sm text-slate-500">Saldos, movimientos, arqueo diario y reposición de cada caja. Los movimientos no se editan: se revierten.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={refresh} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2 hover:bg-slate-50"><RefreshCw className="w-4 h-4" />Actualizar</button>
          {canManage && <button onClick={() => setModal('box')} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm font-semibold flex items-center gap-2"><Plus className="w-4 h-4" />Nueva caja</button>}
        </div>
      </div>

      {loading ? <div className="p-12 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div> : boxes.length === 0 ? (
        <div className="bg-white border rounded-xl p-10 text-center text-slate-500">No hay cajas registradas. {canManage && 'Cree la primera caja para empezar a registrar anticipos y vales.'}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {boxes.map(b => {
            const low = Number(b.balance) < Number(b.min_balance)
            return (
              <button key={b.box_id} onClick={() => setSelected(b.box_id)} className={`text-left bg-white border rounded-xl p-4 transition ${selected === b.box_id ? 'ring-2 ring-[#002855]' : 'hover:border-blue-300'} ${!b.is_active ? 'opacity-60' : ''}`}>
                <div className="flex justify-between text-xs text-slate-500"><span>{BOX_TYPES[b.box_type]} · {b.code}</span>{!b.is_active && <span>Inactiva</span>}</div>
                <div className="font-semibold text-slate-800">{b.name}</div>
                <div className={`text-2xl font-bold mt-1 ${Number(b.balance) < 0 ? 'text-red-600' : 'text-slate-900'}`}>{money(b.balance)}</div>
                <div className="text-xs text-slate-500 flex flex-wrap gap-x-3">
                  <span>Hoy +{money(b.today_in, 0)} / −{money(b.today_out, 0)}</span>
                  {Number(b.pending_vouchers) > 0 && <span className="text-amber-700">Vales por aprobar {money(b.pending_vouchers, 0)}</span>}
                </div>
                {low && <div className="text-xs text-red-700 mt-1">Bajo el mínimo ({money(b.min_balance, 0)}): solicite reposición</div>}
                <div className="text-[11px] text-slate-400 mt-1">Último arqueo: {b.last_closure_date ? fmtDate(b.last_closure_date) : 'nunca'}</div>
              </button>
            )
          })}
        </div>
      )}

      {box && (
        <div className="bg-white border rounded-xl">
          <div className="p-4 border-b flex flex-wrap items-end gap-2">
            <div className="mr-auto">
              <div className="font-semibold text-slate-800">{box.name}</div>
              <div className="text-xs text-slate-500">Periodo: ingresos {money(totals.in)} · egresos {money(totals.out)}</div>
            </div>
            <label className="text-xs">Desde<input type="date" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} className="block border rounded-lg px-2 py-1.5" /></label>
            <label className="text-xs">Hasta<input type="date" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} className="block border rounded-lg px-2 py-1.5" /></label>
            <button onClick={exportLedger} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-1.5"><Download className="w-4 h-4" />Excel</button>
            {canManage && box.is_active && <>
              <button onClick={() => setModal('movement')} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-1.5"><ArrowDownLeft className="w-4 h-4" />Ingreso / retiro</button>
              <button onClick={() => setModal('reposicion')} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-1.5"><ClipboardList className="w-4 h-4" />Solicitud de reposición</button>
              <button onClick={() => setModal('arqueo')} className="px-3 py-2 bg-[#002855] text-white rounded-lg text-sm flex items-center gap-1.5"><Scale className="w-4 h-4" />Arqueo</button>
            </>}
          </div>
          <div className="overflow-auto max-h-[28rem]">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 sticky top-0"><tr>
                <th className="p-3 text-left">Fecha</th><th className="p-3 text-left">Tipo</th><th className="p-3 text-left">Descripción</th>
                <th className="p-3 text-left">Forma / referencia</th><th className="p-3 text-right">Ingreso</th><th className="p-3 text-right">Egreso</th>
              </tr></thead>
              <tbody className="divide-y">
                {movements.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-slate-400">Sin movimientos en el periodo</td></tr>}
                {movements.map(m => (
                  <tr key={m.id} className={m.movement_type === 'REVERSION' ? 'bg-slate-50 text-slate-500' : ''}>
                    <td className="p-3 whitespace-nowrap">{fmtDate(m.created_at, true)}</td>
                    <td className="p-3">{m.direction === 1 ? <ArrowDownLeft className="inline w-3 h-3 text-emerald-600 mr-1" /> : <ArrowUpRight className="inline w-3 h-3 text-red-600 mr-1" />}{TYPES[m.movement_type] || m.movement_type}</td>
                    <td className="p-3">{m.description || '—'}</td>
                    <td className="p-3 text-xs">{[m.payment_method, m.reference].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="p-3 text-right text-emerald-700 font-semibold">{m.direction === 1 ? money(m.amount) : ''}</td>
                    <td className="p-3 text-right text-red-700 font-semibold">{m.direction === -1 ? money(m.amount) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {closures.length > 0 && (
            <div className="p-4 border-t">
              <div className="text-xs font-bold uppercase text-slate-500 mb-2 flex items-center gap-1"><Lock className="w-3 h-3" />Arqueos recientes</div>
              <div className="flex flex-wrap gap-2 text-xs">
                {closures.slice(0, 10).map(c => (
                  <span key={c.id} className={`px-2 py-1 rounded border ${Number(c.difference) !== 0 ? 'border-red-200 bg-red-50' : 'bg-slate-50'}`} title={c.notes || ''}>
                    {fmtDate(c.closure_date)} · {money(c.counted_balance)}{Number(c.difference) !== 0 && ` (dif. ${money(c.difference)})`}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {modal === 'box' && <BoxForm onClose={() => setModal(null)} onDone={() => { setModal(null); void loadBoxes() }} />}
      {modal === 'movement' && box && <MovementForm box={box} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh() }} />}
      {modal === 'arqueo' && box && <ArqueoForm box={box} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh() }} />}
      {modal === 'reposicion' && box && <Reposicion box={box} movements={movements} onClose={() => setModal(null)} />}
    </div>
  )
}

function BoxForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [sites, setSites] = useState<Row[]>([])
  const [f, setF] = useState({ code: '', name: '', box_type: 'CAJA_CHICA', site_id: '', min_balance: '0', max_balance: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => { supabase.from('sites').select('id, name').eq('is_active', true).order('name').then(r => { setSites(r.data || []); setF(x => ({ ...x, site_id: r.data?.[0]?.id || '' })) }) }, [])
  const save = async () => {
    setBusy(true)
    const { error } = await supabase.from('cash_boxes').insert([{
      code: f.code.trim().toUpperCase(), name: f.name.trim(), box_type: f.box_type, site_id: f.site_id || undefined,
      min_balance: Number(f.min_balance || 0), max_balance: f.max_balance ? Number(f.max_balance) : null,
      allow_negative: f.box_type === 'BANCO' || f.box_type === 'TARJETA',
    }])
    setBusy(false)
    if (error) return toast.error(error.message)
    toast.success('Caja creada: registre la apertura con el saldo inicial')
    onDone()
  }
  return (
    <Modal isOpen onClose={onClose} title="Nueva caja">
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-3 gap-3">
          <label className="block"><span className="text-xs font-bold text-slate-600">Código</span><input value={f.code} onChange={e => setF({ ...f, code: e.target.value })} className="caja-input uppercase" placeholder="CCH-LIM" /></label>
          <label className="block col-span-2"><span className="text-xs font-bold text-slate-600">Nombre</span><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} className="caja-input" placeholder="Caja chica Lima" /></label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-xs font-bold text-slate-600">Tipo</span>
            <select value={f.box_type} onChange={e => setF({ ...f, box_type: e.target.value })} className="caja-input">{Object.entries(BOX_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </label>
          <label className="block"><span className="text-xs font-bold text-slate-600">Sede</span>
            <select value={f.site_id} onChange={e => setF({ ...f, site_id: e.target.value })} className="caja-input">{sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </label>
          <label className="block"><span className="text-xs font-bold text-slate-600">Saldo mínimo (alerta de reposición)</span><input type="number" min="0" value={f.min_balance} onChange={e => setF({ ...f, min_balance: e.target.value })} className="caja-input" /></label>
          <label className="block"><span className="text-xs font-bold text-slate-600">Fondo fijo / tope</span><input type="number" min="0" value={f.max_balance} onChange={e => setF({ ...f, max_balance: e.target.value })} className="caja-input" /></label>
        </div>
        <p className="text-xs text-slate-500">Las cajas de efectivo no permiten egresos mayores al saldo; las cuentas bancarias y tarjetas sí (se concilian aparte).</p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-lg hover:bg-slate-100">Cancelar</button>
          <button disabled={busy || !f.code.trim() || !f.name.trim()} onClick={save} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold disabled:opacity-50">Crear caja</button>
        </div>
      </div>
    </Modal>
  )
}

function MovementForm({ box, onClose, onDone }: { box: Row; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ type: 'REPOSICION', amount: '', method: 'TRANSFERENCIA', reference: '', description: '' })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await rpcOk(supabase, 'register_cash_movement', { p_box_id: box.box_id, p_type: f.type, p_amount: Number(f.amount),
        p_payment_method: f.method, p_reference: f.reference || null, p_description: f.description || null })
      toast.success('Movimiento registrado')
      onDone()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <Modal isOpen onClose={onClose} title={`Movimiento · ${box.name}`}>
      <div className="space-y-3 text-sm">
        <div className="flex gap-2">
          {[['APERTURA', 'Apertura'], ['REPOSICION', 'Reposición'], ['RETIRO', 'Retiro / depósito']].map(([k, l]) => (
            <button key={k} onClick={() => setF({ ...f, type: k })} className={`px-3 py-1.5 rounded-lg border ${f.type === k ? 'bg-blue-50 border-blue-400 font-semibold' : ''}`}>{l}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-xs font-bold text-slate-600">Monto (S/)</span><input type="number" min="0" step="0.01" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} className="caja-input font-bold" /></label>
          <label className="block"><span className="text-xs font-bold text-slate-600">Forma</span>
            <select value={f.method} onChange={e => setF({ ...f, method: e.target.value })} className="caja-input">{PAYMENT_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </label>
        </div>
        <label className="block"><span className="text-xs font-bold text-slate-600">Referencia</span><input value={f.reference} onChange={e => setF({ ...f, reference: e.target.value })} className="caja-input" placeholder="N° operación / cheque" /></label>
        <label className="block"><span className="text-xs font-bold text-slate-600">{f.type === 'RETIRO' ? 'Motivo (obligatorio)' : 'Descripción'}</span><input value={f.description} onChange={e => setF({ ...f, description: e.target.value })} className="caja-input" /></label>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-lg hover:bg-slate-100">Cancelar</button>
          <button disabled={busy || !(Number(f.amount) > 0) || (f.type === 'RETIRO' && !f.description.trim())} onClick={save} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold disabled:opacity-50">Registrar</button>
        </div>
      </div>
    </Modal>
  )
}

function ArqueoForm({ box, onClose, onDone }: { box: Row; onClose: () => void; onDone: () => void }) {
  const [counted, setCounted] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const diff = counted === '' ? 0 : Math.round((Number(counted) - Number(box.balance)) * 100) / 100
  const save = async () => {
    setBusy(true)
    try {
      const r = await rpcOk<Row>(supabase, 'close_cash_box', { p_box_id: box.box_id, p_counted: Number(counted), p_notes: notes || null })
      toast.success(Number(r.difference) === 0 ? 'Arqueo cuadrado' : `Arqueo registrado con diferencia de ${money(r.difference)}`)
      onDone()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <Modal isOpen onClose={onClose} title={`Arqueo del día · ${box.name}`}>
      <div className="space-y-3 text-sm">
        <div className="bg-slate-50 rounded-lg p-3">Saldo según sistema: <b>{money(box.balance)}</b></div>
        <label className="block"><span className="text-xs font-bold text-slate-600">Monto contado (S/)</span><input type="number" min="0" step="0.01" value={counted} onChange={e => setCounted(e.target.value)} className="caja-input text-lg font-bold" /></label>
        {counted !== '' && <div className={`text-sm font-semibold ${diff === 0 ? 'text-emerald-700' : 'text-red-700'}`}>{diff === 0 ? 'Cuadra con el sistema' : `${diff > 0 ? 'Sobrante' : 'Faltante'} de ${money(Math.abs(diff))}`}</div>}
        {diff !== 0 && <label className="block"><span className="text-xs font-bold text-slate-600">Explicación de la diferencia (obligatoria)</span><textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="caja-input" /></label>}
        <p className="text-xs text-slate-500">Una diferencia se registra como ajuste de arqueo en el libro. Solo se permite un arqueo por caja y día.</p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-lg hover:bg-slate-100">Cancelar</button>
          <button disabled={busy || counted === '' || (diff !== 0 && !notes.trim())} onClick={save} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold disabled:opacity-50">Cerrar arqueo</button>
        </div>
      </div>
    </Modal>
  )
}

// Sustento de la reposición: vales y anticipos pagados desde la última reposición
function Reposicion({ box, movements, onClose }: { box: Row; movements: Row[]; onClose: () => void }) {
  const lastRepo = movements.find(m => m.movement_type === 'REPOSICION' || m.movement_type === 'APERTURA')
  const since = lastRepo ? new Date(lastRepo.created_at) : null
  const outs = movements.filter(m => m.direction === -1 && (!since || new Date(m.created_at) > since))
  const total = outs.reduce((s, m) => s + Number(m.amount), 0) - movements.filter(m => m.direction === 1 && m.movement_type !== 'REPOSICION' && m.movement_type !== 'APERTURA' && (!since || new Date(m.created_at) > since)).reduce((s, m) => s + Number(m.amount), 0)
  const target = box.max_balance ? Math.max(0, Number(box.max_balance) - Number(box.balance)) : total
  return (
    <Modal isOpen onClose={onClose} title={`Solicitud de reposición · ${box.name}`} maxWidth="max-w-3xl">
      <div className="space-y-3 text-sm">
        <p>Egresos desde {since ? fmtDate(since.toISOString(), true) : 'la apertura'}: <b>{outs.length}</b> movimientos por <b>{money(total)}</b>. {box.max_balance && <>Para volver al fondo fijo ({money(box.max_balance)}) se requiere <b>{money(target)}</b>.</>}</p>
        <div className="max-h-80 overflow-auto border rounded-lg">
          <table className="w-full text-xs"><tbody className="divide-y">
            {outs.map(m => <tr key={m.id}><td className="p-2">{fmtDate(m.created_at)}</td><td className="p-2">{TYPES[m.movement_type]}</td><td className="p-2">{m.description}</td><td className="p-2 text-right">{money(m.amount)}</td></tr>)}
          </tbody></table>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={() => exportXlsx(`reposicion_${box.code}_${todayLima()}.xlsx`, {
            Solicitud: [{ Caja: box.name, Código: box.code, 'Saldo actual': Number(box.balance), 'Fondo fijo': box.max_balance ? Number(box.max_balance) : '', 'Monto solicitado': target }],
            Sustento: outs.map(m => ({ Fecha: fmtDate(m.created_at, true), Tipo: TYPES[m.movement_type], Descripción: m.description || '', Referencia: m.reference || '', Monto: Number(m.amount) })),
          })} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold flex items-center gap-2"><Download className="w-4 h-4" />Descargar para Finanzas</button>
        </div>
      </div>
    </Modal>
  )
}
