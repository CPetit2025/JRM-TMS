import {
  ArchiveRestore, BadgeCheck, BadgeDollarSign, Banknote, BarChart3, BookOpenCheck, Briefcase, Building2, Calculator, CalendarClock, CalendarRange,
  ChartColumn, CircleCheckBig, CircleDot, ClipboardCheck, ClipboardList, Container, Database, Factory, FileSignature,
  FileText, FileUp, Fuel, Gauge, HardHat, Home, Hourglass, KeyRound, Map as MapIcon, MapPin, PackageCheck,
  PackageSearch, Radar, Receipt, ReceiptText, Route, Scale, Settings, Settings2, ShieldAlert, ShieldCheck, Sparkles, TriangleAlert,
  Timer, Truck, UserRound, Users, Wallet, Warehouse, Workflow, Wrench, Forklift, History, LayoutDashboard, type LucideIcon,
} from 'lucide-react'

// Menú lateral: una sola lista para el sidebar, el buscador y el título de cada página.
// `show` replica exactamente las condiciones de permiso del menú anterior: el menú solo decide qué se muestra;
// el acceso real lo controlan proxy.ts y las políticas de la base de datos.

export type Has = (permission: string) => boolean
export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  show: (has: Has) => boolean
  keywords?: string
}
export interface NavGroup { title?: string; items: NavItem[] }
export interface NavSection { id: string; title: string; icon: LucideIcon; groups: NavGroup[] }

const any = (...p: string[]) => (has: Has) => p.some(x => has(x))

export const HOME_ITEM = (isAdmin: boolean): NavItem => ({
  href: '/', label: isAdmin ? 'Dashboard Ejecutivo' : 'Inicio', icon: isAdmin ? BarChart3 : Home, show: () => true, keywords: 'inicio panel resumen',
})

