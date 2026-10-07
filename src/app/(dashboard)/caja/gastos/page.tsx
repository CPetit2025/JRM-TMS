'use client'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Camera, CheckCircle2, FileText, Fuel, Loader2, Pencil, Save, Trash2, Truck, Wand2, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import {
  DOCUMENT_TYPES, EXPENSE_STATUS, alertsOf, errorMessage, fmtDate, groupCategories, isValidRuc, loadCategories, money, parseOcr,
  removeReceipt, todayLima, uploadReceipt, type ExpenseCategory, type Row,
} from '@/lib/caja'

// Registro de gastos de Caja web (Caja C1/C2). Registrar no es aprobar: todo gasto nace PENDIENTE y lo revisa
// el Administrador o el Jefe de Distribución en /caja/aprobaciones.

const supabase = createClient()

type Form = {
  mode: 'VIAJE' | 'UNIDAD'; dispatch_id: string; vehicle_plate: string; transport_request_id: string
  expense_type: string; expense_date: string; amount: string
  document_type: string; document_series: string; document_number: string; provider_ruc: string; provider_name: string
  description: string; is_billable: boolean; paid_by: 'CONDUCTOR' | 'CAJA' | 'EMPRESA'; cash_box_id: string
  fuel_gallons: string; fuel_odometer: string; fuel_station_id: string
}
const EMPTY: Form = {
  mode: 'VIAJE', dispatch_id: '', vehicle_plate: '', transport_request_id: '', expense_type: '', expense_date: todayLima(), amount: '',
  document_type: 'FACTURA', document_series: '', document_number: '', provider_ruc: '', provider_name: '', description: '', is_billable: false,
  paid_by: 'CONDUCTOR', cash_box_id: '', fuel_gallons: '', fuel_odometer: '', fuel_station_id: '',
}

