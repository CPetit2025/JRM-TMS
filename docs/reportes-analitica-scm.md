# Reportes y Analítica SCM

Punto único de consulta `/reportes`. El registro operativo permanece en sus módulos; los dashboards conservan el avance personal en lectura. `/desempeno` conserva compatibilidad con enlaces anteriores.

## Matriz de indicadores y alcance

| Perspectiva | Fuente | Indicadores y fórmula | Fecha y filtros | Acceso |
|---|---|---|---|---|
| Transporte | dispatches y dispatch_requests | Despachos únicos; completados por estado; incidencias por despacho; solicitudes vinculadas sin duplicar viajes | Salida programada; cliente del contrato, contrato, origen/destino, placa, conductor, estado | despacho, monitoreo, torre-control o reportes |
| Costos | vw_trip_profitability (security_invoker) | Ingresos = flete + refacturable; gastos aprobados; margen = ingresos − gastos; margen % = margen / ingresos; costo por km = gastos / km positivos | Salida real; sede, contrato, placa, conductor, estado | caja |
| Mantenimiento | get_cmms_kpis (security_invoker) | Disponibilidad, MTBF, MTTR, preventivo y TCO según fórmulas existentes; backlog y estado son fotografía actual | Rango y placa; no se atribuyen costos a clientes | mantenimiento-dashboard |
| APT | apt_dashboard | Toneladas ingresadas, despachadas y saldo de la cohorte; aging según fecha de corte de la fuente | Fecha de ingreso, cliente, contrato, lote, familia; saldo no es snapshot histórico al fin del rango | apt |
| Eficiencia | fe_resumen | Costos normalizados, costo/km, costo/t·km, confianza y recomendación de activos existentes | Meses completos según el modelo de flota; no mezclar con costos contables | flota-eficiencia |
| Desempeño | kpi_tablero / kpi_mi_avance | Índice 0–100 según metas/pesos existentes; general = media no ponderada de roles con datos | Mes; rol, persona y calificación para revisión de equipos; el histórico filtrado se calcula desde kpi_historial | RPC valida revisor; personal solo propio |
| Informes y metas | RPC de desempeño y soporte | Flujos existentes de envío, observación y revisión | Mes, rol y estado según vista | Permisos existentes |

## Contratos de interacción

- Los filtros aplicables se muestran por perspectiva. Cambiar de perspectiva limpia dimensiones incompatibles; no se simulan filtros que la fuente no soporta.
- Período anterior usa igual cantidad de días; año anterior ajusta 29 de febrero. Fechas y etiquetas usan America/Lima.
- Consultas paginadas, orden estable, errores explícitos; nunca presentar una respuesta limitada como un total completo.
- No mostrar datos anteriores mientras se carga otra consulta. No exportar resultados mientras haya cambios pendientes o errores.
- Buscar, ordenar y paginar el detalle afecta también las métricas y gráficos cuando es un filtro; la paginación solo afecta la vista.
- Exportaciones incluyen filtros, fuentes, fecha de generación y todos los registros del resultado filtrado, no solo la página visible.
- Vistas guardadas por usuario en el navegador; no contienen credenciales. No conceden permisos ni copian datos del reporte.
- Puntualidad no equivale a OTIF; no se publica OTIF sin evidencia de entrega completa.
- Sin datos, cero y error son estados distintos. No sumar cifras de fuentes con distintas unidades o bases temporales.

## Entrega y validación

- Centro SCM con resumen, transporte, costos, mantenimiento, APT, eficiencia y desempeño. Los reportes contables y especializados de flota conservan sus herramientas y se agrupan en la misma sección de navegación.
- Avance propio en Inicio y Soporte en lectura; el dashboard del conductor conserva su tarjeta existente. Informes/SLA de Soporte se gestionan dentro del centro, con los permisos originales.
- Los gráficos permiten cambiar dimensión, granularidad y medida aditiva. Los promedios y ratios no se suman en las barras.
- `node scripts/test-analytics.cjs`: pruebas de rangos, cohortes, filtros, paginación, exportación y carreras de consultas en React.
- `node scripts/test-kpi-review.cjs`: cancelación, confirmación y ventana de informes. Ambas suites corren en la verificación de PR.
- No agrega migraciones ni cambia fórmulas SQL ni políticas RLS. La vista previa de Vercel valida el build con la configuración real; este entorno local no tiene variables de Supabase.

Los formularios de informes esperan la ficha y el registro del período antes de habilitar la edición; consultan el informe seleccionado aunque esté fuera de la lista reciente. Respuestas antiguas no sustituyen el texto de otro mes. La confirmación explícita también se aplica a la revisión de Soporte.
