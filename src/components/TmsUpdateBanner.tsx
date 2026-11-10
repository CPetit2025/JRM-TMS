'use client'
import { useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { erpState, ingresosState } from '@/lib/update-status'
import { UpdateBanner, type UpdateSource } from './UpdateBanner'

// TMS: ERP desde su base; ingresos WMS desde la base WMS, con una consulta pública que solo devuelve fechas y estados.
const WMS_URL = process.env.NEXT_PUBLIC_WMS_SUPABASE_URL, WMS_ANON = process.env.NEXT_PUBLIC_WMS_SUPABASE_ANON_KEY, WMS_ORIGIN = process.env.NEXT_PUBLIC_WMS_ORIGIN

export function TmsUpdateBanner() {
  const load = useCallback(async () => {
    const db = createClient(), now = new Date()
    const { data, error } = await db.rpc('data_update_status')
    if (error) throw error
    const sources: UpdateSource[] = [{
      key: 'erp', title: 'ERP: stock y contratos', state: erpState(data.erp, now),
      request: data.erp?.can_request ? async () => { const { error } = await db.rpc('erp_robot_request'); if (error) throw error } : undefined,
    }]
    if (WMS_URL && WMS_ANON) {
      // Sin sesión WMS: si la base WMS no responde, el banner muestra solo el ERP.
      const r = await fetch(`${WMS_URL}/rest/v1/rpc/wh_public_update_status`, {
        method: 'POST', headers: { apikey: WMS_ANON, authorization: `Bearer ${WMS_ANON}`, 'content-type': 'application/json' }, body: '{}',
      }).catch(() => null)
      if (r?.ok) sources.push({
        key: 'ingresos', title: 'Ingresos WMS', state: ingresosState((await r.json()).ingresos, now),
        href: WMS_ORIGIN ? `${WMS_ORIGIN.replace(/\/$/, '')}/almacen/actualizaciones` : undefined, actionLabel: 'Actualizar en WMS',
      })
    }
    return sources
  }, [])
  return <UpdateBanner load={load}/>
}
