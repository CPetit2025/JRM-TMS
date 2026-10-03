# APT — Control y estadía del inventario (Almacén de Producto Terminado)

Objetivo: verificar la **permanencia** del material en APT (bodega 647-04 ALM PT): cuánto hay, de qué NumRel, producto y
glosa, desde cuándo, cuánto salió y qué conviene liberar primero. Todo nace de las hojas **ENTRADA** (P/E Producción) y
**SALIDA** (Despacho Ventas) que se cargan a diario.

## Uso diario
1. *Almacén APT → Carga Diaria APT* (`/apt/cargas`): subir el `.xlsx` con las hojas ENTRADA y SALIDA (un libro o dos archivos).
2. Revisar la vista previa (filas, fechas, TN, filas excluidas) y confirmar.
3. La carga **reemplaza**, por hoja, los movimientos del rango de fechas que trae el archivo: sirve tanto el acumulado del
   año como solo el día, sin duplicar.
4. Revisar *Calidad de datos*: la conciliación fuente vs modelo debe estar en OK.
5. Las cargas se consolidan: si ya se cargó 02/01–30/09 y luego se sube 01/10–10/10, el análisis contempla 02/01–10/10.
   *Secuencia de fechas cargadas* (en Cargas) muestra lo cargado por hoja y alerta:
   - error: fechas que faltan cargar entre cargas, o una carga que empieza después de un hueco (pide confirmación);
   - aviso: ENTRADA y SALIDA llegan a fechas distintas;
   - info: 4 o más días seguidos sin movimientos (feriados o reporte incompleto).

Permisos: `apt` (ver el módulo) y `apt-carga` (cargar y cambiar parámetros). El Administrador y el Jefe de Distribución
tienen ambos.

## Reglas del modelo
| Concepto | Regla |
|---|---|
| NumRel padre (lote) | ENTRADA: columna Lote; si falta, NumRel de la OP sin su último tramo (16325-S002-033 → 16325-S002). SALIDA: NumRel; las salidas "ERROR DE CONTRATO" van a su Lote. Coincide con el código de la OT en Contratos. |
| Clave | Lote \| Producto |
| Peso | \|PesoTotalProduccido\| en kg; TN = kg / 1000. La Cantidad tiene unidades mezcladas (UND, CIEN, KG…) y no se suma. |
| FIFO | Cada fila de ENTRADA es una capa. Las salidas de la misma clave consumen primero las capas más antiguas. |
| Días del saldo | Fecha de corte − fecha de ingreso de la capa. |
| Permanencia de lo despachado | Fecha de salida − fecha de ingreso, ponderada por kg. |
| TN×Días | Saldo TN × días del saldo. Es la prioridad para liberar espacio. |
| Aging ponderado | Σ(TN × días) / Σ TN del saldo. |
| Fecha de corte | La fecha máxima de los datos, o una manual en Parámetros. |
| Estados | En APT (sin salidas, dentro del plazo de alerta) · Salida parcial · Despachado (saldo ≤ tolerancia, 2 %) · Sin salida identificada (sin salidas y más días que la alerta, 60) · Problema de información (ingreso sin peso o salida registrada antes del ingreso). |
| Salidas | Despacho de lo ingresado · Excede lo ingresado (stock anterior al periodo) · Otro producto del lote (no ingresó por APT: pernería, accesorios) · Lote sin ingreso en el periodo · Sin NumRel. |
| FechaEntrega | Se analiza por separado; nunca reemplaza la fecha de ingreso APT. |
| Cliente del lote | El de más TN en las guías de SALIDA del lote; si no tiene guías, el de su OT madre; si tampoco, el cliente de la OT en Contratos del TMS. |
| OT madre | Primer tramo del NumRel (16325-S002 → 16325). La pestaña *Cliente · OT · Lote* muestra primer ingreso, último despacho (cualquier guía de sus lotes) y saldo final. |

Una salida registrada antes del ingreso que consume se asigna igual (el ingreso se registró tarde), con 0 días, y
marca la capa como "Problema de información".

El inventario reconstruido por fecha (tendencias, inventario acumulado) parte de las entradas cargadas. El stock
anterior a la primera carga aparece como "Excede lo ingresado" o "Lote sin ingreso".

## Flujo multi-almacén (647 · 540 · ST VENTAS)
Sección *Flujo multi‑almacén* del módulo. Relaciona cada guía con la producción que la originó y mide cuánto estuvo en cada
almacén:
- **647 ALM PT** recibe toda la producción.
- **ST VENTAS** recibe solo lo que se va a guiar; lo ideal es saldo 0.
- **540 APT LB** tiene stock antiguo y adelantos con IPT sin contrato; está en suspensión.

Pantallas: Resumen del flujo (Sankey, KPIs, origen mensual de lo despachado), Stock por almacén, Tiempos por etapa,
ST VENTAS (velocidad de guiado, detenido, retornos), Adelantos y 540 (asignación de contrato, reasignación de OT, consumos
internos) y Trazabilidad (por guía o lote, con el despacho del TMS si la guía está en el Asistente Documentario).
*Calidad de datos* muestra el cuadre por almacén y el emparejamiento de traspasos.

