import { NAV_SECTIONS } from '@/lib/nav/navConfig'

// Catálogo único de permisos: lo usan la pantalla «Roles y Permisos», el menú (navConfig) y el control de acceso por
// página (web-access). Formato guardado en roles.permissions:
// - módulo con niveles: «módulo:read» (solo lectura) o «módulo:write» (lectura y escritura)
// - interruptor: la clave sola («caja-aprobacion», «ia:read:caja»)
// check:guards falla si el código usa una clave que no está aquí.

export type PermissionMode = 'level' | 'toggle'
export type PermissionLevel = 'none' | 'read' | 'write'
export type PermissionModule = { id: string; label: string; mode?: PermissionMode; hint?: string }
export type PermissionGroup = { title: string; hint?: string; modules: PermissionModule[] }

export const PERMISSION_GROUPS: PermissionGroup[] = [
  { title: 'Control de horas extras', hint: 'Módulo independiente. Piloto: Distribución. Además del rol, habilite el área y vincule a cada usuario (incluida Gerencia) en Configuración HHEE.', modules: [
    { id: 'hhee', label: 'Consulta de horas extras por área' },
    { id: 'hhee-solicitar', label: 'Solicitar HHEE y registrar resultados' },
    { id: 'hhee-aprobar', label: 'Aprobar HHEE como jefe del área' },
    { id: 'hhee-validar', label: 'Importar asistencia y validar HHEE (RR. HH.)' },
    { id: 'hhee-gerencia', label: 'Informe gerencial con costos agregados' },
    { id: 'hhee-excepciones', label: 'Revisar excepciones (Gerencia)' },
    { id: 'hhee-costos', label: 'Consultar costos individuales de HHEE' },
    { id: 'hhee-config', label: 'Configurar áreas, accesos y directorio HHEE' },
  ] },
  { title: 'Reportes y Analítica', modules: [
    { id: 'dashboard', label: 'Centro de Analítica (vista general)' },
    { id: 'reportes', label: 'Reporte de despachos y recojos' },
    { id: 'desempeno', label: 'Desempeño de todos los roles, informes y metas', mode: 'toggle' },
  ] },
  { title: 'Comercial', modules: [
    { id: 'clientes', label: 'Clientes' },
    { id: 'proveedores', label: 'Proveedores' },
    { id: 'ot', label: 'Contratos y OTs' },
    { id: 'solicitudes', label: 'Solicitud de Transporte' },
    { id: 'contratos-servicios', label: 'Registro de Servicios' },
  ] },
  { title: 'Operación', modules: [
    { id: 'torre-control', label: 'Torre de Control' },
    { id: 'despacho', label: 'Programación y Ruteo' },
    { id: 'despacho-aprobacion', label: 'Aprobar solicitudes de transporte' },
    { id: 'documentario', label: 'Documentos de Despacho (Asistente Documentario)' },
    { id: 'cierre-economico', label: 'Cierre económico (aprobar costos finales y reabrir)' },
    { id: 'monitoreo', label: 'Monitoreo GPS' },
    { id: 'planificacion', label: 'Planificación de despachos (consulta del auditor)' },
    { id: 'packing-list', label: 'Carga de Packing List (auditor)' },
  ] },
  { title: 'Almacén APT', modules: [
    { id: 'apt', label: 'Estadía de inventario y trazabilidad' },
    { id: 'apt-carga', label: 'Carga diaria ENTRADA/SALIDA y parámetros', mode: 'toggle' },
    { id: 'apt-admin', label: 'Administrar la analítica APT (áreas, clases, unidades y metodología)', mode: 'toggle' },
  ] },
  { title: 'Eficiencia de Flota', modules: [
    { id: 'flota-eficiencia', label: 'Costo, uso y decisión de reemplazo' },
    { id: 'flota-eficiencia-carga', label: 'Carga de historia, horómetro y parámetros', mode: 'toggle' },
  ] },
  { title: 'Flota y Mantenimiento', modules: [
    { id: 'mantenimiento-dashboard', label: 'Centro de Control de Mantenimiento' },
    { id: 'mantenimiento-flota', label: 'Flota 360°, inspecciones, neumáticos y alquiler' },
    { id: 'mantenimiento-vencimientos', label: 'Cumplimiento y vencimientos' },
    { id: 'mantenimiento-fallas', label: 'Fallas y backlog' },
    { id: 'mantenimiento-soporte', label: 'Soporte Mecánico (desempeño e informe mensual)' },
    { id: 'mantenimiento-ot', label: 'Órdenes de trabajo y repuestos' },
    { id: 'mantenimiento-planes', label: 'Preventivos y planificación' },
    { id: 'mantenimiento-finanzas', label: 'Presupuesto y planificación anual' },
  ] },
  { title: 'Caja de Transporte', modules: [
    { id: 'caja', label: 'Panel y reportes de Caja' },
    { id: 'caja-gastos', label: 'Registro de gastos' },
    { id: 'caja-aprobacion', label: 'Aprobar gastos de Caja', mode: 'toggle' },
    { id: 'caja-anticipos', label: 'Anticipos de viaje' },
    { id: 'caja-liquidaciones', label: 'Liquidación de viajes' },
    { id: 'caja-fondos', label: 'Cajas, fondos y arqueo' },
    { id: 'caja-combustible', label: 'Control de combustible' },
    { id: 'caja-tarifario', label: 'Reglas de Caja' },
  ] },
  { title: 'Proveedores logísticos', modules: [
    { id: 'proveedores-logisticos', label: 'Proveedores logísticos (personal, flota y servicios)' },
    { id: 'maestros-trabajadores', label: 'Personal interno (trabajadores)' },
    { id: 'tarifas', label: 'Tarifario de transporte' },
  ] },
  { title: 'Administración', modules: [
    { id: 'usuarios', label: 'Usuarios del sistema' },
    { id: 'permisos', label: 'Roles y permisos' },
    { id: 'configuracion', label: 'Configuración general y geocercas' },
  ] },
  { title: 'Permisos especiales', hint: 'Reemplazan reglas que dependían del nombre del rol. Su rol base las conserva siempre; márquelas para dárselas a otro rol.', modules: [
    { id: 'cartera-propia', label: 'Solo su cartera de OT (Responsable de OT)', mode: 'toggle', hint: 'Ve y edita solo las OT que tiene asignadas; puede asumir OT sin responsable. Sin Centro de Analítica.' },
    { id: 'entregas-validacion', label: 'Validar conformidad de entregas', mode: 'toggle', hint: 'Revisa y valida las guías firmadas que sube el conductor.' },
    { id: 'solo-documentos', label: 'Solo documentos de despacho (auditor)', mode: 'toggle', hint: 'Entra únicamente a Documentos de Despacho y su perfil.' },
  ] },
  { title: 'JRM IA', modules: [
    { id: 'ia:read:distribucion', label: 'IA: distribución, despachos y documentos', mode: 'toggle' },
    { id: 'ia:read:inventarios', label: 'IA: inventarios', mode: 'toggle' },
    { id: 'ia:read:mantenimiento', label: 'IA: mantenimiento', mode: 'toggle' },
    { id: 'ia:read:contratos', label: 'IA: contratos, solicitudes y tarifas', mode: 'toggle' },
    { id: 'ia:read:gerencia', label: 'IA: gerencia', mode: 'toggle' },
    { id: 'ia:read:caja', label: 'IA: caja', mode: 'toggle' },
    { id: 'ia:action:mantenimiento', label: 'IA: proponer mantenimiento', mode: 'toggle' },
  ] },
  { title: 'Permisos de datos', hint: 'No abren una pantalla propia: dan acceso a datos que usan otros módulos.', modules: [
    { id: 'flota', label: 'Unidades y conductores', hint: 'Fechas de SOAT/revisión y liquidaciones de alquiler' },
    { id: 'operaciones-live', label: 'Tareo en vivo' },
    { id: 'operaciones-revision', label: 'Revisión de tareos' },
    { id: 'operaciones-kpis', label: 'Indicadores operativos' },
  ] },
]

