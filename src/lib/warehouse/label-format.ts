import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { DEFAULT_PRINT_PREFERENCES, orientLabel, printerSheet, readPrintPreferences, type PrintPreferences, type SheetSize } from './label-print-layout'

export type LabelKind = 'PAQUETE' | 'LPN'
export type LabelFormat = { id: string; name: string; width_mm: number; height_mm: number; dpi: number; is_active: boolean; ready?: boolean; output?: 'BROWSER'; paper?: SheetSize }

// Tamaños de respaldo cuando el almacén todavía no tiene un formato asignado.
export const FALLBACK_FORMAT: Record<LabelKind, LabelFormat> = {
  PAQUETE: { id: '', name: 'Zebra 6 x 4 pulg (horizontal)', width_mm: 152.4, height_mm: 101.6, dpi: 203, is_active: true },
  LPN: { id: '', name: '100 x 50 mm', width_mm: 100, height_mm: 50, dpi: 203, is_active: true },
}

export const PERSONAL_LABEL_FORMATS: LabelFormat[] = [
  { id: 'paper-a5-portrait', output: 'BROWSER', name: 'A5 vertical', width_mm: 148, height_mm: 210, dpi: 203, is_active: true },
  { id: 'paper-a5-landscape', output: 'BROWSER', name: 'A5 horizontal', width_mm: 210, height_mm: 148, dpi: 203, is_active: true },
];
const preferenceKey = (userId: string, kind: LabelKind) => `wh-label-paper:v7:${userId}:${kind}`;
// v7 (11/11/2026): todos parten de la etiqueta A5 acostada en página A4 (ver DEFAULT_PRINT_PREFERENCES); las preferencias anteriores se dejan de leer una vez.
const settingsKey = (userId: string, kind: LabelKind) => `wh-label-print:v7:${userId}:${kind}`;
const preferenceEvent = 'wh-label-paper-change';

/** Preferencia de impresora por cuenta y navegador; nunca cambia el formato de otros usuarios. */
export function usePersonalLabelFormat(kind: LabelKind) {
  const [format, setFormat] = useState<LabelFormat>({ ...FALLBACK_FORMAT[kind], ready: false });
  const [options, setOptions] = useState<LabelFormat[]>(PERSONAL_LABEL_FORMATS);
  const [selection, setSelection] = useState('');
  const [preferences, setPreferences] = useState<PrintPreferences>(DEFAULT_PRINT_PREFERENCES);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true, request = 0;
    const load = async () => {
      if (!alive) return;
      const current = ++request;
      setFormat(f => ({ ...f, ready: false }));
      try {
        const db = createClient();
        const [auth, assigned, catalog] = await Promise.all([
          db.auth.getUser(),
          db.from('wh_label_settings').select('format:wh_label_formats(id,name,width_mm,height_mm,dpi,is_active)').eq('kind', kind).maybeSingle(),
          db.from('wh_label_formats').select('id,name,width_mm,height_mm,dpi,is_active').eq('is_active', true),
        ]);
        if (!alive || current !== request) return;
        if (auth.error || !auth.data.user) throw new Error('Inicia sesión para cargar tu papel de impresión.');
        if (assigned.error || catalog.error) throw new Error('No se pudo cargar el papel de impresión. Vuelve a intentarlo.');
        const normalize = (f: LabelFormat) => ({ ...f, width_mm: Number(f.width_mm), height_mm: Number(f.height_mm), dpi: Number(f.dpi) });
        const available = [...PERSONAL_LABEL_FORMATS, ...(catalog.data || []).map(normalize)];
        const prefs = readPrintPreferences(localStorage.getItem(settingsKey(auth.data.user.id, kind)), localStorage.getItem(preferenceKey(auth.data.user.id, kind)) || '');
        const personal = available.find(f => f.id === prefs.formatId);
        const shared = assigned.data?.format as unknown as LabelFormat | null;
        setOptions(available);
        setSelection(personal?.id || '');
        const oriented = orientLabel(personal || (shared ? normalize(shared) : FALLBACK_FORMAT[kind]), prefs.orientation);
        const paper = printerSheet(prefs);
        setPreferences(prefs);
        setFormat({ ...oriented, paper, output: paper ? 'BROWSER' : oriented.output, ready: true });
        setError('');
      } catch (e) {
        if (!alive || current !== request) return;
        setError(e instanceof Error ? e.message : 'No se pudo cargar tu configuración.');
        setFormat(f => ({ ...f, ready: false }));
      }
    };
    const refresh = () => { void load(); };
    refresh();
    window.addEventListener('storage', refresh);
    window.addEventListener(preferenceEvent, refresh);
    window.addEventListener('focus', refresh);
    const { data: { subscription } } = createClient().auth.onAuthStateChange(() => { setTimeout(refresh, 0); });
    return () => {
      alive = false;
      subscription.unsubscribe();
      window.removeEventListener('storage', refresh);
      window.removeEventListener(preferenceEvent, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [kind]);
  const configure = async (patch: Partial<PrintPreferences>) => {
    try {
      const { data: { user }, error } = await createClient().auth.getUser();
      if (error || !user) throw new Error('Inicia sesión para guardar tu configuración.');
      if (patch.formatId && !options.some(f => f.id === patch.formatId)) throw new Error('Formato no disponible.');
      const current = readPrintPreferences(localStorage.getItem(settingsKey(user.id, kind)), localStorage.getItem(preferenceKey(user.id, kind)) || '');
      localStorage.setItem(settingsKey(user.id, kind), JSON.stringify({ ...current, ...patch }));
      window.dispatchEvent(new Event(preferenceEvent));
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar la configuración.'); }
  };
  const select = (id: string) => configure({ formatId: id });
  return { format, options, selection, select, preferences, configure, error };
}

/** Misma etiqueta y hoja personales en recepción, inventario, detalle y control. */
export function useLabelFormat(kind: LabelKind) {
  return usePersonalLabelFormat(kind).format;
}

/** Factor para encajar un diseño de etiqueta (en mm) dentro del formato, sin deformarlo. */
export const fitScale = (f: Pick<LabelFormat, 'width_mm' | 'height_mm'>, designW: number, designH: number) =>
  Math.min(f.width_mm / designW, f.height_mm / designH)

/** Medidas del formato en puntos de impresora (ZPL ^PW / ^LL). */
export const toDots = (mm: number, dpi: number) => Math.round(mm / 25.4 * dpi)
