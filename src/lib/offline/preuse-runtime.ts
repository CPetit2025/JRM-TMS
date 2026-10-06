import type { SupabaseClient } from '@supabase/supabase-js'
import { toast } from 'sonner'
import { db } from './db'
import { syncPreuseRecords } from './preuse-sync'

export async function syncOwnPreuse(supabase: SupabaseClient) {
 const result = await syncPreuseRecords({
  pending: () => db.preuse.where('synced').equals(0).sortBy('created_at'),
  user: async () => (await supabase.auth.getUser()).data.user?.id || null,
  submit: async row => await supabase.rpc('submit_driver_preuse', { p_operation: row.operation_id, p_revision: row.unit_revision, p_captured_at: row.captured_at, p_data: row.data }),
  update: (id, changes) => db.preuse.update(id, changes),
 })
 if (result.synced) { toast.success(`${result.synced} inspección(es) sincronizada(s).`); window.dispatchEvent(new Event('jrm:trip-changed')) }
 if (result.pending) toast.warning(`${result.pending} inspección(es) pendientes de confirmar. Revisa Checklist.`)
 window.dispatchEvent(new Event('jrm:preuse-queue-changed'))
 return result
}
