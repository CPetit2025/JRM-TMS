'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
type Info = { operator_name: string; document_number: string | null; license_number: string | null; license_expiration: string | null; phone: string | null; notes: string | null; suppliers: { business_name: string; tax_id: string } }
export function RouteForkliftInfo({ dispatchId }: { dispatchId: string }) {
 const db = useMemo(() => createClient(), [])
 const [info, setInfo] = useState<Info | null>(null), [error, setError] = useState('')
 useEffect(() => {
  let alive = true
  void db.from('route_forklifts').select('operator_name,document_number,license_number,license_expiration,phone,notes,suppliers(business_name,tax_id)').eq('dispatch_id', dispatchId).maybeSingle().then(({ data, error }) => {
   if (alive) { if (error) setError('No se pudo consultar el apoyo de montacarga.'); else setInfo(data as unknown as Info | null) }
  })
  return () => { alive = false }
 }, [db, dispatchId])
 if (error) return <p role="alert" className="text-sm text-red-700">{error}</p>
 if (!info) return null
 return <section className="space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-[#002855]">
  <h3 className="font-bold">Montacarga</h3><p>{info.suppliers.business_name} · RUC {info.suppliers.tax_id}</p>
  <p>Montacarguista: <strong>{info.operator_name}</strong>{info.document_number ? ` · DNI ${info.document_number}` : ''}</p>
  <p>Licencia / acreditación: {info.license_number || 'Sin registrar'}{info.license_expiration ? ` · Vence: ${info.license_expiration}` : ''}</p>
  {info.phone && <p>Teléfono: {info.phone}</p>}{info.notes && <p>{info.notes}</p>}
 </section>
}
