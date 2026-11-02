# Control de Jornada de Transporte y Reporte mensual de flota: auditoría y plan

Propuesta para aprobación. **No se modificó código.** Base: master `ba51c9c` (01/11/2026). Los bosquejos son la
referencia visual; sus números son ilustrativos. Todo valor sale de los registros del TMS.

## 1. Auditoría: lo que existe hoy

| Pieza | Qué hay | Dónde |
|---|---|---|
| Reporte por unidad | Una placa por consulta, hasta 400 días. Vista Día/Semana/Mes, OT/OS/OC/RQ, costos, lecturas con foto, exportación Excel de 6 hojas y, desde #425, ahorro por consolidación | `/flota/reporte-unidad`, `unit_daily_report` (`20261024090000` + 3 parches), `unit_report_plates` |
| Jornada | **No existe como registro.** Se deriva de: checklist diario (`driver_preuse_inspections`), lecturas de odómetro con foto INICIO / CIERRE (`unit_odometer_readings`), cierre de jornada del conductor (`close_driver_workday`) y rutas del día | `20261016100000`, `20261007190000` |
| Km | Odómetro del día (inicio → cierre, o → inicio del día siguiente marcado `SIGUIENTE_INICIO`); GPS por ruta; km real (GPS u odómetro de ruta); estimado | `unit_daily_report` |
| Carga | `tn` = APT validado o peso declarado por parada; `tn_apt` = salida APT con conformidad validada | ídem |
| Alertas | Sin checklist, sin odómetro, sin cierre, km sin ruta, GPS incompleto (< 70 % del odómetro), odómetro retrocede o salta | ídem |
| Costos | `cost_allocations` por ruta (aplicado / pendiente) | parche `20261209100000` |
| Ahorro | `consolidation_savings` (hasta 366 días) | #423 |
| Incidencias | Eventos de ruta (INCIDENCIA, RETRASO, DESVIO), rechazos en destino (`delivery_rejections`), incidentes de unidad (`vehicle_incidents`) | varias |
| Mantenimiento | Solicitudes (`maintenance_requests` PENDIENTE) y planes con `next_due_km` / `next_due_date` | CMMS |
| Documentos y evidencias | `dispatch_documents` (GR, nota, packing), `dispatch_evidence`, fotos del checklist y del odómetro; `get_dispatch_detail_files` por ruta | Torre / Documentos |
| Librerías | `jspdf`, `recharts`, `exceljs`/`xlsx` y el helper `exportAptXlsx` ya instalados: **no hace falta agregar ninguna** | `package.json` |
| Permisos | `can_view_unit_report()` (admin, flota CMMS, despacho o flota-eficiencia) + sede; menú «Flota y Mantenimiento › Activos» | `20261016100000:157`, `navConfig.ts:100` |

### Hallazgos que el plan corrige

1. **Toneladas APT duplicadas.** Si dos paradas comparten la misma guía, sus kg APT se suman dos veces. Se corrige
   contando cada guía una sola vez por día.
2. **Alerta duplicada.** «Odómetro retrocede» puede aparecer dos veces en el mismo día. Se corrige.
3. **No escala a toda la flota.** `unit_daily_report` resuelve cada día con decenas de subconsultas. Para la tabla
   de toda la flota y el reporte mensual hace falta un cálculo de conjunto, agrupado por (unidad, día).
4. **«Sin cierre» casi nunca se activa.** El fin del día se infiere del inicio del día siguiente, así que la alerta
   solo aparece si no hay ninguna lectura posterior. Para el estado de jornada hay que distinguir el cierre
   **registrado** del cierre **inferido**.

## 2. Diseño

### Una sola fuente de cálculo

- **`fleet_workdays(desde, hasta, placas[])`** (nueva, de conjunto): una fila por (unidad, día) con los mismos
  campos y reglas de `unit_daily_report`, más estado de jornada, referencias OT/OC/OS/RQ, incidencias y ahorro. La
  usan las tres vistas.
- **`unit_daily_report`** sigue respondiendo igual, para no romper la exportación ni el enlace desde Flota 360°.
- **Detalle** = una fila de `fleet_workdays` + rutas, paradas, documentos y evidencias, con las funciones que ya
  existen por ruta.
- **Reporte mensual** = agregado de `fleet_workdays` del mes + incidencias y mantenimiento por unidad.

**No se crea ninguna tabla nueva.** Todo se calcula al leer y cada indicador apunta a sus registros de origen.

### Reglas que propongo (decisiones para aprobar)

