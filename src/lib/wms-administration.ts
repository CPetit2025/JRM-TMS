export const WMS_PERMISSIONS = [
  ['almacen-lectura', 'Consulta de almacén'],
  ['almacen-etiquetado', 'Recepción y etiquetado'],
  ['almacen-picking', 'Picking'],
  ['almacen-packing', 'Packing y LPN'],
  ['almacen-carga', 'Carga y conciliación'],
  ['almacen-supervisor', 'Supervisión de almacén'],
  ['almacen-auditoria', 'Auditoría de despacho'],
  ['almacen-inventario', 'Gestión de inventarios'],
] as const

export function validateWmsAccount(body: Record<string, unknown>, creating: boolean) {
  for (const key of ['first_name', 'last_name', 'username', 'document_number', 'phone', 'role_id']) {
    if (typeof body[key] !== 'string' || (body[key] as string).length > 120) throw new Error('Datos de usuario inválidos')
  }
  const email = (body.username as string).trim().toLowerCase()
  if (!/^[^\s@]+@jrmsac\.com\.pe$/.test(email)) throw new Error('Se requiere correo corporativo @jrmsac.com.pe')
  if (!(body.first_name as string).trim() || !(body.last_name as string).trim() || !(body.document_number as string).trim() || (body.document_number as string).length > 20 || !body.role_id) throw new Error('Complete nombre, apellidos, documento y rol WMS')
  if (typeof body.is_active !== 'boolean') throw new Error('Seleccione el estado de acceso WMS')
  if (body.password !== undefined && typeof body.password !== 'string') throw new Error('Contraseña inválida')
  const password = body.password as string | undefined
  if ((creating || password) && (!password || password.length < 8 || password.length > 200)) throw new Error('La contraseña debe tener entre 8 y 200 caracteres')
  return { email, password }
}

export function validateWmsRole(body: Record<string, unknown>) {
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 50 || typeof body.description !== 'string' || body.description.length > 1000 || !Array.isArray(body.permissions)) throw new Error('Datos de rol inválidos')
  const allowed = new Set<string>(WMS_PERMISSIONS.map(([key]) => key))
  if (!body.permissions.every(p => typeof p === 'string' && allowed.has(p)) || !body.permissions.includes('almacen-lectura')) throw new Error('Seleccione permisos WMS válidos e incluya Consulta de almacén')
  return { name: body.name.trim(), description: body.description.trim(), permissions: [...new Set(body.permissions as string[])] }
}
