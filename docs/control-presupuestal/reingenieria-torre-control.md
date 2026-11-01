# Reingeniería: Torre de Control y Control presupuestal por OT

Propuesta para aprobación. **No se modificó código.** Base verificada en el repositorio al 01/11/2026 (master `846cf7f`,
PR #407). Complementa: [especificación del control presupuestal](especificacion.md) (D1–D7, aprobada) y
[circuito económico](circuito-economico.md) (matriz de fuentes y contrato funcional, en producción).

**Aprobado el 01/11/2026** con las propuestas D1–D5 (§11). Ajustes al implementar, por evidencia del código:

- **Cierre final en tabla propia** (`dispatch_final_closures` + `dispatch_final_close_events`), no `dispatches.status = 'CERRADO'`:
  varias consultas (bandejas, `budget_movement_rows`, indicadores) tratan LIQUIDADO como estado final de la ruta y un
  cambio de estado las alteraba. LIQUIDADO se muestra ahora como «RUTA CERRADA».
- **Pestañas de Torre**: el detalle del viaje ya tenía Resumen, Ruta y seguimiento, Documentos, Fotos y evidencias,
  Costos e Historial; se agregó **Cierre del servicio** (cuatro estados, cierre final, excepción y reapertura).
- **Sin permiso nuevo**: cierre normal con `despacho` o `cierre-economico`; excepción y reapertura con
  `control-presupuestal-recomendar` (Jefe de Distribución).
- Los desvíos de costo de un viaje son los ítems en revisión de su liquidación económica: el estado económico los cubre.
- **Entrega 2** (Control presupuestal): detalle por OT `/despacho/control-presupuestal/[ot]` (Resumen, Viajes y costos,
  Por concepto, Desviaciones y alertas, Autorizaciones, Historial) sobre `budget_ot_detail`; ampliaciones (D4,
  `transport_budget_extensions`: solicita el Jefe, decide Gerencia y no la propia, suma al aporte propio con registro en
  `contract_budget_adjustments`); D2 (pendiente «combustible en tarifa»), D3 (combustible de km adicionales directo a su
  OT) y D5 (el reverso de la tarifa propia sigue al flete final aprobado; lo ya aplicado antes se conserva).
  Los filtros de transportista y de unidad están en «Viajes y costos». El tablero no filtra por responsable de la OT:
  ese dato no existe en la partida.

Responsabilidades objetivo:

- **Torre de Control**: ejecuta, monitorea, documenta, liquida y cierra **cada viaje**.
- **Control presupuestal**: consolida, analiza, supervisa y protege **la partida de cada OT**. No liquida viajes.

---

## 1. Diagnóstico del estado actual

### 1.1 Lo que ya existe (y no hay que reconstruir)

| Área | Qué hay hoy | Dónde |
|---|---|---|
| Seguimiento del viaje | Lista con filtros por estado (`ACTIVOS`, `RUTA`, `POR_CERRAR`, `HISTORIAL`), responsable y fecha; detalle con acciones operativas, tripulación, servicios y paradas, bitácora (`dispatch_events`), alertas de mantenimiento, etapas del flete, costos de descarga, evidencias | `src/app/(dashboard)/torre-control/page.tsx` (`get_tower_dispatches`) |
| Acciones operativas | Iniciar/retorno (`transition_dispatch_status`), cerrar ruta (`close_dispatch_route`), cierre operativo manual, agregar servicio en ruta, compartir acceso con tercero, cancelar | Torre de Control |
| Liquidación documentaria | Bandeja por período; guías, packing list, notas de despacho (`dispatch_documents`); conformidades (`delivery_conformities`: PENDIENTE→RECIBIDA→OBSERVADA/RECHAZADA→VALIDADA); fotos (`delivery_submissions`); **cierre documentario por servicio** (`documentary_closures`: PENDIENTE/EN_VALIDACION/OBSERVADO/COMPLETO, automático o manual, con lista de faltantes, reapertura e historial `documentary_closure_events`) | `/despacho/documentos`, `GuidesClosureTab`, `DocumentaryClosure` |
| Liquidación económica | «Costos por ruta» (antes Cierre económico): cola por ruta, ítems por servicio (flete, descargas, Caja) con estado POR_VALIDAR→EN_REVISION→APROBADO/OBSERVADO; estado de ruta `economic_closures` (PENDIENTE, EN_REVISION, OBSERVADO, CIERRE_PARCIAL, CERRADO, NO_APLICA); conforme masivo, costo distinto con motivo, indicadores | `/despacho/documentos/economico`, `EconomicClosurePanel` |
| Caja del viaje | Gastos con comprobante y aprobación (doble aprobación sobre umbral), anticipos, liquidación del conductor (`trip_settlements`), imputación automática a la OT (`budget_expense_sync`) | `/caja/**`, app del conductor |
| Partida por OT | Posición por familia de OT (asignado, comprometido, ejecutado, tope 80 %, niveles 70/80/100), margen pactado por OT/cliente, autorizaciones sobre el tope (Supervisor→Jefe→Gerencia, emergencia, vigencia), desvíos (sustento→recomendación→decisión), vista previa al programar, bloqueo al comprometer sobre el tope | `/despacho/control-presupuestal` (Resumen, Movimientos, Pendientes y autorizaciones) |
| Trazabilidad económica | Movimientos que explican comprometido y ejecutado sin doble conteo, conciliación (hoy **0 partidas con diferencia**, C203), pendientes accionables | `budget_movements`, `budget_pending` |
| Reparto multi-OT | Peso de la guía ERP → componentes → peso declarado → partes iguales; suma exacta con redondeo | `budget_route_shares` |
| Concurrencia | Toda reserva, gasto o aporte de una familia de OT se serializa contra la fila de la OT raíz (`transport_budget_balance` bloquea `FOR UPDATE`) | escenario 15 cubierto por diseño |

### 1.2 Lo que falta o está partido

| # | Brecha | Evidencia |
|---|---|---|
| B1 | **No hay cierre final del viaje.** `close_dispatch_route` pasa a LIQUIDADO consumiendo la partida, **sin mirar** el estado documentario ni el económico. La UI muestra LIQUIDADO como «CERRADO». | `20261007200000…sql:300-358`, `dispatch-execution.ts:18`, `dispatch-status.ts:6` |
| B2 | **El viaje se trabaja en tres pantallas.** Torre de Control solo enlaza a Documentos y a Costos por ruta; no muestra su estado. | `torre-control/page.tsx:316, 461, 465` |
| B3 | **Sin estado documentario por viaje.** Se guarda por servicio y se calcula al vuelo. | `economic_documentary_status()` (`20261111110000…sql:124`) |
| B4 | **Sin detalle financiero por OT.** El análisis por viaje, por concepto y la evolución no existen. Hoy son una lista plana de movimientos. | `control-presupuestal/movimientos` |
| B5 | **Ampliación presupuestal sin flujo.** El asignado cambia al registrar el contrato o al sincronizar con el ERP. El historial (`contract_budget_adjustments`) es parcial y solo lo lee el administrador. La autorización de Gerencia llega hasta el 100 % y no amplía la partida (correcto, regla R5). | `20260930120000…sql:110`, `20261028090000…sql:148` |
| B6 | **Combustible incluido en la tarifa (tercero):** un gasto de combustible de Caja en ruta de tercero se imputa como adicional, sin advertencia. | `budget_expense_sync` |
| B7 | **Km adicionales por OT:** `dispatch_service_additions.extra_km` se registra al agregar un servicio, pero el reparto no lo usa. | `20261011060000…sql:128-130` |
| B8 | **Historial por OT disperso:** eventos de autorizaciones, de desvíos, de cierre documentario y de ajustes, sin una línea de tiempo común. | 4 tablas `*_events` / `*_adjustments` |
| B9 | **Ajuste del flete final en ruta propia** (decisión pendiente de la etapa anterior). | `circuito-economico.md` §6 |

---

## 2. Inventario de funcionalidades reutilizables

| Funcionalidad | Se reutiliza en | Cómo |
|---|---|---|
| `DeliveryTable`, detalle de ruta, acciones | Torre · Ruta y seguimiento | Sin cambios |
| `GuidesClosureTab`, `DocumentaryClosure`, `register_dispatch_document`, conformidades | Torre · Liquidación documentaria | Se monta el mismo componente filtrado por el viaje |
| `EconomicClosurePanel`, `economic_closure_detail`, `economic_confirm`, `economic_closure_action` | Torre · Liquidación económica | Mismo componente, ahora dentro del viaje |
| `budget_route_allocations`, Caja del viaje | Torre · Liquidación económica | Se agrega como «Gastos imputados a la OT» |
| `documentary_closures`, `economic_closures`, `trip_settlements`, `budget_deviation_reviews` | Torre · Cierre final | Son los cuatro estados que se validan |
| `budget_positions`, `budget_movements`, `budget_pending` | Control presupuestal · tablero y detalle | Se agrupan por viaje y por concepto en el servidor |
| `BudgetAuthorizations`, `BudgetDeviations` | Control presupuestal · detalle OT | Filtrados por OT |
| Bandejas Documentos y Costos por ruta | Se mantienen como **listas de trabajo** que abren el viaje en Torre de Control | Se retiran recién en la Fase 5 |

---

## 3. Mapa de integración (origen único de cada dato)

| Dato | Se origina en | Lo modifica | Lo consultan |
|---|---|---|---|
| Solicitud, OT, peso, servicios especiales estimados | Solicitudes | Solicitudes (Comercial/Contratos) | Programación, Control presupuestal |
| Viaje, unidad, conductor, transportista, flete pactado | Programación y Despacho | Programación (hasta salir), Torre (servicio agregado) | Torre, Control presupuestal |
| **Compromiso** (flete por OT, servicio especial planificado) | Programar ruta | Programación / Torre (servicio agregado) / Registro (edición en ruta abierta) | Control presupuestal |
| Eventos, paradas, entregas, evidencias | App del conductor / Monitoreo | App, Monitoreo, Torre | Torre |
| Documentos y conformidades | App, Documentos | **Torre · Liquidación documentaria** | Cierre final |
| Gastos de Caja y anticipos | App / Caja | Caja (aprobación y liquidación del conductor) | Torre · Liquidación económica, Control presupuestal |
| **Ejecutado** | Cierre de ruta, Caja, cargos | Torre · Liquidación económica (costo final), Caja | Control presupuestal |
| Excepciones (autorizaciones, desvíos) | Control presupuestal | Supervisor/Jefe/Gerencia | Torre (aviso), Programación (bloqueo) |
| Asignado y ampliaciones | Contratos / ERP | Contratos (y flujo de ampliación, Fase 4) | Control presupuestal |

Ciclo del dinero (ya implementado, se mantiene):

1. **Compromiso**: se crea al programar o al agregar un servicio en ruta. Antes se valida contra el tope en `budget_preview` y en el disparador de saldo.
2. **Ejecución**: al cerrar la ruta, el compromiso pasa a ejecutado. En ruta propia, la tarifa se revierte y quedan Caja y combustible. Caja y los cargos ejecutan directo.
3. **Liberación**: se libera al cancelar el viaje, quitar una parada o anular un servicio. Una reprogramación con otro costo se registra como edición del flete, que ajusta la reserva y su renglón por OT (#404).
4. **Consumo** = ejecutado + comprometido vigente. Cada importe tiene una sola fuente (ver circuito-económico §3).

---

## 4. Modelo de datos propuesto (mínimo)

| Cambio | Por qué | Alternativa descartada |
|---|---|---|
| `dispatches.status = 'CERRADO'` como **cierre final** (el estado ya existe en `transition_dispatch_status`) + función `dispatch_final_close(dispatch, nota)` con validaciones y `dispatch_final_close_events` (quién, cuándo, excepciones aceptadas) | B1 sin estado nuevo; LIQUIDADO sigue significando «ruta cerrada operativamente y partida ejecutada» | Tabla de cierre paralela (otro estado más que sincronizar) |
| Vista o función `dispatch_closure_status(dispatch)` → `{operativo, documentario, economico, caja, desvios, final}` calculada (sin columnas nuevas) | B2/B3, un solo cálculo para Torre y Control presupuestal | Guardar el rollup (se desincroniza) |
| `budget_ot_detail(ot, desde, corte)` → agrupado por viaje y por concepto + serie del ejecutado por fecha, sobre `budget_movement_rows` | B4 sin otro libro | Agregar en el cliente (falla con >500 movimientos) |
| `transport_budget_extensions` (solicitud de ampliación: monto, motivo, evidencia, estado, Gerencia/Finanzas) que **al aprobarse** actualiza `contract_budgets.own_allocated_pen` y deja evento | B5 (≥100 %) | Usar autorizaciones (no cambian la partida, por diseño) |
| Disparador que registra todo cambio de `allocated_pen` en `contract_budget_adjustments` y lectura con `budget_can_read` | B5/B8 | — |
| Vista `budget_ot_timeline(ot)`: unión de eventos de autorizaciones, desvíos, ajustes de partida, cierres documentarios/económicos/finales y movimientos | B8 sin duplicar | Tabla de auditoría nueva |
| Pendiente `COMBUSTIBLE_EN_TARIFA` (tercero con gasto de combustible de Caja) en `budget_pending` | B6 (la regla depende de la decisión §11-D2) | — |
| Reparto: km adicionales de `dispatch_service_additions` asignados directo a la OT que los originó, resto por peso | B7 (depende de §11-D3) | — |

---

## 5. Flujo del viaje hasta su cierre

```
Programar ──► En ruta ──► Entregado ──► Retorno/Cierre operativo ──► LIQUIDADO ──► CERRADO (cierre final)
   │ compromiso      │ eventos, evidencias        │                         │ partida ejecutada      │ requiere:
   │ (tope 80 %)     │ gastos de Caja             │                         │                        │ · documentario COMPLETO (todos los servicios)
   │                 │                            │                         │                        │ · económico CERRADO o NO_APLICA
   ▼                 ▼                            ▼                         ▼                        │ · Caja del viaje sin gastos pendientes
Torre · Ruta y seguimiento ───────────► Torre · Liq. documentaria ──► Torre · Liq. económica ──► Torre · Cierre final
                                         (puede cerrarse antes que la económica, y viceversa)       │ · desvíos resueltos o autorizados
                                                                                                    └ excepción: Jefe de Distribución con motivo
```

- Los estados son **independientes**: documentario completo con económico pendiente es válido (escenario 13).
- El cierre final de un viaje **no cierra la OT**.
- Reabrir un cierre final requiere permiso, deja evento y devuelve el viaje a LIQUIDADO. Un gasto posterior ya reabre la cola económica (comportamiento actual).

## 6. Flujo del control presupuestal por OT

1. **Prevenir**: al programar o al agregar un servicio, `budget_preview` muestra el nivel. Sobre el 80 % se bloquea, salvo autorización vigente. Sobre el 100 % se bloquea y se pide ampliación.
2. **Registrar**: todo gasto ocurrido se ejecuta aunque supere el tope (R5). Registrar no es aprobar.
3. **Detectar**: niveles 70/80/100, desvíos de costo, gastos sin sustento, posibles duplicados, combustible estimado sin reemplazar, diferencias de conciliación.
4. **Explicar**: el Jefe pide sustento al Supervisor (`SUSTENTAR`, ya existe), recomienda, y Gerencia decide.
5. **Autorizar o ampliar**: excepción limitada a monto, OT y vigencia (existe); ampliación de partida (nuevo, Fase 4).
6. **Auditar**: línea de tiempo por OT.

---

## 7. Diseño de pantallas

### Torre de Control · detalle del viaje (pestañas en el modal existente)

| Pestaña | Contenido | Origen |
|---|---|---|
| Ruta y seguimiento | Lo actual: datos, OT, unidad, conductor, paradas, bitácora, incidencias, evidencias, acciones. Marca «Multi-OT» | Sin cambios |
| Liquidación documentaria | Documentos por servicio con estado, faltantes, conformidades, observaciones, subir/validar/reabrir | `GuidesClosureTab` + `DocumentaryClosure` filtrados |
| Liquidación económica | Planificado vs. comprometido vs. ejecutado por concepto y OT; ítems (conforme, costo distinto, observar); Caja del viaje con comprobantes; imputación a cada OT; gastos sin sustento | `EconomicClosurePanel` + `budget_route_allocations` |
| Cierre final | Semáforo de los 4 estados + desvíos; qué falta y quién lo resuelve; botón «Cerrar servicio» (o «Cerrar con excepción», con motivo) | `dispatch_closure_status` + `dispatch_final_close` |

En la lista: filtros nuevos «Documentación pendiente», «Económico pendiente» y «Listo para cerrar», junto a `POR_CERRAR`.

### Control presupuestal

- **Tablero** (la vista actual, ampliada): KPIs (OT con partida, asignado, ejecutado, comprometido, consumo, disponible) y tarjetas de excepción primero (próximas al límite, sobre el tope, con desvíos, autorizaciones pendientes, sin partida suficiente). Filtros: OT, cliente, período, nivel y responsable de la OT, si consta.
- **Detalle de la OT** (`/despacho/control-presupuestal/[ot]`, reemplaza a la pestaña Movimientos):

| Pestaña | Contenido |
|---|---|
| 1 Resumen | Asignado, ampliaciones, vigente, tope 80 %, margen 20 %, ejecutado, comprometido, consumo, disponible, % y evolución del ejecutado por fecha |
| 2 Viajes y costos | Una fila por viaje: fecha, guías, origen-destino, transportista, unidad, planificado, comprometido, ejecutado, diferencia, estados de liquidación; se expande en sus movimientos y abre el viaje en Torre. Filtros de transportista y tipo de servicio aquí, porque son datos del viaje y no de la OT |
| 3 Por concepto | Flete, combustible (real/estimado), peajes, viáticos, estacionamiento, grúa, montacargas, estiba, otros: estimado vs. comprometido vs. ejecutado |
| 4 Desviaciones y alertas | Desvíos y pendientes de la OT, con su flujo de sustento |
| 5 Autorizaciones | Solicitudes de la OT, con historial y condiciones |
| 6 Historial | Línea de tiempo de la OT |

---

## 8. Matriz de migración del Cierre económico (hoy «Costos por ruta»)

| Funcionalidad | Ubicación actual | Nueva ubicación | Datos | Dependencias | Acción | Riesgo |
|---|---|---|---|---|---|---|
| Cola de rutas por cerrar o aprobar | `/despacho/documentos/economico` | Torre: filtro «Económico pendiente» | `economic_closures` | `economic_queue_key` | Reusar el cálculo en `get_tower_dispatches` | Bajo |
| Ítems, conforme, costo distinto, aprobar u observar | `EconomicClosurePanel` | Torre · Liquidación económica | `*_freight_stages`, `transport_unloading_costs` | `economic_item_set/sync` | Montar el componente | Bajo |
| Conforme masivo | Costos por ruta | Torre (selección múltiple) | ídem | `economic_confirm` | Mover el botón | Medio (permisos) |
| Indicadores | Costos por ruta | Control presupuestal · Por concepto | `service_cost_indicators` | — | Reusar | Bajo |
| Enlaces existentes `?despacho=` | Varias pantallas | Torre `?despacho=&tab=economica` | — | Monitoreo, Registro, Pendientes | La dirección vieja redirige | Bajo |
| Bandeja documentaria `?vista=liquidacion` | Documentos | Torre · Liquidación documentaria | `documentary_closures` | `get_settlement_checklists` | Igual: primero convivir y después redirigir | Medio |

**Fase 5, primer paso (01/11/2026):** `/despacho/documentos/economico?despacho=<id>` redirige a Torre
(`/torre-control?despacho=<id>&liquidar=economica`), que abre el viaje con su liquidación económica. Todos los enlaces existentes
(Movimientos, Pendientes, Registro de Servicios, Documentos, Torre) llegan así a Torre sin cambiarlos. La bandeja de Costos por
ruta sigue como lista de trabajo.

**Fase 5, segundo paso:** la liquidación documentaria también se trabaja en el viaje. En Cierre del servicio, «Abrir documentos
del servicio» muestra `GuidesClosureTab` (`DispatchDocumentarySettlement`, con las mismas consultas y permisos que la bandeja).
`documentaryHref` y `/despacho/documentos?despacho=<id>&vista=liquidacion` llevan a `/torre-control?despacho=<id>&liquidar=documentaria`.
La bandeja «Documentación pendiente» sigue como lista de trabajo. Anular un documento (con causa) sigue en la bandeja.
**Decisión (01/11/2026): la liquidación documentaria sigue abierta con la ruta cerrada (LIQUIDADO) hasta el cierre final**
(`20261209090000`): carga de documentos, validación de la guía y «dar por liquidado» admiten LIQUIDADO y se bloquean con
cierre final vigente (se reabre en Torre). La bandeja «Documentación pendiente» sigue sin listar rutas LIQUIDADO (evita
históricos); se encuentran en Torre con el filtro de Cierre del servicio.

El retiro se hace recién cuando Torre cubre todo y dos semanas de uso no muestran regresiones. Las URL viejas redirigen. No se borra ningún dato.

## 9. Roles y autorizaciones

| Acción | Supervisor de Transporte | Jefe de Distribución | Gerencia de Operaciones | Finanzas | Permiso (existente salvo *) |
|---|---|---|---|---|---|
| Registrar o sustentar costos, liquidar económico | ✔ | ✔ | — | — | `despacho` / `cierre-economico` |
| Aprobar ítems económicos | — | ✔ | — | — | `cierre-economico` |
| Liquidación documentaria | Documentario | ✔ | — | — | `documentario` |
| Cierre final del viaje | ✔ si todo está conforme | ✔ con excepción | — | — | `despacho` + `cierre-final`* |
| Pedir sustento, recomendar | — | ✔ | — | — | `control-presupuestal-recomendar` |
| Autorizar sobre el tope (≤100 %) | — | — | ✔ | — | `control-presupuestal-autorizar` |
| Ampliar la partida (>100 %) | — | Solicita | ✔ (y Finanzas si se decide) | Consulta | `control-presupuestal-ampliar`* |
| Consultar y exportar | ✔ | ✔ | ✔ | ✔ | `control-presupuestal` |

Toda acción se valida en la base de datos (RPC con `has_tms_permission` y la sede). Que la pantalla sea visible no habilita la acción.

## 10. Plan por fases

| Fase | Objetivo y alcance | Archivos y tablas | Riesgos | Pruebas y aceptación |
|---|---|---|---|---|
| **1 Diagnóstico** | Este documento | — | — | Aprobación |
| **2 Arquitectura** | `dispatch_closure_status`, decisiones D1–D5 | nueva función de lectura | Reglas mal definidas | PGlite: estados independientes (esc. 13, 14) |
| **3 Torre de Control** | Pestañas del detalle, filtros, `dispatch_final_close` con eventos, etiqueta LIQUIDADO≠CERRADO | `torre-control/page.tsx`, componentes existentes; migración del cierre final | Romper el cierre actual; doble trabajo con las bandejas | Esc. 13, 14, 19, 20; Torre cierra un viaje sin abrir otra pantalla |
| **4 Control presupuestal** | Tablero con filtros, detalle por OT (6 pestañas), `budget_ot_detail`, línea de tiempo, ampliaciones, pendiente de combustible en tarifa, reparto con km adicionales | `control-presupuestal/**`, nuevas RPC de lectura, `transport_budget_extensions` | Rendimiento en OT grandes | Esc. 1–12, 15–18; totales iguales a la partida (conciliación 0) |
| **5 Integración y migración** | Las bandejas abren Torre; redirecciones; retiro progresivo | `documentos/**`, `navConfig.ts` | Enlaces rotos | Guardas de rutas; C-tests de redirección |
| **6 Validación** | 20 escenarios + permisos + concurrencia | `scripts/test-*.cjs`, `supabase/tests/caja_c2xx` | Lo que PGlite no reproduce: dos sesiones | Todos los escenarios en CI |
| **7 Despliegue** | Por fase, con verificación de Caja tras cada uno; la UI nueva convive con la anterior hasta el retiro | workflow existente | — | 0 FAIL en Caja; conciliación 0 |

Orden: 2 → 3 → 4 → 5 → 6 (continuo) → 7 (por cada fase).

## 11. Riesgos y decisiones de negocio pendientes

| # | Decisión | Opciones | Propuesta |
|---|---|---|---|
| D1 | ¿El cierre final bloquea algo? | a) Solo estado y trazabilidad · b) Bloquea facturar o pagar al tercero | a) en esta etapa |
| D2 | Combustible de Caja en ruta de tercero (esc. 17) | a) Se imputa y se marca «posible duplicado con tarifa» · b) No se imputa hasta revisión | a) |
| D3 | Km adicionales en viaje consolidado | a) Combustible de los km extra directo a la OT que los causó y el resto por peso · b) Solo por peso | a) |
| D4 | Ampliación de partida | a) Gerencia aprueba en el TMS · b) Solo desde Contratos o ERP, el TMS solo registra | a) con evento y evidencia. Cambia importes: requiere confirmación |
| D5 | Ajuste del flete final en ruta propia (B9) | a) Queda en el ejecutado · b) Se revierte como la tarifa | b) es coherente con D1 de la especificación |