| # | Regla | Propuesta |
|---|---|---|
| D1 | **Estado de jornada** | **Sin operación**: sin rutas, checklist ni lecturas. **Abierta**: hay inicio y no hay cierre registrado, y es hoy o no hay lectura posterior. **En revisión**: el fin se infirió del día siguiente, o hay alertas de odómetro (retrocede o salta), km sin ruta, GPS incompleto o falta el checklist. **Cerrada**: cierre registrado y sin esas alertas. |
| D2 | **Ahorro cuando faltan costos por hora** | No se muestra un valor: aparece «pendiente (faltan costos por hora)». Se aplica también en Control presupuestal, para que ambos digan lo mismo. Hoy esas horas suman 0 y el ahorro sale inflado. |
| D3 | **Estado mensual de la unidad** | **Con incidencias**: al menos una incidencia. **En proceso**: alguna jornada abierta o en revisión. **Cerrada**: todas las jornadas con operación están cerradas. |
| D4 | **Incidencias** | Eventos INCIDENCIA, RETRASO o DESVIO; rechazos en destino; incidentes de unidad. Cada una se cuenta una vez por su registro de origen. |
| D5 | **Dónde vive** | `/flota/reporte-unidad` pasa a ser «Control de Jornada» (Vista 1) y conserva sus vistas Semana/Mes, referencias y exportación; con una sola unidad funciona como hoy. El detalle va en `/flota/reporte-unidad/[placa]/[fecha]` y el mensual en `/flota/reporte-mensual`. No se elimina ninguna dirección. |
| D6 | **Unidades** | «Activas» = con al menos una jornada con operación en el mes. «Disponibles» = vehículos propios no externos de las sedes con acceso, sin las que están fuera de servicio. Se muestran por separado. |
| D7 | **Hallazgos** | «Unidad con mayor kilometraje», no «mejor unidad». El conductor con más actividad se mide por rutas, con los km al lado. |

## 3. Vistas (según los bosquejos)

**Vista 1 · Tabla.**
- Encabezado con rango de fechas, filtros combinables (conductor, unidad, estado) y búsqueda por OT, OC, OS, RQ,
  conductor o placa. Selector Tabla / Detalle. Exportar.
- Seis indicadores (rutas, km odómetro, km GPS, carga, APT y ahorro) que siguen a los filtros. El ahorro solo suma
  lo valorizado y avisa lo pendiente.
- Tabla con columnas agrupadas: Identificación, Kilometraje, Operación, Costos y Control. Se ordena por columna y
  tiene el encabezado fijo. «—» cuando no hay dato, nunca 0. Las filas se distinguen por estado.
- El desplegable de cada fila usa los mismos paneles que la Vista 2.

**Vista 2 · Detalle.**
- Volver a la tabla y Anterior / Siguiente, respetando los filtros y el orden elegidos.
- Seis indicadores.
- Paneles: Información, Kilometraje (con alerta cuando las fuentes difieren y la marca «inferido» en el fin
  tomado del día siguiente), Operación, Costos (valor, costo marginal y ahorro, con enlace al ahorro por servicio) y
  Documentos y soporte (abre el original).
- Línea de tiempo armada solo con eventos registrados: lectura de inicio, salida, paradas, entregas, incidencias,
  retorno y cierre. Sin evento, no se dibuja. Pestañas Recorrido, GPS e incidencias, y Observaciones.

**Vista 3 · Mensual.**
- Selector de mes y año.
- Ocho indicadores.
- Gráfico de rutas (línea) y toneladas (barras) por semana del mes, con las semanas parciales recortadas al mes,
  de modo que la suma da el total.
- Hallazgos según D7.
- Tabla por unidad que abre la Vista 1 filtrada.
- Rankings Top 5 con criterio seleccionable: km, toneladas, rutas y ahorro (este último solo valorizado).
- Alertas consolidadas, cada una con sus unidades y jornadas.
- Exportar PDF con jspdf (encabezado, período, indicadores, gráfico, unidades, alertas y totales) y Excel con
  exceljs (por unidad, jornadas, rutas, km, costos y alertas), con los mismos filtros que la pantalla.

**Navegación:** Mensual → Unidad → Jornadas → Detalle → Ruta, Documentos o Costos (Torre de Control, en su propia
ventana). Al volver se conservan período, filtros y posición, guardados en la dirección.

## 4. Fases

| Fase | Entrega | Pruebas |
|---|---|---|
| 1 Auditoría | Este documento | Aprobación |
| 2 Datos | `fleet_workdays` y su agregado mensual, corrección de tn APT y de la alerta duplicada, estado D1, incidencias D4, mantenimiento pendiente y regla D2 en `consolidation_savings` | PGlite: un viaje con varias OT y guías repetidas (sin duplicar km ni t), jornada abierta / inferida / cerrada / sin operación, incidencias sin duplicar, ahorro pendiente; Caja C210 en producción |
| 3 Vista 1 | Tabla, filtros, indicadores, desplegable, exportación; Semana/Mes y referencias se conservan | UI: filtros combinados actualizan indicadores, «—» sin dato, orden |
| 4 Vista 2 | Detalle, navegación, paneles, línea de tiempo y documentos | UI: anterior / siguiente respeta filtros; sin eventos inventados |
| 5 Vista 3 | Mensual, gráfico, rankings, alertas, PDF y Excel | Totales del gráfico = mensual = suma de la Vista 1 |
| 6 Integración | Navegación completa, permisos y rendimiento (un mes de toda la flota en menos de 3 s) | Recorrido de punta a punta; Caja tras cada despliegue |

Cada fase se publica por separado. Las direcciones actuales siguen funcionando.

## 5. Riesgos

- **Rendimiento con toda la flota:** se resuelve con el cálculo de conjunto y con índices donde haga falta
  (búsqueda APT por guía, `cost_allocations` por ruta), verificados contra producción con la prueba de Caja.
- **Ahorro limitado:** `consolidation_savings` acepta hasta 366 días y depende de los costos por hora (D2).
- **Peso declarado:** donde no hay APT, la carga es el peso declarado, y el reporte lo señala.
- **Más de una guía por parada:** hoy se toma una sola guía por parada. Se mantiene así y queda anotado.
