import type { OfflinePreuse } from './db'

type Dependencies = {
  pending: () => Promise<OfflinePreuse[]>;
  user: () => Promise<string | null>;
  submit: (row: OfflinePreuse) => Promise<{ data: { success?: boolean } | null; error: unknown }>;
  update: (id: string, changes: Partial<OfflinePreuse>) => Promise<unknown>;
}
let running: Promise<{ synced: number; pending: number }> | null = null
export function syncPreuseRecords(dependencies: Dependencies) {
  if (running) return running
  running = (async () => {
    let synced = 0, pending = 0
    for (const row of await dependencies.pending()) {
      const user = await dependencies.user()
      if (!user || user !== row.profile_id) continue
      try {
        const { data, error } = await dependencies.submit(row)
        if (error || data?.success !== true) throw error || new Error('El servidor no confirmó la inspección')
        await dependencies.update(row.operation_id, { synced: 1, last_error: undefined }); synced++
      } catch (error) {
        const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Sin confirmación del servidor'
        await dependencies.update(row.operation_id, { last_error: message }); pending++
      }
    }
    return { synced, pending }
  })().finally(() => { running = null })
  return running
}
