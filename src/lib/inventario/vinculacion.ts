import { createClient } from '@/lib/supabase/client'
import { aptApi } from '@/lib/apt/api'
import { MAX_FILE_BYTES, fileHash, parseWorkbook } from '@/lib/apt-analitica/workbook'
import { importAnaliticaFile } from '@/lib/apt-analitica/importFile'
import { recalcular } from './api'

// Carga única del Almacén APT: los archivos de «Cargar datos del ERP» alimentan el inventario multi-almacén, el APT
// clásico (con el peso APT de Registro de Servicios) y la Analítica APT y Distribución. Aquí: estado de cada uno,
// importación a la analítica y recálculo completo sin volver a subir archivos.
const supabase = createClient()

export interface VinculacionEstado {
  inventario: { data_min: string | null; data_max: string | null; model_from: string | null; snapshot_cutoff: string | null; dirty: boolean
    rebuilt_at: string | null; movimientos: number; sin_usar: number; sin_usar_desde: string | null; sin_usar_hasta: string | null
    cargas_en_preparacion: number; fotos_stock: number }
  clasico: { data_min?: string | null; data_max?: string | null; cutoff?: string | null; rebuilt_at?: string | null; corte_manual?: string | null; ultima_carga?: string | null }
  analitica: { importaciones: number; desde: string | null; hasta: string | null; filas: number; ultima: string | null }
  servicios: { con_guia: number; con_peso: number }
}

export async function vinculacionEstado(): Promise<VinculacionEstado> {
  const { data, error } = await supabase.rpc('apt_vinculacion_estado')
  if (error) throw new Error(error.message)
  if (!data?.success) throw new Error(data?.error || 'No se pudo consultar el estado')
  return data as VinculacionEstado
}

// Analítica: cada archivo se importa como «Movimientos» (el signo de Cantidad decide entrada o salida, igual que el
// inventario). Un archivo ya importado (misma huella) no se vuelve a importar. Devuelve null o el aviso de lo que faltó.
export async function syncAnalitica(files: File[], onProgress: (m: string) => void): Promise<string | null> {
  const { data: imps, error } = await supabase.rpc('apa_imports_list')
  if (error) return error.message
  const active = new Set(((imps ?? []) as Array<{ file_hash: string; status: string }>).filter(i => i.status === 'ACTIVA').map(i => i.file_hash))
  const today = new Date().toISOString().slice(0, 10)
  const problems: string[] = []
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) { problems.push(`${file.name}: supera ${MAX_FILE_BYTES / 1048576} MB`); continue }
    onProgress(`Analítica: leyendo ${file.name}…`)
    const buf = await file.arrayBuffer()
    const hash = await fileHash(buf)
    if (active.has(hash)) continue
    await new Promise(r => setTimeout(r, 0))
    const parse = parseWorkbook(buf, 'MOVIMIENTOS', { today, cutoff: null })
    if (!parse.sheets.length) { problems.push(`${file.name}: ${parse.skipped.map(x => `${x.sheet}: ${x.reason}`).join(' · ') || 'sin hojas de movimientos'}`); continue }
    const r = await importAnaliticaFile(supabase, { file, hash, parse }, 'MOVIMIENTOS', null, m => onProgress(`Analítica: ${m}`))
    if (!r.ok) problems.push(`${file.name}: ${r.text}`)
  }
  return problems.length ? problems.join(' · ') : null
}

// Recalcula y vincula todo con lo ya cargado: inventario, APT clásico (estadía y flujo) y peso APT de los servicios
export async function recalcularTodo(onProgress: (m: string) => void): Promise<string[]> {
  const avisos: string[] = []
  try {
    const rb = await recalcular(onProgress)
    if (rb.pending) avisos.push('El recálculo del inventario sigue en el servidor y termina solo en unos minutos.')
  } catch (e) { avisos.push(`Inventario: ${e instanceof Error ? e.message : 'no se pudo recalcular'}`) }
  onProgress('Recalculando el APT clásico (estadía y flujo)…')
  try { await aptApi.rebuildModels() } catch (e) { avisos.push(`APT clásico: ${e instanceof Error ? e.message : 'no se pudo recalcular'}`) }
  avisos.push(...await syncPesoServicios(onProgress))
  return avisos
}

export async function syncPesoServicios(onProgress: (m: string) => void): Promise<string[]> {
  onProgress('Actualizando el peso APT de los servicios…')
  const { data, error } = await supabase.rpc('servicios_actualizar_peso_apt')
  if (error) return [`Peso de servicios: ${error.message}`]
  // Sin permiso sobre servicios no es un error de la carga: otro usuario lo actualiza desde el Registro de Servicios
  if (data && data.success === false && !/permiso/i.test(String(data.error))) return [`Peso de servicios: ${data.error}`]
  return []
}