export const NAV_SECTIONS: NavSection[] = [
  { id: 'analitica', title: 'Reportes y Analítica', icon: BarChart3, groups: [{ items: [
    { href: '/reportes', label: 'Centro de Analítica SCM', icon: BarChart3, show: any('dashboard', 'desempeno', 'reportes', 'despacho', 'monitoreo', 'caja', 'apt', 'mantenimiento-dashboard', 'flota-eficiencia', 'mantenimiento-soporte'), keywords: 'reportes analitica scm kpi indicador desempeno informes costos transporte flota apt avance' },
  ] }, { title: 'Reportes especializados', items: [
    { href: '/caja/reportes', label: 'Contabilidad y presupuestos', icon: ReceiptText, show: any('caja'), keywords: 'contabilidad presupuesto real rentabilidad reportes' },
    { href: '/mantenimiento/finanzas', label: 'Finanzas y TCO', icon: ChartColumn, show: any('mantenimiento-dashboard'), keywords: 'analitica costos tco' },

    { href: '/eficiencia-flota', label: 'Resumen y decisiones', icon: LayoutDashboard, show: any('flota-eficiencia', 'flota-eficiencia-carga'), keywords: 'eficiencia flota reemplazo tco costo por km' },
    { href: '/eficiencia-flota/transporte', label: 'Unidades de transporte', icon: Truck, show: any('flota-eficiencia', 'flota-eficiencia-carga'), keywords: 'costo por km tonelada km por galon' },
    { href: '/eficiencia-flota/equipos', label: 'Montacargas y elevación', icon: Forklift, show: any('flota-eficiencia', 'flota-eficiencia-carga'), keywords: 'montacargas horometro costo por hora plataforma' },
    { href: '/eficiencia-flota/rutas', label: 'Rutas y carga', icon: Route, show: any('flota-eficiencia', 'flota-eficiencia-carga'), keywords: 'toneladas viajes peso' },
    { href: '/eficiencia-flota/recambios', label: 'Recambios', icon: History, show: any('flota-eficiencia', 'flota-eficiencia-carga'), keywords: 'altas bajas renovacion' },
    { href: '/eficiencia-flota/datos', label: 'Datos y parámetros', icon: Database, show: any('flota-eficiencia', 'flota-eficiencia-carga'), keywords: 'carga excel horometro vida util' },
  ] }] },
  { id: 'comercial', title: 'Comercial', icon: Briefcase, groups: [{ items: [
    { href: '/clientes', label: 'Directorio Clientes', icon: Building2, show: any('clientes'), keywords: 'cliente ruc cartera' },
    { href: '/proveedores', label: 'Proveedores', icon: Factory, show: any('proveedores', 'clientes', 'solicitudes', 'despacho'), keywords: 'proveedor materia prima mp insumos produccion proyectos ruc recojo' },
    { href: '/contratos', label: 'Contratos y OTs', icon: FileSignature, show: any('ot'), keywords: 'ot contrato subcontrato' },
    { href: '/solicitudes', label: 'Solicitud de Transporte', icon: ClipboardList, show: any('solicitudes'), keywords: 'solicitud transporte pedido carga requerimiento' },
  ] }] },
  { id: 'operacion', title: 'Operación', icon: Truck, groups: [{ items: [
    { href: '/torre-control', label: 'Torre de Control', icon: Radar, show: any('monitoreo', 'despacho', 'torre-control'), keywords: 'torre control vista' },
    { href: '/despacho', label: 'Programación y Ruteo', icon: PackageCheck, show: any('despacho'), keywords: 'despacho programacion ruta viaje unidad' },
    { href: '/despacho/documentos', label: 'Documentos de Despacho', icon: FileText, show: any('documentario', 'packing-list', 'planificacion'), keywords: 'planificacion auditor guia packing nota documentario conformidad' },
    { href: '/monitoreo', label: 'Monitoreo GPS', icon: MapIcon, show: any('monitoreo'), keywords: 'gps mapa seguimiento' },
    { href: '/contratos/servicios', label: 'Registro de Servicios', icon: Receipt, show: any('contratos-servicios', 'clientes'), keywords: 'servicio realizado comprometido gasto montacarga grua estiba' },
  ] }] },
  { id: 'apt', title: 'Almacén APT', icon: Warehouse, groups: [{ items: [
    { href: '/apt', label: 'Estadía de Inventario', icon: Hourglass, show: any('apt', 'apt-carga'), keywords: 'apt estadia inventario fifo aging' },
    { href: '/apt/flujo', label: 'Flujo multi‑almacén', icon: Workflow, show: any('apt'), keywords: '647 540 st ventas flujo almacen' },
    { href: '/apt/flujo/trazabilidad', label: 'Trazabilidad', icon: Route, show: any('apt'), keywords: 'trazabilidad guia lote ot familia' },
    { href: '/apt/flujo/kardex', label: 'Kardex', icon: BookOpenCheck, show: any('apt'), keywords: 'kardex movimientos saldo' },
    { href: '/apt/cargas', label: 'Carga Diaria APT', icon: FileUp, show: any('apt-carga'), keywords: 'carga excel erp data' },
  ] }] },
  { id: 'flota', title: 'Flota y Mantenimiento', icon: Wrench, groups: [
    { title: 'Taller', items: [
      { href: '/mantenimiento', label: 'Centro de Control', icon: Gauge, show: any('mantenimiento-dashboard'), keywords: 'mantenimiento cmms' },
      { href: '/mantenimiento/fallas', label: 'Fallas y Backlog', icon: TriangleAlert, show: any('mantenimiento-fallas'), keywords: 'falla averia backlog' },
      { href: '/mantenimiento/soporte', label: 'Soporte Mecánico', icon: Timer, show: any('mantenimiento-soporte', 'mantenimiento-dashboard'), keywords: 'soporte mecanico tecnico respuesta productividad informe mensual kpi' },
      { href: '/mantenimiento/gestor-ot', label: 'Órdenes de Trabajo', icon: Wrench, show: any('mantenimiento-ot'), keywords: 'ot taller orden trabajo' },
      { href: '/mantenimiento/preventivos', label: 'Preventivos', icon: CalendarClock, show: any('mantenimiento-planes'), keywords: 'preventivo plan' },
      { href: '/mantenimiento/plan-anual', label: 'Planificación', icon: CalendarRange, show: any('mantenimiento-planes', 'mantenimiento-dashboard', 'mantenimiento-finanzas'), keywords: 'planificacion plan anual presupuesto calendario preventivo correctivo riesgo' },
      { href: '/mantenimiento/checklists', label: 'Inspecciones', icon: ClipboardCheck, show: any('mantenimiento-flota'), keywords: 'checklist inspeccion' },
    ] },
    { title: 'Activos', items: [
      { href: '/mantenimiento/flota', label: 'Flota 360°', icon: Truck, show: any('mantenimiento-flota'), keywords: 'flota unidad placa vehiculo' },
      { href: '/mantenimiento/neumaticos', label: 'Neumáticos', icon: CircleDot, show: any('mantenimiento-flota'), keywords: 'neumatico llanta' },
      { href: '/mantenimiento/inventario', label: 'Repuestos', icon: PackageSearch, show: any('mantenimiento-ot'), keywords: 'repuesto inventario almacen' },
      { href: '/mantenimiento/documentos', label: 'Cumplimiento', icon: ShieldAlert, show: any('mantenimiento-vencimientos'), keywords: 'soat revision vencimiento documento' },
    ] },
    { title: 'Alquiler', items: [
      { href: '/flota/contratos-alquiler', label: 'Contratos Alquiler', icon: KeyRound, show: any('mantenimiento-flota'), keywords: 'alquiler contrato' },
      { href: '/flota/liquidaciones-alquiler', label: 'Liq. Alquiler Seco', icon: Calculator, show: any('mantenimiento-flota'), keywords: 'alquiler liquidacion seco' },
    ] },
    { title: 'Gestión', items: [
      { href: '/mantenimiento/proveedores', label: 'Proveedores de Taller', icon: Factory, show: any('mantenimiento-flota'), keywords: 'proveedor taller' },
      { href: '/mantenimiento/copiloto', label: 'Copiloto IA', icon: Sparkles, show: any('mantenimiento-dashboard'), keywords: 'ia copiloto' },
    ] },
  ] },
  { id: 'caja', title: 'Caja de Transporte', icon: Wallet, groups: [{ items: [
    { href: '/caja', label: 'Panel de Caja', icon: Wallet, show: any('caja'), keywords: 'caja' },
    { href: '/caja/gastos', label: 'Registro de Gastos', icon: ReceiptText, show: any('caja-gastos'), keywords: 'gasto comprobante' },
    { href: '/caja/aprobaciones', label: 'Aprobación de Gastos', icon: BadgeCheck, show: any('caja-aprobacion'), keywords: 'aprobar gasto' },
    { href: '/caja/anticipos', label: 'Anticipos', icon: Banknote, show: any('caja-anticipos'), keywords: 'anticipo adelanto' },
    { href: '/caja/liquidaciones', label: 'Liquidación de Viajes', icon: CircleCheckBig, show: any('caja-liquidaciones'), keywords: 'liquidacion viaje rendicion' },
    { href: '/caja/conductores', label: 'Cuenta de Conductores', icon: UserRound, show: any('caja-anticipos', 'caja-liquidaciones'), keywords: 'conductor cuenta saldo' },
    { href: '/caja/cajas', label: 'Cajas y Fondos', icon: ArchiveRestore, show: any('caja-fondos'), keywords: 'caja fondo reposicion' },
    { href: '/caja/combustible', label: 'Control de Combustible', icon: Fuel, show: any('caja-combustible'), keywords: 'combustible petroleo galones' },
    { href: '/caja/tarifario', label: 'Reglas de Caja', icon: Scale, show: any('caja-tarifario'), keywords: 'tarifario reglas viaticos topes' },
  ] }] },
  { id: 'maestros', title: 'Catálogos', icon: Database, groups: [{ items: [
    { href: '/maestros/trabajadores', label: 'Trabajadores', icon: HardHat, show: any('maestros-trabajadores'), keywords: 'trabajador conductor ayudante' },
    { href: '/maestros/tarifas', label: 'Tarifario de Transporte', icon: BadgeDollarSign, show: any('tarifas'), keywords: 'tarifa flete precio' },
    { href: '/maestros/transportistas', label: 'Transportistas', icon: Container, show: any('tarifas'), keywords: 'transportista tercero proveedor' },
  ] }] },
  { id: 'admin', title: 'Administración', icon: Settings, groups: [{ items: [
    { href: '/usuarios', label: 'Usuarios del Sistema', icon: Users, show: any('usuarios'), keywords: 'usuario' },
    { href: '/permisos', label: 'Roles y Permisos', icon: ShieldCheck, show: any('permisos'), keywords: 'rol permiso' },
    { href: '/configuracion/ubicaciones', label: 'Geocercas (Bases)', icon: MapPin, show: any('configuracion'), keywords: 'geocerca base ubicacion' },
    { href: '/configuracion', label: 'Configuración General', icon: Settings2, show: any('configuracion'), keywords: 'configuracion ajustes' },
  ] }] },
]

// Sección e ítem visibles para el usuario (sin grupos ni secciones vacías)
export function visibleSections(has: Has): NavSection[] {
  return NAV_SECTIONS.map(s => ({ ...s, groups: s.groups.map(g => ({ ...g, items: g.items.filter(i => i.show(has)) })).filter(g => g.items.length) }))
    .filter(s => s.groups.length)
}

export interface NavEntry { item: NavItem; section: NavSection | null; group?: string }
export function flatEntries(sections: NavSection[], home?: NavItem): NavEntry[] {
  const out: NavEntry[] = home ? [{ item: home, section: null }] : []
  sections.forEach(s => s.groups.forEach(g => g.items.forEach(item => out.push({ item, section: s, group: g.title }))))
  return out
}

// Ítem activo: el de dirección más larga que coincide (así /apt/flujo/kardex marca Kardex y /contratos/123 marca Contratos)
export function activeEntry(entries: NavEntry[], pathname: string): NavEntry | null {
  let best: NavEntry | null = null
  for (const e of entries) {
    const h = e.item.href
    const hit = h === '/' ? pathname === '/' : pathname === h || pathname.startsWith(h + '/')
    if (hit && (!best || h.length > best.item.href.length)) best = e
  }
  return best
}

export const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
