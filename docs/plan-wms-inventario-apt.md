# Plan: WMS como fuente única del almacén, inventario por barrido y etiquetado

Estado: **borrador para revisión**. No se implementa nada hasta aprobarlo.
Fecha: 08/11/2026. Revisión 2: incorpora la revisión de Codex (PR #505).

## 1. Objetivo

1. Hacer del WMS la **fuente única de los datos de almacén**: stock del ERP, movimientos derivados, inventario
   multialmacén y analítica APT. El TMS conserva solo las proyecciones que su operación necesita, alimentadas
   desde el WMS.
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

### Dependencias del TMS fuera de `/apt` (de la revisión de Codex)

Estos usos del TMS **no están en las pantallas de `/apt`** y se romperían si el TMS dejara de tener stock y
movimientos locales:

| Consumidor en el TMS | Lee | Referencia |
|---|---|---|
| `erp_ref_ot` → `ErpOtLinea` | `erp_stock_lots` | `20261027090000_erp_referencia_operaciones.sql:65-68` |
| `erp_ref_contratos` → `ErpContratos` | `erp_stock_lots` | `20261103090000_erp_referencias_estables.sql:88-94` |
| `erp_stock_corte` → `StepServicios.tsx:76` | corte de stock | — |
| `erp_refresh_peso` (pesos unitarios de SKU) | stock e `inv_movements` | `20261223090000_erp_sku_peso_m3.sql:108-142` |
| `apt_guias_peso`, `get_service_registry_weight` (peso de guías y servicios) | salidas de `apt_movements` | `20261225102000_apt_peso_busqueda_indexada.sql` |

Pruebas que los cubren: **C38, C145 y C146**.

## 3. Decisiones de alcance

- **El WMS es dueño** del corte de stock del ERP, la derivación de movimientos, el inventario `inv_*` y el modelo
  APT, con sus pantallas.
- **El TMS conserva proyecciones locales, de solo lectura, alimentadas desde el WMS:**
  - stock y fecha de corte (`erp_stock_lots`, `erp_stock_corte`);
  - salidas por guía con peso (lo que leen `apt_guias_peso`, `get_service_registry_weight` y `erp_refresh_peso`).
  
  Así, `erp_ref_ot`, `erp_ref_contratos`, `StepServicios` y los pesos siguen funcionando sin mantener dos
  modelos APT, y el TMS sigue operando si el WMS cae (lee la última proyección).
- **Contratos, guías y clientes** siguen siendo del TMS (`erp_contract_lines`, `erp_contract_guias`,
  `erp_guia_fechas`, alta automática de contratos y clientes). La derivación del WMS los necesita, así que el
  WMS recibe **una copia** del mismo archivo de contratos en cada carga. Esa copia solo se usa para derivar; el
  TMS sigue siendo la referencia operativa.
- **El WMS no corrige el ERP.** Las diferencias del inventario se informan; el ajuste se hace en el ERP.

## 4. Fases

### Fase 0 — Requisitos (bloqueante)

1. **Reparar el robot de carga ERP.** Diagnosticar `RPC_E_CALL_REJECTED`: Excel ocupado, otra instancia abierta o
   conflicto con el robot de ingresos WMS, que también usa Excel y corre cada minuto. Si hace falta, serializar
   ambos robots con un bloqueo común. Aceptación: 3 cargas seguidas correctas y fecha de corte de hoy.
2. **Definir el barrido con operaciones:** bodegas y su orden (`647-04 ALM PT`, `540-04 APT LB`, `ST-VENTAS-IMD`),
   zonas o ubicaciones, equipos (operario, lector, impresora Zebra y tamaño de etiqueta) y la **regla de
   congelamiento** (ver Fase 2).

### Fase 1 — Stock de referencia en el WMS (primer paso de la réplica)

- Crear en la base WMS `erp_imports` (STOCK y CONTRATOS), `erp_stock_lots` y las tablas de contratos y guías con
  las mismas columnas que el TMS.
- **Cargador:** el robot sube ambos archivos también al WMS. Durante la transición carga en los dos sistemas.
- **Retención:** el cargador del TMS borra las filas de la importación anterior al aplicar la siguiente
  (`20261024120000_erp_contratos_stock.sql:268-274`). En el WMS **no se borra una importación usada por una
  campaña**. Además, cada campaña guarda su propia copia inmutable (Fase 2).
- Pantalla de consulta del stock del ERP por bodega, OT, lote y producto, con su importación y fecha de corte.
- Aceptación: el total por bodega y lote del WMS coincide con el del TMS para el mismo archivo.

### Fase 2 — Barrido con etiquetado

**Modelo nuevo (WMS):**
- `wh_count_campaigns`: bodega, zona, **importación ERP usada** (no solo la fecha), responsable y estado
  (`ABIERTA`, `EN_CONTEO`, `EN_REVISION`, `CERRADA`).
- `wh_count_expected`: **copia inmutable** del stock de la zona tomada de esa importación al abrir la campaña.
  Las líneas contadas y los paquetes nuevos apuntan a esta copia, no a `erp_stock_lots`, así que las cargas
  siguientes del ERP no afectan el cuadre.
- `wh_count_lines`: cada bulto contado, con campaña, ubicación, paquete, producto, lote, OT, cantidad, peso,
  operario, fecha y hora, y origen (`ETIQUETA_EXISTENTE` o `ROTULO`). Hay una **restricción única
  (campaña, paquete)**: un paquete se cuenta una sola vez por campaña, aunque cambie de ubicación.
- `wh_packages` admite un origen nuevo, **inventario**, además de ingreso IPT: `source_kind`, referencia a la
  campaña y a la línea esperada. También se registra la ubicación del bulto.

**Identidad del bulto (contra el doble etiquetado):** el saldo por lote es solo una alarma, no garantiza que un
bulto no se etiquete dos veces. La garantía es una **identidad física persistente** del bulto:
- Al etiquetar desde rótulo, el operario registra lo que identifica al bulto: documento IPT y número de bulto
  (`n/total`) si el rótulo los trae, o lote y secuencia.
- Esa identidad tiene **clave única** en `wh_packages`. Registrar el mismo bulto de nuevo falla, en la misma
  transacción.
- Si existe un ingreso IPT pendiente del mismo lote, el etiquetado desde rótulo **consume** esa correspondencia
  de forma atómica: el IPT queda marcado como etiquetado y ya no permite crear otra etiqueta para ese bulto.
  A la inversa, el etiquetado por IPT verifica que el bulto no exista ya desde inventario.
- Bulto sin identidad legible: se registra como "no identificado" con foto. Solo supervisión puede etiquetarlo.

**Congelamiento y corte (contra faltantes y sobrantes ficticios):**
- Mientras la campaña está `EN_CONTEO` o `EN_REVISION`, la zona queda **congelada de forma efectiva**: el WMS
  bloquea despachos, ingresos y traslados que toquen la zona.
- Si operaciones no puede congelar, se aplica la alternativa de **ajuste al corte**:
  `esperado = stock de la importación − salidas por guía posteriores al corte + ingresos IPT posteriores al corte`.
  Los traslados entre zonas solo se permiten hacia zonas no contadas o ya cerradas.
- Los paquetes creados en la campaña quedan **retenidos** (no disponibles para picking) hasta que se apruebe el
  cuadre de la zona. Recién ahí pasan a `AVAILABLE`.

**Pantalla móvil de barrido:**
- **Bulto con etiqueta:** se escanea y queda contado (uno por campaña).
- **Bulto solo con rótulo:**
  1. Buscar por OT, lote o producto en la copia esperada de la campaña.
  2. Registrar su identidad (IPT y número de bulto, o lote y secuencia), cantidad y peso.
  3. Generar el `PKG-…` e imprimir la etiqueta con el tamaño configurado (Configuración › Etiquetas).
- Funciona sin conexión, con la misma cola que el picking. La unicidad se valida en el servidor al sincronizar.

### Fase 3 — Cuadre y cierre

- Comparar lo contado con lo esperado de la campaña (copia inmutable, ajustada al corte si no hubo
  congelamiento) por bodega, producto y lote, en cantidad y kg. El resultado de cada lote es `CUADRA`,
  `FALTANTE`, `SOBRANTE` o `NO_EN_ERP`.
- **Reconteo:** solo de las diferencias, por un operario distinto. El reconteo reemplaza el conteo anterior del
  lote y conserva el historial.
- **Cierre:** supervisión aprueba con motivo por diferencia. Se liberan los paquetes retenidos y se emite un
  reporte para que el ERP se ajuste.
- Las diferencias quedan en `wh_reconciliation`, que ya existe, con un tipo nuevo de origen: inventario.

### Fase 4 — Réplica completa del modelo `/apt` en el WMS

1. **Esquema:** extraer de **producción del TMS** (no de las migraciones del repo, que no coinciden con
   producción) las tablas y funciones `inv_*`, `apt_*`, la derivación `erp_derive_*` y la tarea de recálculo.
   Crearlas en `wms-db`.
2. **Entradas de la derivación:** `erp_derive_core` exige importaciones activas de STOCK y de CONTRATOS, y une
   `erp_contract_guias`, `erp_contract_lines` y `erp_guia_fechas`
   (`20261025110000_erp_derivacion_safeupdate.sql:10-14,66-75`). El WMS recibe ambos archivos (Fase 1).
   `apt_flow_tms` lee despachos locales del TMS (`20261003100000_apt_flujo_multialmacen.sql:604-621`): se
   adapta para leerlos de la integración con el TMS, o ese enriquecimiento se deja fuera, de forma explícita.
3. **Datos:** copia única de la historia (unos 390 MB de movimientos, además de capas, asignaciones y flujos). No
   todo se puede regenerar desde los archivos cargados.
4. **Doble carga y paridad:** el robot alimenta ambos sistemas. Un control diario compara:
   - stock por lote, estadía, flujos y totales;
   - **guías, fechas de guía y trazabilidad por lote**, no solo los totales.
   
   Se avanza solo con 10 días hábiles seguidos sin diferencias.
5. **Pantallas:** se desbloquea `/almacen/apt/*` en el WMS.
6. **Proyecciones del TMS:** el WMS alimenta en el TMS el stock con su corte y las salidas por guía con peso
   (sección 3). Se verifica que `erp_ref_ot`, `erp_ref_contratos`, `StepServicios`, `erp_refresh_peso`,
   `apt_guias_peso` y `get_service_registry_weight` den los mismos resultados con la proyección que con el modelo
   local.
7. **Cambio de `/apt` en el TMS:** pasa a leer del WMS con una clave de integración, o enlaza a las pantallas del
   WMS.
8. **Retiro:** se deja de cargar el modelo APT en el TMS **solo si C38, C145 y C146 pasan con las proyecciones**.
   Contratos y guías siguen cargándose al TMS.

## 5. Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| El stock cambia durante el barrido | Congelamiento efectivo de la zona; si no es posible, esperado ajustado al corte con salidas e ingresos posteriores. |
| Bulto etiquetado dos veces | Identidad física con clave única y consumo atómico del IPT correspondiente; el saldo por lote es solo una alarma. |
| Paquete contado dos veces al moverse entre zonas | Restricción única (campaña, paquete); traslados solo hacia zonas no contadas o cerradas. |
| La carga siguiente del ERP borra la base del cuadre | Copia inmutable por campaña (`wh_count_expected`) identificada por importación; retención de importaciones usadas. |
| Lotes con formato distinto en el ERP | Búsqueda por `lote` y `lote_raw`; normalización con las reglas que ya usa el TMS. |
| Rótulo ilegible o sin lote | Registro "no identificado" con foto; lo resuelve supervisión. |
| El TMS pierde datos que usa fuera de `/apt` | Proyecciones locales de stock y salidas con peso; retiro condicionado a C38, C145 y C146. |
| Réplica distinta del original | Doble carga con control de paridad que incluye guías, fechas y trazabilidad. |
| Producción del TMS no coincide con el repo | Extraer el esquema desde producción y probarlo con el arnés "tipo producción". |
| La carga ERP vuelve a fallar | Alerta cuando la fecha de corte tiene más de 6 horas; reintento automático. |

## 6. Pruebas

- Pruebas SQL en PGlite (`scripts/test-wms-*.cjs`) de cada fase:
  - campañas, copia esperada inmutable y líneas de conteo;
  - unicidad por campaña y por identidad del bulto, y consumo atómico del IPT;
  - congelamiento de zona y retención de paquetes hasta el cierre;
  - cuadre por lote (con y sin ajuste al corte) y reconteo;
  - permisos por rol y bloqueo de anónimos.
- Paridad TMS vs. WMS con los mismos archivos del ERP (fases 1 y 4), incluidas guías y trazabilidad.
- En el TMS: C38, C145 y C146 con las proyecciones antes del retiro.
- Piloto en una zona de una bodega antes del barrido completo.

## 7. Pendiente de decidir con operaciones

1. Bodega y zona del piloto.
2. Conteo por bulto con la cantidad del rótulo, por peso, o ambos.
3. ¿Se puede congelar la zona durante el conteo, o se usa el ajuste al corte?
4. Qué identifica a cada bulto en el rótulo actual (IPT y número de bulto, lote, otro).
5. Quién aprueba el cierre y el reporte de diferencias.
6. Plazo esperado del barrido completo.

## 8. Orden de ejecución propuesto

Fase 0 → Fase 1 → piloto de la Fase 2 → Fase 2 completa y Fase 3 → Fase 4. La Fase 4 puede avanzar en paralelo
desde que termina la Fase 1, porque comparte el cargador.