export default function GastosPage() {
  const { canWrite, isLoaded } = usePermissions()
  const [tab, setTab] = useState<'nuevo' | 'mis'>('nuevo')
  const [me, setMe] = useState<string | null>(null)
  const [cats, setCats] = useState<ExpenseCategory[]>([])
  const [trips, setTrips] = useState<Row[]>([])
  const [units, setUnits] = useState<Row[]>([])
  const [boxes, setBoxes] = useState<Row[]>([])
  const [stations, setStations] = useState<Row[]>([])
  const [form, setForm] = useState<Form>(EMPTY)
  const [editing, setEditing] = useState<Row | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [duplicate, setDuplicate] = useState<Row | null>(null)
  const [mine, setMine] = useState<Row[]>([])
  const [loadingMine, setLoadingMine] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    supabase.auth.getUser().then(r => setMe(r.data.user?.id || null))
    loadCategories(supabase).then(setCats)
    const since = new Date(Date.now() - 45 * 864e5).toISOString()
    supabase.from('vw_caja_trips').select('id, dispatch_number, vehicle_plate, status, driver_id, departure_at, requests')
      .neq('status', 'CANCELADO').gte('created_at', since).order('created_at', { ascending: false }).limit(200)
      .then(r => setTrips(r.data || []))
    supabase.from('vw_caja_units').select('plate, internal_code, type, current_odometer').order('plate').then(r => setUnits(r.data || []))
    supabase.from('vw_cash_box_balances').select('box_id, name, box_type, balance').eq('is_active', true).order('name').then(r => setBoxes(r.data || []))
    supabase.from('fuel_stations').select('id, name, ruc, has_credit').eq('is_active', true).order('name').then(r => setStations(r.data || []))
  }, [])

  const loadMine = useCallback(async (uid: string) => {
    setLoadingMine(true)
    const { data } = await supabase.from('dispatch_expenses').select('*, dispatch:dispatches(dispatch_number)')
      .eq('created_by', uid).order('created_at', { ascending: false }).limit(200)
    setMine(data || [])
    setLoadingMine(false)
  }, [])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab === 'mis' && me) void loadMine(me)
  }, [tab, me, loadMine])

  const trip = trips.find(t => t.id === form.dispatch_id)
  const cat = cats.find(c => c.code === form.expense_type)
  const isFuel = form.expense_type === 'COMBUSTIBLE'
  const plate = form.mode === 'VIAJE' ? trip?.vehicle_plate : form.vehicle_plate
  const unit = units.find(u => u.plate === plate)
  const rucOk = !form.provider_ruc || isValidRuc(form.provider_ruc)
  const catLabel = useMemo(() => Object.fromEntries(cats.map(c => [c.code, c.label])), [cats])
  const set = (patch: Partial<Form>) => setForm(f => ({ ...f, ...patch }))

  // Aviso temprano de comprobante duplicado (la base lo bloquea igual)
  useEffect(() => {
    const { provider_ruc, document_type, document_series, document_number } = form
    const t = setTimeout(async () => {
      if (!provider_ruc || !document_series || !document_number) { setDuplicate(null); return }
      const { data } = await supabase.from('dispatch_expenses').select('id, expense_date, amount, status, document_number')
        .eq('provider_ruc', provider_ruc).eq('document_type', document_type).ilike('document_series', document_series).neq('status', 'RECHAZADO')
      const n = document_number.replace(/^0+/, '')
      setDuplicate((data || []).find(d => d.id !== editing?.id && String(d.document_number).replace(/^0+/, '') === n) || null)
    }, 400)
    return () => clearTimeout(t)
  }, [form, editing])

  const pickFile = async (f: File | undefined) => {
    if (!f) return
    setFile(f)
    setPreview(f.type.startsWith('image/') ? URL.createObjectURL(f) : null)
    if (!f.type.startsWith('image/')) return
    setOcrBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', f)
      const res = await fetch('/api/extract-invoice', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudo leer el comprobante')
      const o = parseOcr(data)
      setForm(prev => ({
        ...prev,
        provider_ruc: o.provider_ruc || prev.provider_ruc, provider_name: o.provider_name || prev.provider_name,
        document_type: o.document_type || prev.document_type, document_series: o.document_series || prev.document_series,
        document_number: o.document_number || prev.document_number, amount: o.amount || prev.amount,
      }))
      toast.success('Comprobante leído con IA: verifique los datos')
    } catch (e) {
      toast.warning(errorMessage(e) + '. Ingrese los datos manualmente.')
    } finally { setOcrBusy(false) }
  }

  const reset = () => { setForm({ ...EMPTY, expense_date: todayLima() }); setFile(null); setPreview(null); setEditing(null); setDuplicate(null) }

  const startEdit = (e: Row) => {
    setEditing(e)
    setForm({
      mode: e.dispatch_id ? 'VIAJE' : 'UNIDAD', dispatch_id: e.dispatch_id || '', vehicle_plate: e.vehicle_plate || '',
      transport_request_id: e.transport_request_id || '', expense_type: e.expense_type, expense_date: e.expense_date, amount: String(e.amount),
      document_type: e.document_type || 'FACTURA', document_series: e.document_series || '', document_number: e.document_number || '',
      provider_ruc: e.provider_ruc || '', provider_name: e.provider_name || '', description: e.description || '', is_billable: !!e.is_billable,
      paid_by: e.paid_by, cash_box_id: e.cash_box_id || '', fuel_gallons: e.fuel_gallons ? String(e.fuel_gallons) : '',
      fuel_odometer: e.fuel_odometer ? String(e.fuel_odometer) : '', fuel_station_id: e.fuel_station_id || '',
    })
    setTab('nuevo')
  }

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!me) return
    if (form.mode === 'VIAJE' && !form.dispatch_id) return toast.error('Seleccione el despacho')
    if (form.mode === 'UNIDAD' && !form.vehicle_plate) return toast.error('Seleccione la unidad')
    if (!form.expense_type) return toast.error('Seleccione la categoría')
    if (!(Number(form.amount) > 0)) return toast.error('Ingrese un importe válido')
    if (form.paid_by === 'CAJA' && !form.cash_box_id) return toast.error('Seleccione la caja que pagó el vale')
    if (isFuel && (!(Number(form.fuel_gallons) > 0) || !(Number(form.fuel_odometer) > 0))) return toast.error('Combustible: ingrese galones y odómetro')
    if (cat?.requires_receipt && !file && !editing?.receipt_url) return toast.error(`${cat.label} requiere la foto o PDF del comprobante`)
    if (duplicate) return toast.error('Ese comprobante ya fue registrado')
    setSaving(true)
    let uploaded: string | null = null
    try {
      if (file) uploaded = await uploadReceipt(supabase, me, file)
      const hasDoc = form.document_type !== 'SIN_COMPROBANTE'
      const payload: Row = {
        expense_type: form.expense_type, expense_date: form.expense_date, amount: Number(form.amount),
        description: form.description.trim() || null, is_billable: form.is_billable,
        document_type: form.document_type, document_series: hasDoc ? form.document_series || null : null,
        document_number: hasDoc ? form.document_number || null : null,
        provider_ruc: form.provider_ruc || null, provider_name: form.provider_name || null,
        fuel_gallons: isFuel ? Number(form.fuel_gallons) : null, fuel_odometer: isFuel ? Number(form.fuel_odometer) : null,
        fuel_station_id: isFuel && form.fuel_station_id ? form.fuel_station_id : null,
        transport_request_id: form.mode === 'VIAJE' && form.transport_request_id ? form.transport_request_id : null,
        ...(uploaded ? { receipt_url: uploaded } : {}),
      }
      if (editing) {
        const { error } = await supabase.from('dispatch_expenses').update(payload).eq('id', editing.id)
        if (error) throw error
        if (uploaded && editing.receipt_url) await removeReceipt(supabase, editing.receipt_url)
        toast.success(editing.status === 'OBSERVADO' ? 'Corrección enviada: el gasto vuelve a la bandeja de aprobación' : 'Gasto actualizado')
      } else {
        const { error } = await supabase.from('dispatch_expenses').insert([{
          ...payload, source: 'WEB', created_by: me,
          dispatch_id: form.mode === 'VIAJE' ? form.dispatch_id : null,
          vehicle_plate: form.mode === 'UNIDAD' ? form.vehicle_plate : null,
          paid_by: form.paid_by, cash_box_id: form.paid_by === 'CAJA' ? form.cash_box_id : null,
        }])
        if (error) throw error
        toast.success('Gasto registrado: queda pendiente de aprobación')
      }
      reset()
      setTab('mis')
    } catch (e) {
      if (uploaded) await removeReceipt(supabase, uploaded)
      toast.error('No se guardó: ' + errorMessage(e))
    } finally { setSaving(false) }
  }

  const cancelExpense = async (e: Row) => {
    if (!confirm('¿Anular este gasto pendiente? Se eliminará el registro.')) return
    const { error } = await supabase.from('dispatch_expenses').delete().eq('id', e.id)
    if (error) return toast.error(error.message)
    await removeReceipt(supabase, e.receipt_url)
    toast.success('Gasto anulado')
    if (me) void loadMine(me)
  }

  if (isLoaded && !canWrite('caja-gastos')) return <div className="p-10 text-center text-slate-500">No tiene permiso para registrar gastos.</div>

  return (
    <div className="p-6 space-y-5 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><FileText className="w-6 h-6" />Registro de gastos</h1>
        <p className="text-sm text-slate-500">Gastos de viaje o de la unidad pagados por Caja, la empresa o el conductor. Todo gasto queda pendiente hasta que lo apruebe el Jefe de Distribución o el Administrador.</p>
      </div>

      <div className="flex bg-white border border-slate-200 rounded-xl overflow-hidden text-sm font-semibold">
        <button onClick={() => setTab('nuevo')} className={`flex-1 py-2.5 ${tab === 'nuevo' ? 'bg-[#002855] text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{editing ? 'Corregir gasto' : 'Nuevo gasto'}</button>
        <button onClick={() => setTab('mis')} className={`flex-1 py-2.5 ${tab === 'mis' ? 'bg-[#002855] text-white' : 'text-slate-600 hover:bg-slate-50'}`}>Mis gastos</button>
      </div>

      {tab === 'nuevo' ? (
        <form onSubmit={save} className="grid lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 space-y-4">
            {editing && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm flex items-start justify-between gap-3">
                <div><b>Corrigiendo gasto {EXPENSE_STATUS[editing.status]?.label.toLowerCase()}.</b>{editing.review_comment && <> Observación: “{editing.review_comment}”</>}</div>
                <button type="button" onClick={reset} className="text-amber-800"><X className="w-4 h-4" /></button>
              </div>
            )}
            <Card title="Asignación del costo" icon={<Truck className="w-4 h-4 text-blue-500" />}>
              {!editing && (
                <div className="flex gap-2 text-sm">
                  {(['VIAJE', 'UNIDAD'] as const).map(m => (
                    <button type="button" key={m} onClick={() => set({ mode: m, paid_by: m === 'UNIDAD' ? 'CAJA' : 'CONDUCTOR' })}
                      className={`px-3 py-1.5 rounded-lg border ${form.mode === m ? 'bg-blue-50 border-blue-400 text-blue-800 font-semibold' : 'border-slate-200'}`}>
                      {m === 'VIAJE' ? 'Gasto de un viaje' : 'Gasto de la unidad (sin viaje)'}
                    </button>
                  ))}
                </div>
              )}
              {form.mode === 'VIAJE' ? (
                <>
                  <L label="Despacho *">
                    <select disabled={!!editing} value={form.dispatch_id} onChange={e => set({ dispatch_id: e.target.value, transport_request_id: '' })} className="caja-input">
                      <option value="">Seleccione…</option>
                      {trips.map(t => <option key={t.id} value={t.id}>{t.dispatch_number} · {t.vehicle_plate || 'sin placa'} · {t.status}</option>)}
                    </select>
                  </L>
                  {trip && trip.requests?.length > 0 && (
                    <L label="Asignar a una OT del viaje (opcional)" hint="Si el gasto fue exclusivo de una entrega, para calcular su rentabilidad real.">
                      <select value={form.transport_request_id} onChange={e => set({ transport_request_id: e.target.value })} className="caja-input">
                        <option value="">Costo general del viaje</option>
                        {trip.requests.map((r: Row) => <option key={r.id} value={r.id}>{r.label}</option>)}
                      </select>
                    </L>
                  )}
                </>
              ) : (
                <L label="Unidad *">
                  <select disabled={!!editing} value={form.vehicle_plate} onChange={e => set({ vehicle_plate: e.target.value })} className="caja-input">
                    <option value="">Seleccione…</option>
                    {units.map(u => <option key={u.plate} value={u.plate}>{u.plate}{u.internal_code && u.internal_code !== u.plate ? ` · ${u.internal_code}` : ''} · {u.type}</option>)}
                  </select>
                </L>
              )}
              {!editing && (
                <L label="Pagado con *">
                  <div className="flex flex-wrap gap-2 text-sm">
                    {([['CONDUCTOR', 'Anticipo / dinero del conductor'], ['CAJA', 'Vale de una caja'], ['EMPRESA', 'Empresa (crédito o transferencia)']] as const)
                      .filter(([k]) => form.mode === 'VIAJE' || k !== 'CONDUCTOR').map(([k, l]) => (
                        <label key={k} className={`px-3 py-1.5 rounded-lg border cursor-pointer ${form.paid_by === k ? 'bg-blue-50 border-blue-400 font-semibold' : 'border-slate-200'}`}>
                          <input type="radio" className="hidden" checked={form.paid_by === k} onChange={() => set({ paid_by: k })} />{l}
                        </label>
                      ))}
                  </div>
                  {form.paid_by === 'CAJA' && (
                    <select value={form.cash_box_id} onChange={e => set({ cash_box_id: e.target.value })} className="caja-input mt-2">
                      <option value="">Seleccione la caja…</option>
                      {boxes.map(b => <option key={b.box_id} value={b.box_id}>{b.name} · saldo {money(b.balance)}</option>)}
                    </select>
                  )}
                  {form.paid_by === 'CONDUCTOR' && <p className="text-xs text-slate-500 mt-1">Se descuenta del anticipo del conductor en la liquidación del viaje.</p>}
                </L>
              )}
            </Card>

            <Card title="Gasto y comprobante" icon={<FileText className="w-4 h-4 text-blue-500" />}>
              <div className="grid sm:grid-cols-3 gap-3">
                <L label="Categoría *" className="sm:col-span-2">
                  <select value={form.expense_type} onChange={e => set({ expense_type: e.target.value })} className="caja-input">
                    <option value="">Seleccione…</option>
                    {groupCategories(cats).map(([g, list]) => (
                      <optgroup key={g} label={g}>{list.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}</optgroup>
                    ))}
                  </select>
                </L>
                <L label="Fecha del gasto *"><input type="date" max={todayLima()} value={form.expense_date} onChange={e => set({ expense_date: e.target.value })} className="caja-input" /></L>
              </div>
              {cat?.max_amount && <p className="text-xs text-slate-500">Tope por gasto de {cat.label}: {money(cat.max_amount)} (si lo supera, se marca para revisión).</p>}

              {isFuel && (
                <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 grid sm:grid-cols-4 gap-3">
                  <L label="Galones *"><input type="number" step="0.01" min="0" value={form.fuel_gallons} onChange={e => set({ fuel_gallons: e.target.value })} className="caja-input" /></L>
                  <L label="Odómetro (km) *" hint={unit ? `Actual: ${Number(unit.current_odometer || 0).toLocaleString('es-PE')} km` : undefined}>
                    <input type="number" min="0" value={form.fuel_odometer} onChange={e => set({ fuel_odometer: e.target.value })} className="caja-input" />
                  </L>
                  <L label="Grifo" className="sm:col-span-2">
                    <select value={form.fuel_station_id} onChange={e => set({ fuel_station_id: e.target.value })} className="caja-input">
                      <option value="">Otro / no registrado</option>
                      {stations.map(s => <option key={s.id} value={s.id}>{s.name}{s.has_credit ? ' (crédito)' : ''}</option>)}
                    </select>
                  </L>
                  {Number(form.fuel_gallons) > 0 && Number(form.amount) > 0 && (
                    <p className="sm:col-span-4 text-xs text-orange-800 flex items-center gap-1"><Fuel className="w-3 h-3" />Precio: {money(Number(form.amount) / Number(form.fuel_gallons))} por galón</p>
                  )}
                </div>
              )}

              <div className="grid sm:grid-cols-4 gap-3">
                <L label="Importe total (S/) *">
                  <input type="number" step="0.01" min="0" value={form.amount} onChange={e => set({ amount: e.target.value })} className="caja-input font-bold text-lg" placeholder="0.00" />
                </L>
                <L label="Tipo de comprobante">
                  <select value={form.document_type} onChange={e => set({ document_type: e.target.value })} className="caja-input">
                    {DOCUMENT_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </L>
                {form.document_type !== 'SIN_COMPROBANTE' && <>
                  <L label="Serie"><input value={form.document_series} onChange={e => set({ document_series: e.target.value.toUpperCase() })} className="caja-input uppercase" placeholder="F001" /></L>
                  <L label="Número"><input value={form.document_number} onChange={e => set({ document_number: e.target.value })} className="caja-input" placeholder="000123" /></L>
                </>}
                <L label="RUC del proveedor" hint={!rucOk ? 'RUC inválido (dígito verificador)' : undefined}>
                  <input value={form.provider_ruc} onChange={e => set({ provider_ruc: e.target.value.replace(/\D/g, '').slice(0, 11) })} className={`caja-input ${!rucOk ? 'border-red-400' : ''}`} />
                </L>
                <L label="Razón social" className="sm:col-span-3"><input value={form.provider_name} onChange={e => set({ provider_name: e.target.value })} className="caja-input" /></L>
              </div>
              {duplicate && (
                <div className="bg-red-50 border border-red-200 p-3 rounded-lg flex items-center gap-2 text-sm text-red-800">
                  <AlertTriangle className="w-4 h-4 shrink-0" />Comprobante ya registrado el {fmtDate(duplicate.expense_date)} por {money(duplicate.amount)} ({EXPENSE_STATUS[duplicate.status]?.label}).
                </div>
              )}
              <L label="Descripción / sustento"><textarea value={form.description} onChange={e => set({ description: e.target.value })} rows={2} className="caja-input" placeholder="Ej. Alquiler de montacargas en planta Arequipa" /></L>
              <label className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm cursor-pointer">
                <input type="checkbox" checked={form.is_billable} onChange={e => set({ is_billable: e.target.checked })} className="mt-1" />
                <span><b>Refacturar al cliente.</b> <span className="text-amber-800">El gasto lo originó el cliente y se incluye como costo extra en su factura.</span></span>
              </label>
            </Card>
          </div>

          <div className="space-y-4">
            <Card title="Comprobante" icon={<Camera className="w-4 h-4 text-blue-500" />}>
              {file ? (
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {preview ? <img src={preview} alt="Comprobante" className="w-full max-h-72 object-contain rounded-lg border" /> : <div className="p-6 text-center border rounded-lg bg-slate-50 text-sm"><FileText className="w-8 h-8 mx-auto text-slate-400" />{file.name}</div>}
                  <button type="button" onClick={() => { setFile(null); setPreview(null) }} className="absolute top-2 right-2 bg-slate-900/60 text-white rounded-full p-1"><X className="w-4 h-4" /></button>
                  {ocrBusy && <div className="absolute inset-0 bg-slate-900/60 rounded-lg flex items-center justify-center text-white text-sm font-semibold gap-2"><Wand2 className="w-4 h-4 animate-pulse" />IA leyendo comprobante…</div>}
                </div>
              ) : (
                <button type="button" onClick={() => fileRef.current?.click()} className="w-full h-40 border-2 border-dashed border-blue-300 bg-blue-50 rounded-xl flex flex-col items-center justify-center text-blue-700 font-semibold text-sm">
                  <Camera className="w-8 h-8 mb-2" />{editing?.receipt_url ? 'Reemplazar comprobante' : 'Tomar foto o subir (imagen o PDF)'}
                </button>
              )}
              <input ref={fileRef} type="file" className="hidden" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" onChange={e => pickFile(e.target.files?.[0])} />
              <p className="text-xs text-slate-500">Las imágenes se leen con IA para completar RUC, serie, número e importe. El archivo se guarda en un almacenamiento privado.</p>
            </Card>
            <button type="submit" disabled={saving || ocrBusy} className="w-full bg-[#002855] text-white py-3.5 rounded-xl font-bold flex items-center justify-center gap-2 disabled:opacity-50">
              {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}{editing ? 'Guardar corrección' : 'Registrar gasto'}
            </button>
            {plate && <p className="text-xs text-center text-slate-500">Se cargará al costo de la unidad <b>{plate}</b> cuando se apruebe.</p>}
          </div>
        </form>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-auto">
          {loadingMine ? <div className="p-12 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div> : (
            <DataTable className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500"><tr>
                <th className="p-3 text-left">Fecha</th><th className="p-3 text-left">Viaje / Unidad</th><th className="p-3 text-left">Categoría</th>
                <th className="p-3 text-left">Comprobante</th><th className="p-3 text-right">Monto</th><th className="p-3 text-left">Estado</th><th className="p-3" />
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {mine.length === 0 && <tr><td colSpan={7} className="p-10 text-center text-slate-400">Aún no ha registrado gastos</td></tr>}
                {mine.map(e => {
                  const st = EXPENSE_STATUS[e.status] || { label: e.status, cls: '' }
                  return (
                    <tr key={e.id}>
                      <td className="p-3 whitespace-nowrap">{fmtDate(e.expense_date)}</td>
                      <td className="p-3">{e.dispatch?.dispatch_number || 'Sin viaje'}<div className="text-xs text-slate-500">{e.vehicle_plate}</div></td>
                      <td className="p-3">{catLabel[e.expense_type] || e.expense_type}{alertsOf(e).length > 0 && <AlertTriangle className="inline w-3 h-3 ml-1 text-amber-600" />}</td>
                      <td className="p-3 text-xs">{e.document_type ? `${e.document_type} ${e.document_series || ''}-${e.document_number || ''}` : '—'}</td>
                      <td className="p-3 text-right font-bold">{money(e.amount)}{e.status === 'APROBADO' && Number(e.approved_amount) !== Number(e.amount) && <div className="text-xs text-emerald-700">aprob. {money(e.approved_amount)}</div>}</td>
                      <td className="p-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${st.cls}`}>{st.label}</span>
                        {e.review_comment && ['OBSERVADO', 'RECHAZADO'].includes(e.status) && <div className="text-xs text-slate-600 mt-1 max-w-56">“{e.review_comment}”</div>}
                      </td>
                      <td className="p-3 whitespace-nowrap text-right">
                        {['PENDIENTE', 'OBSERVADO'].includes(e.status) && <button onClick={() => startEdit(e)} title="Corregir" className="p-1.5 hover:bg-slate-100 rounded"><Pencil className="w-4 h-4 text-blue-600" /></button>}
                        {e.status === 'PENDIENTE' && !e.first_approved_by && <button onClick={() => cancelExpense(e)} title="Anular" className="p-1.5 hover:bg-slate-100 rounded"><Trash2 className="w-4 h-4 text-red-600" /></button>}
                        {e.status === 'APROBADO' && <CheckCircle2 className="inline w-4 h-4 text-emerald-600" />}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </DataTable>
          )}
        </div>
      )}
    </div>
  )
}

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
      <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">{icon}{title}</h3>
      {children}
    </div>
  )
}

function L({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`block ${className || ''}`}>
      <span className="block text-xs font-bold text-slate-600 mb-1">{label}</span>
      {children}
      {hint && <span className={`block text-[11px] mt-0.5 ${hint.includes('inválido') ? 'text-red-600' : 'text-slate-500'}`}>{hint}</span>}
    </label>
  )
}