Riesgos técnicos: producción no coincide con el historial de migraciones (parches guardados, `to_jsonb` en columnas opcionales); la concurrencia real entre sesiones no se puede probar en PGlite; las bandejas y Torre conviven durante la transición.

## 12. Criterios de aceptación y escenarios

| Escenario | Hoy | Queda cubierto en |
|---|---|---|
| 1 OT con un viaje · 2 con varios · 3 viaje multi-OT · 16 costo compartido | ✔ (pruebas de movimientos y de peso) | Fase 4 (detalle) |
| 4 Compromiso que se liquida · 5 cancelado · 6 reprogramado | ✔ | Fase 4 |
| 7 Real > estimado · 8 llega al 70 % · 9 intenta superar el 80 % · 10 autorización · 11 >100 % por ejecutado | ✔ | Fase 4 (vista) |
| 12 Gasto sin comprobante | Parcial (cargo sin sustento) | Fase 4: Caja sin comprobante |
| 13 Documentario completo, económico pendiente · 14 cerrado con historial · 20 cierre con desvíos pendientes | ✗ | Fase 3 |
| 15 Dos usuarios sobre el mismo saldo | ✔ por diseño (bloqueo de fila raíz); falta prueba con dos sesiones | Fase 6 (Postgres en Docker) |
| 17 Combustible incluido en tarifa | ✗ | Fase 4 (D2) |
| 18 Ampliación aprobada | ✗ | Fase 4 (D4) |
| 19 Reversión o corrección de liquidación | ✔ (reabrir ítem, revertir Caja) | Fase 3 (cierre final reabrible) |

Aceptación global: un usuario abre un viaje en Torre y lo lleva de la ruta al cierre final sin ir a otra pantalla; abre una OT en Control presupuestal y entiende de qué viajes y conceptos sale cada importe, con la conciliación en 0 y sin pantallas que repitan totales.
