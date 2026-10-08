# JRM Enterprise Design System — auditoría y pantalla piloto

Alcance: presentación, composición visual y accesibilidad. No se tocaron rutas, permisos, consultas, RPC, estados, cálculos
ni Supabase. El piloto es **Solicitud de Transporte** (`/solicitudes`).

## 1. Inventario (datos medidos sobre el código a 08/10/2026)

| Elemento | Cantidad / hallazgo |
|---|---|
| Páginas (`page.tsx`) | 95 en total; 75 en `(dashboard)`, 14 del app del conductor (`app/(app)`), 3 públicas de seguimiento, login y registro |
| Módulos con más páginas | APT 18, Mantenimiento 15, Caja 11, Eficiencia de flota 6 |
| Tablas | Ya hay `DataTable` compartido (81 archivos lo importan) con densidad y tipografía homogéneas; `TableActions` para el menú «···» |
| Modales | 42 archivos usan `ui/modal`; no se reemplazan |
| Color corporativo | `#002855` escrito a mano en 245 usos / 105 archivos (+441 `text-[#002855]`): faltaba un token central |
| Controles de filtro | 32 archivos con `h-11` propio; 7 con `caja-input`: alturas iguales pero clases repetidas |
| Paginación | Un solo componente (`TablePagination`); otras 7 pantallas tienen la suya o no paginan |
| Insignias de estado | Definidas a mano en cada pantalla (11 archivos con `rounded-full px-2…`) |
| Tarjetas KPI | 38 archivos con contadores/KPI propios, con estilos distintos |
| Título de página | 46 de 75 pantallas repiten un `<h1>` visual aunque la barra superior ya muestra sección + pantalla |
| Encabezado de la app | Ya muestra «SECCIÓN / Pantalla», perfil y notificaciones (`app-layout.tsx`); no se modificó |

## 2. Matriz de diagnóstico (por módulo)

| Módulo | Diseño actual | Problema UX/UI | Mejora propuesta | Riesgo |
|---|---|---|---|---|
| Solicitud de Transporte | Tabla ya compacta; KPI como pestañas de texto | Estados poco visibles, filtros sin etiqueta, paginación sin números | **Piloto hecho** (sección 4) | Bajo |
| Despacho / Documentos / Registro de servicios | **Aplicado (etapa 5a)**: `PageHeader`, KPI reales, `FilterToolbar`, `StatusBadge` | Filtros ocultos tras «Filtros avanzados»; insignias propias | Hecho; la lógica no cambió | Bajo |
| Torre de Control / Monitoreo | Mapa y paneles propios | Tarjetas con estilos propios | `KpiStatCard` solo en indicadores; mapa se conserva | Medio |
| Contratos y OT | Tablas con `DataTable` | Insignias y filtros distintos entre sí | `StatusBadge`, `FilterToolbar` | Bajo |
| Caja (11 pantallas) | Estilo propio (`caja-input`) | Formularios y tarjetas sin estructura común | `FormSection` + tokens | Medio (hay impresión de documentos: `caja-printable`) |
| Mantenimiento (15) | Mezcla de tableros y formularios | 14 títulos repetidos, KPI a mano | `PageHeader`, `KpiStatCard` | Medio |
| APT (18) | Vistas analíticas especializadas | Filtros y tarjetas heterogéneos | Solo tokens y `KpiStatCard`; se conservan sus gráficos | Medio |
| Eficiencia de flota (6) | Tablas + gráficos | IPR/recambios con paneles propios | Tokens y `StatusBadge` | Bajo |
| Maestros / Usuarios / Permisos | CRUD con modales | Formularios de alta sin estructura común | `FormSection`, `PageHeader` | Bajo |
| App del conductor (`/app`) | Móvil nativo (Capacitor) | — | **Fuera de alcance**: no se modifica | — |

## 3. Design System implementado

**Tokens** (`src/app/globals.css`, bloque `@theme`): `jrm-navy`, `jrm-navy-dark`, `jrm-red`, `jrm-surface`, `jrm-canvas`,
`jrm-line`, radio `jrm`, sombra `jrm-card`. Se usan como utilidades (`bg-jrm-navy`, `rounded-jrm`, `shadow-jrm-card`).
Los usos antiguos de `#002855` siguen funcionando y se migran por módulo.

**Componentes** (reutilizan los existentes; solo se crearon los que faltaban):

