import type { SupabaseClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

// Caja de transporte: utilidades compartidas por /caja y la app del conductor.

export type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export type ExpenseAlert = { code: string; level: 'ALTA' | 'MEDIA'; message: string }

export const money = (n: unknown, decimals = 2) =>
  `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`

export const fmtDate = (d: unknown, withTime = false) => {
  if (!d) return '—'
  const s = String(d)
  // Las fechas sin hora (YYYY-MM-DD) son del calendario de Lima: no se convierten de zona
  const date = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`) : new Date(s)
  return withTime
    ? date.toLocaleString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export const todayLima = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
export const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' })

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : 'Error inesperado')

export const EXPENSE_STATUS: Record<string, { label: string; cls: string }> = {
  PENDIENTE: { label: 'Pendiente', cls: 'bg-slate-100 text-slate-700' },
  OBSERVADO: { label: 'Observado', cls: 'bg-amber-100 text-amber-800' },
  APROBADO: { label: 'Aprobado', cls: 'bg-emerald-100 text-emerald-700' },
  RECHAZADO: { label: 'Rechazado', cls: 'bg-red-100 text-red-700' },
}

export const DOCUMENT_TYPES = [
  ['FACTURA', 'Factura'], ['BOLETA', 'Boleta'], ['TICKET', 'Ticket / Peaje'], ['RECIBO', 'Recibo por honorarios'],
  ['DECLARACION_JURADA', 'Declaración jurada'], ['SIN_COMPROBANTE', 'Sin comprobante'],
] as const

export const PAYMENT_METHODS = [['EFECTIVO', 'Efectivo'], ['TRANSFERENCIA', 'Transferencia'], ['TARJETA', 'Tarjeta'], ['YAPE_PLIN', 'Yape / Plin']] as const

export type ExpenseCategory = { code: string; label: string; group_label: string; ledger_category: string; requires_receipt: boolean; max_amount: number | null }

export async function loadCategories(supabase: SupabaseClient): Promise<ExpenseCategory[]> {
  const { data } = await supabase.from('expense_categories').select('code, label, group_label, ledger_category, requires_receipt, max_amount')
    .eq('is_active', true).order('sort_order')
  return (data || []) as ExpenseCategory[]
}

export const groupCategories = (cats: ExpenseCategory[]) => {
  const groups = new Map<string, ExpenseCategory[]>()
  cats.forEach(c => groups.set(c.group_label, [...(groups.get(c.group_label) || []), c]))
  return [...groups.entries()]
}

// ---- Comprobantes ----
// receipt_url guarda: una URL (registros antiguos), "caja_receipts/<uid>/..." (Caja web)
// o la ruta del bucket privado del conductor "<uid>/<despacho>/gastos/..." (app).
const CAJA_BUCKET = 'caja_receipts'
// Guías, packing list y Notas de Despacho del Asistente Documentario (ref = "dispatch_documents/<despacho>/<archivo>")
export const DOCS_BUCKET = 'dispatch_documents'

export async function uploadReceipt(supabase: SupabaseClient, userId: string, file: File) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')
  const path = `${userId}/${todayLima()}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from(CAJA_BUCKET).upload(path, file, { contentType: file.type })
  if (error) throw new Error('No se pudo subir el comprobante: ' + error.message)
  return `${CAJA_BUCKET}/${path}`
}

export async function removeReceipt(supabase: SupabaseClient, ref: string | null) {
  if (!ref) return
  const { bucket, path } = receiptLocation(ref)
  if (bucket) await supabase.storage.from(bucket).remove([path])
}

function receiptLocation(ref: string): { bucket: string | null; path: string } {
  if (/^https?:\/\//.test(ref) || ref.startsWith('blob:')) return { bucket: null, path: ref }
  if (ref.startsWith(`${CAJA_BUCKET}/`)) return { bucket: CAJA_BUCKET, path: ref.slice(CAJA_BUCKET.length + 1) }
  if (ref.startsWith(`${DOCS_BUCKET}/`)) return { bucket: DOCS_BUCKET, path: ref.slice(DOCS_BUCKET.length + 1) }
  return { bucket: 'driver_evidence', path: ref }
}

export async function receiptUrl(supabase: SupabaseClient, ref: string | null | undefined) {
  if (!ref) return null
  const { bucket, path } = receiptLocation(ref)
  if (!bucket) return path
  const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 10)
  return data?.signedUrl || null
}

export const isPdf = (ref: string | null | undefined) => !!ref && /\.pdf($|\?)/i.test(ref)

// Lectura IA del comprobante (/api/extract-invoice): separa serie y número "F001-00012"
export function parseOcr(data: Row) {
  const raw = String(data.document_number || '')
  const m = raw.match(/^([A-Z0-9]{1,4})\s*-\s*(\d+)$/i)
  const type = String(data.document_type || '').toUpperCase()
  return {
    provider_ruc: String(data.supplier_ruc || '').replace(/\D/g, ''),
    provider_name: String(data.supplier_name || ''),
    document_type: DOCUMENT_TYPES.some(([k]) => k === type) ? type : type.includes('BOLETA') ? 'BOLETA' : type.includes('FACT') ? 'FACTURA' : '',
    document_series: m ? m[1].toUpperCase() : '',
    document_number: m ? m[2] : raw,
    amount: data.amount != null ? String(data.amount).replace(/[^0-9.]/g, '') : '',
  }
}

// RUC peruano: 11 dígitos, prefijo válido y dígito verificador (misma regla que public.is_valid_ruc)
export function isValidRuc(ruc: string) {
  if (!/^(10|15|16|17|20)\d{9}$/.test(ruc)) return false
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const s = w.reduce((acc, wi, i) => acc + wi * Number(ruc[i]), 0)
  let d = 11 - (s % 11)
  if (d === 10) d = 0
  if (d === 11) d = 1
  return d === Number(ruc[10])
}

export const alertsOf = (e: Row): ExpenseAlert[] => (Array.isArray(e?.alerts) ? e.alerts : [])

export const personName = (p: Row | null | undefined) => (p ? `${p.first_name || ''} ${p.last_name || ''}`.trim() || '—' : '—')

// RPC que devuelven { success, error }: lanza el error para el toast
export async function rpcOk<T = Row>(supabase: SupabaseClient, fn: string, args: Row): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  if (data && typeof data === 'object' && 'success' in data && !data.success) throw new Error(data.error || data.message || 'Operación rechazada')
  return data as T
}

