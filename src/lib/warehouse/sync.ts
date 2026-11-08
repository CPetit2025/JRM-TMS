// Pide al servidor traer novedades del TMS (la base limita a una por minuto). Devuelve un aviso o ''.
export async function syncFromTms(force = false) {
  const response = await fetch(`/api/wms/sincronizar${force ? '?forzar=1' : ''}`, { method: 'POST' }).catch(() => null)
  if (!response) return 'Sin conexión con el servidor; se muestran los últimos datos.'
  if (response.status === 503) return ''
  const body = await response.json().catch(() => ({}))
  return body.ok === false && body.error ? `No se pudo sincronizar con TMS: ${body.error}` : ''
}
