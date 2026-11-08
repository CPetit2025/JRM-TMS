import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export type LabelKind = 'PAQUETE' | 'LPN'
export type LabelFormat = { id: string; name: string; width_mm: number; height_mm: number; dpi: number; is_active: boolean }

// Tamaños con que se imprimía antes de la configuración: se usan si la base aún no responde.
export const FALLBACK_FORMAT: Record<LabelKind, LabelFormat> = {
  PAQUETE: { id: '', name: 'Zebra 6 x 4 pulg (horizontal)', width_mm: 152.4, height_mm: 101.6, dpi: 203, is_active: true },
  LPN: { id: '', name: '100 x 50 mm', width_mm: 100, height_mm: 50, dpi: 203, is_active: true },
}

/** Formato asignado a un tipo de etiqueta en Configuración › Etiquetas. */
export function useLabelFormat(kind: LabelKind) {
  const [format, setFormat] = useState<LabelFormat>(FALLBACK_FORMAT[kind])
  useEffect(() => {
    let alive = true
    void createClient().from('wh_label_settings').select('format:wh_label_formats(id,name,width_mm,height_mm,dpi,is_active)').eq('kind', kind).maybeSingle()
      .then(({ data }) => {
        const f = data?.format as unknown as LabelFormat | null
        if (alive && f) setFormat({ ...f, width_mm: Number(f.width_mm), height_mm: Number(f.height_mm) })
      })
    return () => { alive = false }
  }, [kind])
  return format
}

/** Factor para encajar un diseño de etiqueta (en mm) dentro del formato, sin deformarlo. */
export const fitScale = (f: Pick<LabelFormat, 'width_mm' | 'height_mm'>, designW: number, designH: number) =>
  Math.min(f.width_mm / designW, f.height_mm / designH)

/** Medidas del formato en puntos de impresora (ZPL ^PW / ^LL). */
export const toDots = (mm: number, dpi: number) => Math.round(mm / 25.4 * dpi)