// Claves antiguas sin ningún efecto: no se ofrecen; se muestran como «sin efecto» si un rol aún las tiene.
export const OBSOLETE_PERMISSIONS = ['productos', 'servicios-realizados']

export const PERMISSION_MODULES = PERMISSION_GROUPS.flatMap(g => g.modules)
const MODULE_BY_ID = new Map(PERMISSION_MODULES.map(m => [m.id, m]))

export function moduleLevel(permissions: string[], id: string): PermissionLevel {
  if (permissions.includes(`${id}:write`) || permissions.includes(id)) return 'write'
  if (permissions.includes(`${id}:read`)) return 'read'
  return 'none'
}

export function setModuleLevel(permissions: string[], id: string, level: PermissionLevel): string[] {
  const rest = permissions.filter(p => p !== id && p !== `${id}:read` && p !== `${id}:write`)
  return level === 'none' ? rest : [...rest, `${id}:${level}`]
}

export function setToggle(permissions: string[], id: string, enabled: boolean): string[] {
  const rest = permissions.filter(p => p !== id)
  return enabled ? [...rest, id] : rest
}

// Etiqueta legible de una clave guardada («Programación y Ruteo · Solo lectura»)
export function describePermission(permission: string): { label: string; level: 'read' | 'write' | 'toggle' | 'obsolete' } {
  const toggle = MODULE_BY_ID.get(permission)
  if (toggle?.mode === 'toggle') return { label: toggle.label, level: 'toggle' }
  const match = permission.match(/^(.*):(read|write)$/)
  const id = match ? match[1] : permission
  const mod = MODULE_BY_ID.get(id)
  if (mod) return { label: mod.label, level: match?.[2] === 'read' ? 'read' : 'write' }
  return { label: permission, level: 'obsolete' }
}

// Opciones del menú que abre un permiso (para mostrarlo en el editor)
export function menuItemsFor(id: string): string[] {
  const has = (p: string) => p === id
  return NAV_SECTIONS.flatMap(s => s.groups.flatMap(g => g.items.filter(i => i.show(has)).map(i => i.label)))
}
