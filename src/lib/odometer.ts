import type { SupabaseClient } from '@supabase/supabase-js'
import { deliveryPhoto } from '@/lib/delivery'

/** Foto del odómetro (tablero): se reduce en el teléfono y se guarda en la evidencia privada del conductor. */
const extension = (type: string) => type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : type === 'image/heic' ? 'heic' : 'jpg'

export const odometerPhotoPath = (profileId: string, operation: string, type = 'image/jpeg') =>
  `${profileId}/odometro/${operation}.${extension(type)}`

export async function prepareOdometerPhoto(file: File): Promise<File> {
  return deliveryPhoto(file)
}

/** Sube la foto; si ya existe (reintento de la misma operación) se reutiliza. */
export async function uploadOdometerPhoto(supabase: SupabaseClient, path: string, file: Blob): Promise<string> {
  const { error } = await supabase.storage.from('driver_evidence').upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false })
  if (error && !/exist|duplicate/i.test(error.message)) throw error
  return path
}

export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error || new Error('No se pudo guardar la foto en el teléfono'))
    reader.readAsDataURL(file)
  })
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob()
}

/** Inspección guardada sin señal: sube la foto pendiente y devuelve los datos con la ruta de la foto. */
export async function resolvePendingOdometerPhoto(supabase: SupabaseClient, profileId: string, operation: string, data: Record<string, unknown>) {
  const pending = typeof data.odometer_photo_data === 'string' ? data.odometer_photo_data : null
  if (!pending) return data
  const blob = await dataUrlToBlob(pending)
  const path = await uploadOdometerPhoto(supabase, odometerPhotoPath(profileId, operation, blob.type), blob)
  const rest = { ...data }
  delete rest.odometer_photo_data
  return { ...rest, odometer_photo: path }
}

export const formatKm = (value: unknown) => value == null || value === '' ? '—' : `${Number(value).toLocaleString('es-PE', { maximumFractionDigits: 1 })} km`