// Imprime solo el bloque .caja-printable visible (ver globals.css)
export function printCaja() {
  document.body.classList.add('caja-print')
  const done = () => { document.body.classList.remove('caja-print'); window.removeEventListener('afterprint', done) }
  window.addEventListener('afterprint', done)
  window.print()
}

// Exporta hojas a Excel: { 'Hoja': filas }
export function exportXlsx(fileName: string, sheets: Record<string, Row[]>) {
  const wb = XLSX.utils.book_new()
  Object.entries(sheets).forEach(([name, rows]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ '': 'Sin datos' }]), name.slice(0, 31)))
  XLSX.writeFile(wb, fileName)
}

// Archivo del conductor (evidencia o comprobante) en su carpeta del bucket privado driver_evidence
export async function uploadDriverFile(supabase: SupabaseClient, userId: string, folder: string, file: File) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')
  const path = `${userId}/${folder}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('driver_evidence').upload(path, file, { contentType: file.type })
  if (error) throw new Error('No se pudo subir el archivo: ' + error.message)
  return path
}

export type AdvanceReason = {
  code: string; label: string; description: string | null; requires_trip: boolean; charge_to: 'VIAJE' | 'UNIDAD' | 'AREA'
  evidence_required: boolean; approval_by: 'CAJA' | 'JEFE'; max_amount: number | null; settlement_due_hours: number | null
  is_emergency: boolean; creates_failure: boolean; default_expense_type: string | null; sort_order: number; is_active: boolean
}
export const CHARGE_TO: Record<string, string> = { VIAJE: 'Viaje', UNIDAD: 'Unidad', AREA: 'Área' }

export async function loadAdvanceReasons(supabase: SupabaseClient, onlyActive = true): Promise<AdvanceReason[]> {
  let q = supabase.from('advance_reasons').select('*').order('sort_order')
  if (onlyActive) q = q.eq('is_active', true)
  const { data } = await q
  return (data || []) as AdvanceReason[]
}
