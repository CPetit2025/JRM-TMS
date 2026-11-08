# Plan: WMS como fuente única del almacén, inventario por barrido y etiquetado

Estado: **borrador para revisión**. No se implementa nada hasta aprobarlo.
Fecha: 08/11/2026.

## 1. Objetivo

1. Hacer del WMS la **fuente única de los datos de almacén**: stock del ERP, movimientos derivados, inventario
   multialmacén y analítica APT. El TMS los consulta al WMS.
2. Ejecutar un **inventario físico por barrido**. En el mismo recorrido se etiquetan con código de barras los
   bultos que solo tienen rótulo y se valida el stock contra el ERP.

Con eso, los bultos que hoy están en almacén quedan etiquetados y disponibles para el picking, que hoy no tiene
qué escanear: en el WMS existe un solo paquete etiquetado.

## 2. Situación actual (verificada el 08/11/2026)

| Tema | Estado |
|---|---|
| Carga del ERP | El robot local "JRM-TMS carga ERP" (`scripts/erp-auto`) actualiza `StockBodegaDespacho.xlsm` y `Actualizable Despacho.xlsm` (Power Query → `DATAFLEX\FLEXLINE`) y los sube a `/apt/datos` del TMS 5 veces al día. **Falla desde el 07/11 07:00**: Excel rechaza la actualización (`RPC_E_CALL_REJECTED`) y "Consulta1 no se actualizó". La última carga correcta fue el 06/11 19:00 (1.432 filas de stock). |
| Modelo `/apt` en el TMS | Tablas `erp_*` (cortes de contratos y stock), `inv_*` (inventario multialmacén) y `apt_*` (estadía, flujo, Gantt, analítica). Unos 60 RPC. `apt_movements` ocupa unos 390 MB. Un recálculo automático corre cada minuto. |
| `/apt` en el WMS | Las pantallas están copiadas en `src/app/almacen/apt/*`, pero **bloqueadas** (`apt/layout.tsx`): la base WMS no tiene las tablas ni los RPC que usan. Solo funcionan "Actualizar ingresos WMS" y "Control de recepción". |
| Etiquetado WMS | Solo se crean paquetes desde un ingreso IPT validado (`wh_receipt_sources` → `wh_validate_receipt` → `wh_label_package`). No hay forma de etiquetar un bulto que ya está en stock. |
| Conteo físico | No existe. La conciliación del WMS compara salidas cargadas y paquetes ya etiquetados; no cuadra stock por lote. Los paquetes no tienen ubicación asignada. |

## 3. Decisiones de alcance

- **Pasan al WMS (fuente única):** corte de stock del ERP (`erp_stock_lots`), derivación diaria de movimientos,
  inventario multialmacén (`inv_*`) y modelo APT (`apt_*`), con sus pantallas.
- **Se quedan en el TMS:** contratos, guías y clientes (`erp_contract_lines`, alta automática de contratos y
  clientes, pesos). El TMS los usa para validar la OT en solicitudes y para programar; moverlos haría depender el
  transporte del WMS. El WMS los sigue recibiendo por la integración existente.
- **El WMS no corrige el ERP.** Las diferencias del inventario se informan; el ajuste se hace en el ERP.
- **Independencia de sistemas:** si el WMS cae, el TMS sigue operando. Solo pierde las pantallas de análisis de almacén.

## 4. Fases

### Fase 0 — Requisitos (bloqueante)

1. **Reparar el robot de carga ERP.** Diagnosticar `RPC_E_CALL_REJECTED`: Excel ocupado, otra instancia abierta o
   conflicto con el robot de ingresos WMS, que también usa Excel y corre cada minuto. Si hace falta, serializar
   ambos robots con un bloqueo común. Aceptación: 3 cargas seguidas correctas y fecha de corte de hoy.
2. **Definir el barrido con operaciones:** bodegas y su orden (`647-04 ALM PT`, `540-04 APT LB`, `ST-VENTAS-IMD`),
   zonas o ubicaciones, equipos (operario, lector, impresora Zebra y tamaño de etiqueta) y reglas de corte
   (despachos e ingresos durante el conteo).

### Fase 1 — Stock de referencia en el WMS (primer paso de la réplica)

- Crear en la base WMS `erp_imports` (STOCK) y `erp_stock_lots` con las mismas columnas que el TMS: bodega,
  producto, lote, lote crudo, OT, unidad, factor, stock, stock en falla, comprometido, peso unitario y total, kg.
- **Cargador:** el robot sube "Stock Bodega Despacho" también al WMS. Durante la transición carga en ambos sistemas.
- Pantalla de consulta del stock del ERP por bodega, OT, lote y producto, con su fecha de corte.
- Aceptación: el total por bodega y lote del WMS coincide con el del TMS para el mismo archivo.

### Fase 2 — Barrido con etiquetado

**Modelo nuevo (WMS):**
- `wh_count_campaigns`: bodega, zona, fecha de corte del stock de referencia, responsable y estado (`ABIERTA`,
  `EN_CONTEO`, `EN_REVISION`, `CERRADA`).
