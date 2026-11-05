import { createClient } from '@/lib/supabase/client'
import { db, type WarehouseScanOutbox } from '@/lib/offline/db'

export async function queueWarehouseScan(row: Omit<WarehouseScanOutbox, 'client_event_id' | 'created_at'>) {
  const dup = await db.warehouseScans.where('task_id').equals(row.task_id).filter(item=>item.scanned_code===row.scanned_code&&item.event_type===row.event_type).first()
  if (dup) return dup.client_event_id
  const entry: WarehouseScanOutbox = { ...row, client_event_id: crypto.randomUUID(), created_at: new Date().toISOString() }
  await db.warehouseScans.put(entry)
  return entry.client_event_id
}

export async function pendingWarehouseScans(taskId?: string) {
  return taskId ? db.warehouseScans.where('task_id').equals(taskId).toArray() : db.warehouseScans.toArray()
}

export async function syncWarehouseScans(taskId?: string) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { synced: 0, pending: await pendingWarehouseScans(taskId), error: null as string|null }
  const client = createClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return { synced: 0, pending: await pendingWarehouseScans(taskId), error: 'Inicie sesión para sincronizar lecturas.' }
  const entries = await pendingWarehouseScans(taskId)
  let synced = 0; let errorMessage: string|null = null
  for (const row of entries) {
    if (row.profile_id !== user.id) { errorMessage = 'Hay lecturas offline capturadas por otro usuario en este dispositivo. Cierre su sesión y solicite sincronización con esa cuenta.'; break }
    const { error } = await client.rpc('wh_record_scan', {
      p_task_id: row.task_id, p_code: row.scanned_code, p_event: row.event_type,
      p_client_event_id: row.client_event_id, p_payload: { ...row.payload, captured_offline_at: row.created_at },
    })
    if (error) {
      await db.warehouseScans.update(row.client_event_id, { last_error: error.message })
      errorMessage = error.message
      if (/fetch|network|timeout|load failed/i.test(error.message)) break
    } else {
      await db.warehouseScans.delete(row.client_event_id)
      synced++
    }
  }
  return { synced, pending: await pendingWarehouseScans(taskId), error: errorMessage }
}

export async function removeFailedWarehouseScan(id: string) {
  await db.warehouseScans.delete(id)
}
