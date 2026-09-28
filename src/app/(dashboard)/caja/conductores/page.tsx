'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Loader2, RefreshCw, Search, UserRound } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { fmtDate, money, type Row } from '@/lib/caja'

// Cuenta corriente del conductor (Caja C2): anticipos (cargo) − gastos aprobados, devoluciones y descuentos (abono)
// + reembolsos. Saldo > 0: el conductor tiene dinero por rendir o devolver; < 0: la empresa le debe.

const supabase = createClient()
const KIND: Record<string, string> = {
  ANTICIPO: 'Anticipo entregado', GASTO: 'Gasto aprobado', DEVOLUCION: 'Devolución en caja', REEMBOLSO: 'Reembolso de la empresa', DESCUENTO_PLANILLA: 'Descuento por planilla',
}

const ageBucket = (d: string | null) => {
  if (!d) return null
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 864e5)
  return days <= 7 ? '0–7 días' : days <= 15 ? '8–15 días' : 'Más de 15 días'
}

export default function ConductoresCajaPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [onlyOpen, setOnlyOpen] = useState(true)
  const [detail, setDetail] = useState<Row | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.from('vw_driver_cash_account').select('*').order('balance', { ascending: false })
    if (error) toast.error(error.message)
    setRows(data || [])
    setLoading(false)
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const visible = useMemo(() => rows.filter(r => (!onlyOpen || Number(r.balance) !== 0 || Number(r.pending_expenses) > 0 || r.overdue_trips > 0)
    && (!q.trim() || String(r.driver_name || '').toLowerCase().includes(q.trim().toLowerCase()))), [rows, q, onlyOpen])
  const aging = useMemo(() => {
    const b: Record<string, number> = { '0–7 días': 0, '8–15 días': 0, 'Más de 15 días': 0 }
    rows.filter(r => Number(r.balance) > 0).forEach(r => { const k = ageBucket(r.oldest_open_advance_at); if (k) b[k] += Number(r.balance) })
    return b
  }, [rows])
  const owed = rows.filter(r => Number(r.balance) > 0).reduce((s, r) => s + Number(r.balance), 0)
  const owing = rows.filter(r => Number(r.balance) < 0).reduce((s, r) => s - Number(r.balance), 0)

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><UserRound className="w-6 h-6" />Cuenta corriente de conductores</h1>
          <p className="text-sm text-slate-500">Saldo de cada conductor: anticipos recibidos contra gastos aprobados, devoluciones, reembolsos y descuentos.</p>
        </div>
        <button onClick={load} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2 hover:bg-slate-50"><RefreshCw className="w-4 h-4" />Actualizar</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Por rendir / devolver" value={money(owed)} />
        <Stat label="La empresa debe (reembolsos)" value={money(owing)} />
        {Object.entries(aging).map(([k, v]) => <Stat key={k} label={`Antigüedad ${k}`} value={money(v)} tone={k === 'Más de 15 días' && v > 0 ? 'red' : undefined} />)}
      </div>

      <div className="flex items-center gap-3">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2 top-2.5 text-slate-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar conductor" className="border rounded-lg pl-7 pr-2 py-2 text-sm w-64" />
        </div>
        <label className="text-sm flex items-center gap-1.5"><input type="checkbox" checked={onlyOpen} onChange={e => setOnlyOpen(e.target.checked)} />Solo con saldo o pendientes</label>
      </div>

      <div className="bg-white border rounded-xl overflow-auto">
        {loading ? <div className="p-12 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500"><tr>
              <th className="p-3 text-left">Conductor</th><th className="p-3 text-right">Anticipos y reembolsos</th><th className="p-3 text-right">Gastos, devoluciones y descuentos</th>
              <th className="p-3 text-right">Saldo</th><th className="p-3 text-right">Gastos por aprobar</th><th className="p-3 text-left">Antigüedad</th><th className="p-3 text-left">Alertas</th><th className="p-3" />
            </tr></thead>
            <tbody className="divide-y">
              {visible.length === 0 && <tr><td colSpan={8} className="p-10 text-center text-slate-400">Sin conductores con movimientos</td></tr>}
              {visible.map(r => (
                <tr key={r.driver_id} className="hover:bg-slate-50">
                  <td className="p-3 font-semibold">{r.driver_name || '—'}<div className="text-xs text-slate-500 font-normal">Último movimiento {fmtDate(r.last_movement_at)}</div></td>
                  <td className="p-3 text-right">{money(r.total_debit)}</td>
                  <td className="p-3 text-right">{money(r.total_credit)}</td>
                  <td className={`p-3 text-right font-bold ${Number(r.balance) > 0 ? 'text-amber-700' : Number(r.balance) < 0 ? 'text-blue-700' : 'text-slate-500'}`}>
                    {money(Math.abs(Number(r.balance)))}<div className="text-[10px] font-normal">{Number(r.balance) > 0 ? 'por rendir' : Number(r.balance) < 0 ? 'a favor del conductor' : 'al día'}</div>
                  </td>
                  <td className="p-3 text-right">{money(r.pending_expenses)}</td>
                  <td className="p-3 text-xs">{Number(r.balance) > 0 ? ageBucket(r.oldest_open_advance_at) || '—' : '—'}</td>
                  <td className="p-3 text-xs">{r.overdue_trips > 0 ? <span className="text-red-700 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{r.overdue_trips} rendición(es) vencida(s)</span> : '—'}</td>
                  <td className="p-3"><button onClick={() => setDetail(r)} className="text-xs font-semibold text-blue-700 bg-blue-50 px-3 py-1.5 rounded-lg">Estado de cuenta</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {detail && <Statement account={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

function Statement({ account, onClose }: { account: Row; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [trips, setTrips] = useState<Record<string, string>>({})
  useEffect(() => {
    supabase.from('vw_driver_cash_ledger').select('*').eq('driver_id', account.driver_id).order('at').then(async ({ data }) => {
      setRows(data || [])
      const ids = [...new Set((data || []).map(r => r.dispatch_id).filter(Boolean))]
      if (ids.length) {
        const { data: t } = await supabase.from('vw_caja_trips').select('id, dispatch_number').in('id', ids)
        setTrips(Object.fromEntries((t || []).map(x => [x.id, x.dispatch_number])))
      }
    })
  }, [account.driver_id])
  const lines = useMemo(() => (rows || []).reduce<Row[]>((acc, r) => {
    const prev = acc.length ? Number(acc[acc.length - 1].running) : 0
    return [...acc, { ...r, running: prev + Number(r.debit) - Number(r.credit) } as Row]
  }, []), [rows])
  return (
    <Modal isOpen onClose={onClose} title={`Estado de cuenta · ${account.driver_name}`} maxWidth="max-w-3xl">
      {!rows ? <div className="p-12 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div> : (
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500"><tr>
            <th className="p-2 text-left">Fecha</th><th className="p-2 text-left">Concepto</th><th className="p-2 text-left">Viaje</th>
            <th className="p-2 text-right">Cargo</th><th className="p-2 text-right">Abono</th><th className="p-2 text-right">Saldo</th>
          </tr></thead>
          <tbody className="divide-y">
            {lines.map(r => {
              return (
                <tr key={`${r.kind}-${r.ref_id}`}>
                  <td className="p-2 whitespace-nowrap">{fmtDate(r.at)}</td>
                  <td className="p-2">{KIND[r.kind] || r.kind}<div className="text-xs text-slate-500">{r.reference}</div></td>
                  <td className="p-2">{trips[r.dispatch_id] || '—'}</td>
                  <td className="p-2 text-right">{Number(r.debit) ? money(r.debit) : ''}</td>
                  <td className="p-2 text-right">{Number(r.credit) ? money(r.credit) : ''}</td>
                  <td className="p-2 text-right font-semibold">{money(r.running)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Modal>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'red' }) {
  return <div className="bg-white border rounded-xl p-4"><div className="text-xs text-slate-500">{label}</div><div className={`text-xl font-bold ${tone === 'red' ? 'text-red-600' : 'text-slate-900'}`}>{value}</div></div>
}