- `wh_count_lines`: cada bulto contado, con campaña, ubicación, paquete, producto, lote, OT, cantidad, peso,
  operario, fecha y hora, y origen (`ETIQUETA_EXISTENTE` o `ROTULO`).
- `wh_packages` admite un origen nuevo, **inventario**, además de ingreso IPT: `source_kind`, referencia a la
  campaña y a la línea del stock del ERP. También se registra la ubicación del bulto.

**Pantalla móvil de barrido:**
- **Bulto con etiqueta:** se escanea y queda contado. Si el paquete figura en otra ubicación, se actualiza la
  ubicación.
- **Bulto solo con rótulo:**
  1. Buscar por OT, lote o producto en el stock de referencia.
  2. Confirmar cantidad y peso.
  3. Generar el `PKG-…` e imprimir la etiqueta con el tamaño configurado (Configuración › Etiquetas).
- **Bulto que no figura en el ERP:** se registra como "no identificado" con foto. Solo supervisión puede
  etiquetarlo.
- Funciona sin conexión, con la misma cola que el picking.

**Controles:**
- Sin doble etiquetado: si el lote ya tiene en etiquetas toda la cantidad del ERP, la pantalla avisa y pide
  confirmación de supervisión.
- Mientras una zona está en conteo, se bloquea o se marca para revisión cualquier etiquetado de ingresos IPT del
  mismo lote.
- Los paquetes creados quedan `AVAILABLE` y entran al picking: `wh_record_scan` ya valida la OT.

### Fase 3 — Cuadre y cierre

- Comparar lo contado con el ERP por bodega, producto y lote (cantidad y kg). El resultado de cada lote es
  `CUADRA`, `FALTANTE`, `SOBRANTE` o `NO_EN_ERP`.
- **Reconteo:** solo de las diferencias, por un operario distinto.
- **Cierre:** supervisión aprueba con motivo por diferencia. Se emite un reporte para que el ERP se ajuste.
- Las diferencias quedan en `wh_reconciliation`, que ya existe, con un tipo nuevo de origen: inventario.

### Fase 4 — Réplica completa del modelo `/apt` en el WMS

1. **Esquema:** extraer de **producción del TMS** (no de las migraciones del repo, que no coinciden con
   producción) las tablas y funciones `inv_*`, `apt_*`, la derivación `erp_derive_*` y la tarea de recálculo.
   Crearlas en `wms-db`.
2. **Datos:** copia única de la historia (unos 390 MB de movimientos, además de capas, asignaciones y flujos). No
   todo se puede regenerar desde los archivos cargados.
3. **Doble carga y paridad:** el robot alimenta ambos sistemas. Un control diario compara stock por lote,
   estadía, flujos y totales. Se avanza solo con 10 días hábiles seguidos sin diferencias.
4. **Pantallas:** se desbloquea `/almacen/apt/*` en el WMS.
5. **Cambio en el TMS:** `/apt` del TMS pasa a leer del WMS con una clave de integración, o enlaza a las
   pantallas del WMS.
6. **Retiro:** se deja de cargar stock en el TMS. Contratos y guías siguen cargándose al TMS.

## 5. Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| El stock cambia durante el barrido | Fecha de corte por campaña; conteo por zona con despachos de la zona congelados o registrados aparte. |
| Bulto etiquetado dos veces | Aviso por lote cuando lo etiquetado supera el stock del ERP; supervisión confirma. |
| Lotes con formato distinto en el ERP | Búsqueda por `lote` y `lote_raw`; normalización con las reglas que ya usa el TMS. |
| Rótulo ilegible o sin lote | Registro "no identificado" con foto; lo resuelve supervisión. |
| Réplica distinta del original | Doble carga con control de paridad antes de cambiar el TMS. |
| Producción del TMS no coincide con el repo | Extraer el esquema desde producción y probarlo con el arnés "tipo producción". |
| La carga ERP vuelve a fallar | Alerta cuando la fecha de corte tiene más de 6 horas; reintento automático. |

## 6. Pruebas

- Pruebas SQL en PGlite (`scripts/test-wms-*.cjs`) de cada fase:
  - campañas y líneas de conteo;
  - etiquetado desde rótulo y bloqueo de doble etiquetado;
  - cuadre por lote;
  - permisos por rol y bloqueo de anónimos.
- Paridad TMS vs. WMS con el mismo archivo del ERP (fases 1 y 4).
- Piloto en una zona de una bodega antes del barrido completo.

## 7. Pendiente de decidir con operaciones

1. Bodega y zona del piloto.
2. Conteo por bulto con la cantidad del rótulo, por peso, o ambos.
3. ¿Se congelan los despachos de la zona durante el conteo?
4. Quién aprueba el cierre y el reporte de diferencias.
5. Plazo esperado del barrido completo.

## 8. Orden de ejecución propuesto

Fase 0 → Fase 1 → piloto de la Fase 2 → Fase 2 completa y Fase 3 → Fase 4. La Fase 4 puede avanzar en paralelo
desde que termina la Fase 1, porque comparte el cargador.
