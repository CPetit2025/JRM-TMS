import type { SupabaseClient } from '@supabase/supabase-js'

// apt_dashboard y apt_operational_summary se guardan en la base por versión de datos. Si un filtro nuevo supera el
// límite de la petición, la petición se revierte: se registra aparte para que el cron lo calcule (uno o dos minutos).
const CACHED_READS = new Set(['apt_dashboard', 'apt_operational_summary'])
export const APT_BACKGROUND_MESSAGE = 'El análisis APT con estos filtros se está calculando en segundo plano. Vuelva a consultar en uno o dos minutos.'

type RpcError = { code?: string | null; message?: string | null } | null | undefined

/** Registra el cálculo en segundo plano si la lectura venció por tiempo; devuelve true cuando lo hizo. */
export async function requestAptBackgroundRead(supabase: Pick<SupabaseClient, 'rpc'>, fn: string, args: Record<string, unknown>, error: RpcError): Promise<boolean> {
  if (!error || !CACHED_READS.has(fn) || !/statement timeout|57014/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) return false
  try { await supabase.rpc('apt_read_cache_request', { p_fn: fn, p_args: args }) } catch { /* el aviso se muestra igual */ }
  return true
}
