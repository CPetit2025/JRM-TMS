# Plan: indicadores (KPI) de supervisores de Despacho, Transporte y Asistente Documentario

Este plan es para revisarlo antes de implementar. Se toma como modelo lo que ya funciona en **Soporte Mecánico**:
- tiempos medidos contra un plazo;
- un índice de eficiencia;
- un informe mensual con recordatorio el día 1, donde los días de atraso descuentan puntos.

**Disponibilidad del dato:**
- **Disponible:** el sistema ya lo registra.
- **Ajuste:** el dato existe, pero falta guardarlo con hora o usuario.
- **Nuevo:** hay que empezar a registrarlo.

## 1. Supervisor de Despacho (aprueba solicitudes y programa)

| KPI | Fórmula | Fuente | Dato | Meta sugerida |
|---|---|---|---|---|
| Tiempo de aprobación | Solicitud creada → aprobada (`approved_at`) | `transport_requests`, `transport_request_events` | Disponible | 90 % en ≤ 2 h |
| Solicitudes observadas | Observadas ÷ recibidas (falta de partida o datos) | `budget_observation`, eventos | Disponible | ≤ 10 % |
| Tiempo de programación | Aprobada → despacho programado con unidad y conductor | `dispatch_requests`, `dispatches` | Disponible | ≤ 4 h |
| Cumplimiento de fecha solicitada | Entregados en la fecha pedida ÷ entregados | `dispatch_events` (ENTREGADO) contra la fecha de la solicitud | Ajuste: fijar «fecha comprometida» al programar | ≥ 95 % |
| Reprogramaciones | Reprogramadas ÷ programadas, por causa | eventos de solicitud | Ajuste: hacer obligatoria la causa | ≤ 5 % |
| Uso de flota | Viajes por unidad y día; carga ÷ capacidad | `dispatches`, Eficiencia de Flota (toneladas) | Disponible (peso parcial) | Según tipo de unidad |
| Desvío de costo | Costo real del viaje − tarifa cotizada | Tarifario y Caja | Disponible | ≤ 5 % |

## 2. Supervisor de Transporte / Jefe de Distribución

| KPI | Fórmula | Fuente | Dato | Meta sugerida |
|---|---|---|---|---|
| Salida puntual | Salida real (EN RUTA) contra la hora programada | `dispatch_events` | Ajuste: hora programada de salida | ≥ 90 % en ±30 min |
| Entrega a tiempo (OTD) | Entregados en fecha ÷ entregados | `dispatch_events` | Disponible | ≥ 95 % |
| Despachos atrasados sin cerrar | Despachos con fecha vencida abiertos (ya avisa la campana) | `dispatches` | Disponible | 0 |
| Checklist previo a la ruta | Viajes con checklist ÷ viajes | `driver_checklists` | Disponible | 100 % |
| Aprobación de gastos de viaje | Registrado → aprobado; porcentaje observado | `dispatch_expense_events` | Disponible | 90 % en ≤ 24 h |
| Liquidación de viaje a tiempo | Retorno → liquidación cerrada | Caja (liquidaciones) | Disponible | ≤ 48 h |
| Incidencias en ruta | Fallas e incidencias por cada 1 000 km | `maintenance_requests`, km de rutas | Disponible | Tendencia a la baja |
| Rendimiento | km/galón y costo por km por unidad | Eficiencia de Flota | Disponible | Según línea base |

## 3. Asistente Documentario

| KPI | Fórmula | Fuente | Dato | Meta sugerida |
|---|---|---|---|---|
| Tiempo de emisión de documentos | Despacho programado → `docs_ready_at` | `dispatches` (documentario F3) | Disponible (con usuario `docs_ready_by`) | 95 % antes de la salida |
| Salidas sin documentos listos | Despachos que salieron antes de `docs_ready_at` ÷ despachos con documentos | `dispatches`, `dispatch_events` | Disponible | 0 % |
| Reemisiones | Documentos reemitidos ÷ emitidos, por causa | `docs_reissue`, `docs_reissue_reason` | Disponible | ≤ 3 % |
| Errores devueltos por cliente o almacén | Guías corregidas por error de datos | `docs_reissue_reason` | Ajuste: lista de causas | ≤ 2 % |
| Retorno de guías firmadas (cargo) | Entrega → recepción de la guía firmada | `document_liquidations` | Nuevo: fecha de recepción del cargo | 90 % en ≤ 48 h |
| Liquidación documentaria | Despachos con documentación cerrada en el mes ÷ entregados | `document_liquidations` | Ajuste | ≥ 98 % |

## 4. Fases propuestas

**Fase 1 — Indicadores con datos existentes (sin cambiar procesos).**
- Pantalla «Desempeño por rol» con una pestaña por rol, el mismo índice 0–100 y el detalle por persona.
- Solo usa lo marcado como *Disponible*.
- Atribución por usuario: `approved_by`, `docs_ready_by`, el actor de los eventos y quién aprobó los gastos.

**Fase 2 — Completar los datos que faltan.**
- Fecha comprometida y hora programada de salida al programar.
- Causa obligatoria al reprogramar.
- Lista cerrada de causas de reemisión.
- Recepción del cargo (guía firmada) con fecha y foto.

**Fase 3 — Informe mensual y recordatorio para cada rol.**
- Generalizar el informe de Soporte Mecánico a «informe mensual por rol»: recordatorio el día 1, vencimiento el día 3,
  atraso que descuenta puntos y revisión del jefe.
- Comparativo mes a mes y ranking del equipo.

## 5. Decisiones que necesitamos de usted

1. **Metas de cada KPI.** Las de arriba son sugeridas.
2. **Horario de medición.** ¿Los tiempos se miden en horas calendario o solo en horario laboral (por ejemplo,
   lunes a sábado de 7:00 a 19:00)?
3. **Pesos del índice por rol.** Propuesta: 40 % tiempo de respuesta, 30 % calidad (observadas, reemisiones, errores),
   15 % cumplimiento (OTD, checklist) y 15 % puntualidad del informe.
4. **Revisión de los informes.** ¿Quién revisa el informe de cada rol (Jefe de Distribución, Gerencia de Operaciones)?
5. **Inicio de las mediciones.** ¿Desde qué mes se mide? Se recomienda un mes de «marcha blanca» sin penalidad.