**Kardex** (`/apt/flujo/kardex`) lista cada movimiento del ERP en orden cronológico con su saldo acumulado:
- Filtros: lote exacto o que contenga, OT, cliente, producto, descripción, documento o guía, almacén, tipo de movimiento y fechas.
- El saldo se calcula por lote + SKU, por SKU, por lote o total, separado por almacén o consolidado.
- El saldo inicial incluye el stock previo inferido. Al final del periodo cuadra con el flujo multi-almacén (prueba C24).
- Las guías abren su detalle de SKUs.
- Exporta a Excel hasta 20 000 filas.

### Qué cargar
Lo más simple es subir el **reporte total del ERP**: un libro con las hojas ENTRADA y SALIDA de todas las bodegas. Trae:
- la producción a 647 y a 540;
- los dos lados de los traspasos;
- los vales de consumo;
- las guías de recojo.

La carga se queda solo con 647, 540 y ST VENTAS, y quita los ceros a la izquierda de Numero, NumRel, Lote y Contrato
(`0000016101` → `16101`).

Equivale a subir por separado:
Además de ENTRADA y SALIDA:
- Los dos reportes de **traspasos de almacén**: el de salidas (lado origen, cantidad negativa) y el de entradas (lado
  destino). Deben cubrir las mismas fechas; si no, la cobertura avisa.
- Opcional: el reporte de **salidas totales**. Aporta los vales de consumo (V/C activos, V/C producción) y las
  **devoluciones / guías de recojo** que ingresan a los almacenes APT.

La carga clasifica cada fila por TIPODOCTO y signo, y guarda solo las de 647, 540 y ST VENTAS:
- P/E → ENTRADA.
- DESPACHO → SALIDA.
- TRASPASO → traspaso: con cantidad negativa es el lado origen; con cantidad positiva, el lado destino.
- Otras salidas → CONSUMO.
- Otros ingresos → DEVOLUCION.

Cada hoja se consolida por su propio rango de fechas.

### Reglas del modelo
| Concepto | Regla |
|---|---|
| Almacén | `647-04 ALM PT` → 647 · `540-04 …` → 540 · `ST-VENTAS…` → ST. |
| Lote de traspasos, consumos y devoluciones | Columna Lote; si falta, el Contrato. |
| Emparejamiento | Tipo de documento + número + producto + cantidad. Un origen APT sin destino APT es *salida a otro almacén*; un destino sin origen APT, *ingreso desde otro almacén*. |
| FIFO | Por almacén y Lote\|Producto, en orden de llegada al almacén. En un mismo día, primero ingresos y luego salidas. |
| Stock previo | Lo mínimo que debió existir antes del primer día cargado para que el saldo nunca sea negativo. Es la capa más antigua y se consume primero. No tiene fecha de producción. |
| Cambio de lote | Un traspaso con lote de destino distinto es **asignación** si el lote de origen no es un contrato de 5 dígitos (adelanto, OP interna); si lo es, es **reasignación** de OT. |
| Composición | Cada capa se expresa en sus capas raíz (producción, stock previo, devolución u otro almacén). La guía hereda la fecha de producción a través de toda la cadena. |
| Tiempos | Total = guía − producción. Previo = llegada al último almacén − producción (sobre todo 647). Final = guía − llegada al último almacén (sobre todo ST). Ponderados por kg. |

La estadía consolidada (pestañas *Estadía APT*) no cambia: usa solo ENTRADA y SALIDA. El flujo además descuenta consumos y
salidas a otros almacenes y separa el saldo por almacén; *Calidad de datos* muestra la diferencia.

## Técnica
- Migración `supabase/migrations/20261002100000_apt_estadia_inventario.sql`:
  - Tablas `apt_uploads`, `apt_movements` (fila original en `raw` más la versión normalizada) y `apt_settings` / `apt_aging_ranges`.
  - Resultado del modelo en `apt_layers`, `apt_allocations` y `apt_exit_class`.
  - Funciones `apt_*`.
- El modelo se recalcula (`apt_model_rebuild`) después de cada carga y de cada cambio de parámetros.
- Pruebas: `supabase/tests/caja_c16_apt_estadia.test.sql`, `caja_c17_apt_cliente_ot.test.sql`, `caja_c19_apt_cobertura.test.sql` y
  `caja_c20_apt_flujo_multialmacen.test.sql`.
- Flujo multi-almacén: migración `20261003100000_apt_flujo_multialmacen.sql`.
  - Tablas `apt_flow_layers`, `apt_flow_exits`, `apt_flow_alloc`, `apt_flow_pieces` y `apt_flow_state`.
  - Se recalcula con `apt_flow_rebuild` en una tercera petición después de cada carga y de cada cambio de parámetros.
  - Consultas `apt_flow_summary`, `apt_flow_stock`, `apt_flow_leadtime`, `apt_flow_st`, `apt_flow_adelantos`, `apt_flow_trace` y `apt_flow_quality`.
  - Tipos en `src/lib/apt/flowTypes.ts`; pantallas en `src/app/(dashboard)/apt/flujo/*`.
- Pantallas en `src/app/(dashboard)/apt/*`, con base común en `src/lib/apt/*` y `src/components/apt/*`.
- JRM IA: herramientas `get_apt_status` (estadía) y `get_apt_flow` (flujo, guía o lote). Ambas requieren el permiso de IA `ia:read:inventarios` más el módulo `apt`.