| Componente | Archivo | Estado |
|---|---|---|
| ProcessNavigation | `components/transport/TransportWorkflow.tsx` | Adaptado (subtítulo por etapa, activa en azul marino, Torre de Control aparte); mismos permisos |
| PageHeader | `components/ui/page-header.tsx` | Nuevo: `h1` accesible, descripción breve y acción primaria; no repite el título |
| KpiStatCard | `components/ui/kpi-stat-card.tsx` | Nuevo: icono, valor, tono semántico; con `onClick` funciona como filtro (`aria-pressed`) |
| FilterToolbar / FilterField | `components/ui/filter-toolbar.tsx` | Nuevo: búsqueda + fechas + tipo + estado + «Limpiar» en una tarjeta; clase `filterControl` única |
| StatusBadge | `components/ui/status-badge.tsx` | Nuevo: tonos success / warning / danger / info / special / neutral |
| PaginationControls | `components/ui/table-pagination.tsx` | Ampliado: números de página, «Registros por página», etiqueta y tamaños configurables |
| EnterpriseDataTable | `components/ui/data-table.tsx` + `table-actions.tsx` | Existente, sin cambios |
| Modal / ConfirmDialog / DetailDrawer / FormSection / EmptyState / LoadingState | — | Pendientes de la etapa de despliegue (los modales existentes se conservan) |

## 4. Pantalla piloto: Solicitud de Transporte

Orden: navegación del proceso → descripción → 5 tarjetas KPI + «Nueva Solicitud» → filtros → tabla → paginación.

- **KPI**: Todas, Pendientes, Aprobadas, Asignadas, Reprogramadas. Los valores siguen saliendo de `requests` (consulta real) y cada
  tarjeta aplica el mismo filtro de estado de antes.
- **Filtros**: se conservan los cinco criterios (búsqueda, desde, hasta, tipo de servicio, estado) y «Limpiar»; ahora con etiquetas visibles.
- **Tabla**: mismas siete columnas, orden, acciones («Ver detalle» + menú) y tarjetas apiladas en móvil. Reprogramada pasa de ámbar a morado
  (estado especial); el resto de tonos se mantiene.
- **Paginación**: «Mostrando 1 a N de M registros», números de página y 10/25/50/100 por página (antes 25/50/100).

## 5. Verificación realizada

- `tsc --noEmit` sin errores. ESLint: sin errores nuevos (2 preexistentes en `modal.tsx` y `SearchableSelect.tsx`).
- `npm run check:guards`, `test-analytics`, `test-kpi-review`: ver el resultado en el PR.
- `next build` correcto; capturas del piloto con datos simulados en escritorio (1680 px), tableta (820 px) y móvil (390 px).
  Las capturas usan datos de ejemplo solo para la prueba visual; el código no contiene datos ficticios.

## 6. Riesgos y pendientes

- No se probó con datos reales de producción: se valida visualmente en la vista previa de Vercel del PR.
- Cambiar `TransportWorkflow` afecta también a Despacho, Documentos, Registro de servicios y Torre de Control (solo su aspecto).
- El tamaño de página por defecto sigue siendo 25 (el modelo propone 5): decisión de negocio.

## 7. Plan de aplicación (tras aprobar el piloto)

1. Despacho + Documentos + Registro de servicios (mismo flujo): `PageHeader`, `FilterToolbar`, `StatusBadge`.
2. Contratos y OT, Clientes, Maestros: formularios con `FormSection`.
3. Caja (cuidando la impresión) y Mantenimiento.
4. APT y Eficiencia de flota: solo tokens, KPI e insignias; se respetan sus vistas analíticas.
5. Auditoría final de accesibilidad y regresiones.

## 8. Versión compacta aprobada (referencia 2, 08/10/2026)

La segunda imagen aprobada de Solicitud de Transporte prioriza ver más registros. Medidas aplicadas (referencia → resultado):

| Bloque | Referencia | Implementación |
|---|---|---|
| Barra superior | 52–56 px | `h-14` (56 px); muestra solo la sección si la página lleva su título (`PageHeader showTitle`) |
| Título de página + acciones | 44–56 px | `PageHeader showTitle`: título, descripción y acciones (Nueva Solicitud, Torre de Control) en una fila |
| Navegación del proceso | 40–44 px | `TransportWorkflow` compacto (`h-10`, sin subtítulos; el subtítulo queda como tooltip). `torre={false}` + `TorreControlButton` para ubicarla en la fila del título |
| Barra de estados | 36–40 px | `InlineStatusBar`: ícono, nombre y contador por estado; mismos filtros y conteos reales que las tarjetas |
| Filtros | 40–44 px | `FilterToolbar compact` + `FilterField inline` (controles `h-10`) |
| Tabla | encabezado 38–42, filas 40–48 | `DataTable dense`; botones de fila de 32 px en escritorio (44 px en táctil) |
| Paginación | — | `TablePagination compact`: «Mostrando 1 - 14 de 14 resultados», filas por página y números de página |
| Separación entre bloques | 8–12 px | `gap-2.5` |

Resultado medido con las mismas 14 solicitudes de ejemplo a 1680 × 940: antes se veían 4 filas completas; ahora 9.

Alcance: `TransportWorkflow`, `FilterToolbar`, `DataTable`, `TablePagination`, `TableActions` y la barra superior son compartidos; cambian
solo en aspecto. Despacho, Documentos y Registro de servicios conservan por ahora sus tarjetas KPI (etapa 5a) y se pasarán a
`InlineStatusBar` tras aprobar esta versión.
