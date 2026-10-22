# Analítica APT y Distribución (`/apt/analitica`)

Convierte los reportes de movimientos del ERP en información operativa y gerencial, con filtros globales y
trazabilidad hasta la fila original. Cada indicador se marca como **calculado**, **estimado** (depende de una hipótesis,
p. ej. FIFO) o **no disponible** (falta información; se explica qué falta).

Menú: *Almacén APT → Analítica APT y Distribución*. Permisos: `apt` (consulta), `apt-carga` (operación: cargar,
revertir, revisar filas, registrar vínculos) y `apt-admin` (administración: áreas, clases de documento, equivalencias
de unidades y metodología). El rol Administrador tiene los tres.

## Arquitectura

| Capa | Dónde | Qué hace |
|---|---|---|
| Importación | `src/lib/apt-analitica/workbook.ts`, `normalize.ts`, pestaña *Cargas* | Lee Excel/CSV (máx. 40 MB y 400.000 filas por hoja), detecta el encabezado, ignora columnas sin encabezado, convierte fechas seriales y de texto, valida tipos, signos y obligatorios, calcula la huella SHA‑256 del archivo y la huella de cada línea. |
| Almacenamiento | `supabase/migrations/20261022160000_apt_analitica.sql` | `apa_imports` (historial), `apa_raw_rows` (fila original tal cual, con archivo, hoja y fila), `apa_movements` (capa normalizada), `apa_opening_balances`, `apa_commitments` (con versión), `apa_receipts`, `apa_areas`, `apa_doc_classes`, `apa_conversions`, `apa_links` (equivalencias), `apa_settings`, `apa_saved_views`, `apa_audit`. Entidades derivadas como vistas: documentos, productos, clientes, lotes, órdenes y traspasos. Acceso solo por funciones con permiso. |
| Cálculo | `src/lib/apt-analitica/engine.ts`, `quality.ts`, `analysis.ts`, `stats.ts` | Funciones puras: filtros, flujos, conciliación de traspasos, FIFO, permanencia, antigüedad, ciclo entre etapas, déficit, avance y cumplimiento comercial, calidad. Se ejecuta en el navegador sobre los movimientos vigentes. |
| Presentación | `src/components/apt-analitica/*`, `src/app/(dashboard)/apt/analitica/page.tsx` | Resumen ejecutivo, APT, Distribución, Trazabilidad, Calidad, Explorador, Cargas y Configuración. |

Pruebas: `node --test scripts/test-apt-analitica.cjs` (motor) y `supabase/tests/caja_c133_apt_analitica.test.sql` (base).

## Importación y calidad

- **Tipo de fuente**: Entradas, Salidas, Movimientos (mixto, por signo), Saldo inicial, Compromisos, Recepciones.
- **Período**: se toma de las fechas de los datos, nunca del nombre del archivo.
- **Archivo repetido**: misma huella del contenido y mismo tipo → no se importa (aunque cambie el nombre). Para
  reemplazarlo se revierte la importación anterior.
- **Líneas idénticas dentro del archivo**: se conservan todas y se numeran (1, 2, 3…). Solo una regla de negocio o un
  identificador de origen puede confirmar que son duplicados; mientras tanto aparecen en *Calidad*.
- **Períodos superpuestos**: el asistente lo avisa y pide confirmación. Una línea igual (misma huella y mismo número de
  repetición) a otra carga vigente queda **en revisión**: no se suma dos veces ni se elimina. Se acepta o descarta en
  *Cargas → Revisar*, con motivo.
- **Rechazadas**: falta TipoDocto, Bodega, Producto, UNIDAD, Fecha o Cantidad; fecha o cantidad no válidas; fecha fuera
  de rango (antes de 2000 o futura). **En revisión**: cantidad cero o signo contrario al tipo de archivo.
- **Revertir** una carga: deja de contar en todo; sus filas originales se conservan y la acción queda auditada.
- **Controles** (*Calidad*): lotes vacíos, referencias comerciales ausentes, `ERROR DE CONTRATO`, pesos cero o
  inconsistentes (> 1 %), RefFecha predeterminada (`22/03/2020`, no se usa para permanencia), fechas fuera de rango,
  cambios de lote en traspasos, salidas sin entrada observable, productos con varias unidades, lotes que solo difieren
  en mayúsculas, nombres de bodega con variantes (p. ej. espacios dobles), tipos sin clasificar, áreas por confirmar y
  ausencia de saldo inicial. Cada control indica qué indicadores afecta y abre sus filas.

## Normalización

- Identificadores (Numero, Producto, Lote, NumRel, Contrato, CodLegal…) como **texto**: se conservan ceros, puntos,
  guiones y sufijos; solo se recortan espacios de los extremos. Un número de Excel con formato de ceros respeta el texto
  mostrado.
- Datos ausentes quedan **sin dato** (NULL), nunca en cero.
- Bodega para agrupar: mayúsculas y espacios simples (`647-04  ALM PT` → `647-04 ALM PT`); el original se guarda.
- Lote, OT/OP (NumRel cuando DocRel es orden de producción), contrato y referencia comercial (NumRel cuando DocRel es
  contrato, subcontrato o pedido) **no se igualan** entre sí.

## Áreas y clases (editables, auditadas)

| Bodega | Área | Estado |
|---|---|---|
| 647-04 ALM PT | APT principal | Confirmada |
| 540-04 APT LB | APT LB | Confirmada |
| ST-VENTAS-IMD | Distribución | **Pendiente de confirmación del negocio** |

Clases de TipoDocto: producción (P/E), compra, traspaso, despacho de ventas, consumo, servicio de terceros, préstamo,
devolución, ajuste, anulación y sin clasificar. Un traspaso no es producción ni venta; un despacho no es una entrega.

## Reglas de cálculo

- **Población**: movimientos ACEPTADOS de cargas vigentes que cumplen los filtros globales (fecha, área, bodega, cliente,
  producto, unidad, lote, OT/OP, contrato, documento y búsqueda).
- **Unidades**: nunca se suman unidades distintas. Las tarjetas y gráficos usan la unidad elegida o la más frecuente
  del alcance y lo dicen; las demás se muestran aparte. Conversión solo con equivalencia **verificada**.
- **Variación neta** = entradas − salidas. **Inventario final** = saldo inicial + entradas − salidas + ajustes, solo si hay
  saldo inicial de todas las bodegas del alcance con la misma fecha de corte y el período empieza después de esa fecha.
- **Déficit acumulado**: saldo corrido por producto + lote + bodega + unidad que se vuelve negativo; nunca se compensa
  con otro producto.
- **FIFO**: por bodega + producto + lote + unidad, con cantidades parciales y sin reutilizar entradas; lotes vacíos
  excluidos. Hipótesis del mismo día (configurable): entradas antes que salidas; dentro de un lado, orden del archivo.
  Sin saldo inicial la asignación es **parcial** y puede cambiar al cargar más historia. Con foto de saldo inicial, los
  movimientos hasta su fecha de corte ya están en el saldo.
- **Permanencia** (días calendario): media, mediana, p90 y p95 ponderados por cantidad; distribución por días; parte que
  sale la misma fecha (cero días = misma fecha, no atención inmediata); cantidad y % de salidas enlazadas; salidas sin
  entrada observable. Lo asignado al saldo inicial no tiene fecha de ingreso y no entra en la media.
  - *Observada con vínculo explícito*: requiere vínculos entrada → salida en la tabla de equivalencias (hoy no hay).
  - *Estimada por FIFO*: la que se muestra.
  - *Antigüedad de lo abierto*: remanente de entradas observadas al corte, con antigüedad ponderada y rangos
    configurables.
- **Ciclo entre etapas** (APT → Distribución → despacho): solo sobre la cantidad trazable en todas las etapas (FIFO en
  Distribución hasta la entrada por traspaso, clave de traspaso conciliada y sin cambio de lote, FIFO en APT). No suma
  medias de etapas.
- **Traspasos**: clave = tipo + número + fecha + producto + unidad. Estados: conciliada, con diferencia, solo salida,
  solo entrada. Cambio de lote = el conjunto de lotes de la salida difiere del de la entrada.
- **Avance** (tres medidas separadas):
  1. Relación de flujos = salidas del período ÷ entradas del período.
  2. Salida de cohorte = entradas (con lote) del período asignadas a salidas ÷ entradas elegibles.
  3. Cumplimiento comercial, por pedido, línea y unidad: avance de despacho = despacho acumulado válido (despachos −
     devoluciones) ÷ compromiso vigente (versión mayor, sin cancelados); avance de entrega = recepción aceptada ÷
     compromiso vigente. Se muestran excesos y valores > 100 %. Un pedido está completo solo si todas sus líneas lo están.
     El despacho se asocia a un pedido solo por vínculo explícito pedido[#línea] → documento de despacho.
- **FechaEntrega**: hasta confirmar su significado se usa solo como diagnóstico (diferencia despacho − FechaEntrega), no
  como compromiso. OTIF, entrega a tiempo y completa quedan no disponibles sin compromisos y recepciones.
- **Denominador ausente o cero** → no disponible. No se promedian porcentajes sin ponderar.
- **Comparación con el período anterior**: solo si la historia cargada cubre por completo el período de igual duración.

## Decisiones pendientes del negocio

Se muestran en la aplicación sin inventar reglas: confirmación de ST-VENTAS-IMD como Distribución; significado de
FechaEntrega y RefFecha; regla para confirmar duplicados idénticos; equivalencias de lote en traspasos (218 claves con
cambio de lote en el período de referencia); saldos iniciales; equivalencias UND ↔ CIEN ↔ KG; compromisos comerciales,
recepciones, costos, horas y vehículos (productividad, utilización y costo por pedido/viaje no están disponibles).

## Validación con las bases

Los controles de aceptación (líneas, totales por área y unidad, despachos, traspasos conciliados, FIFO) se calculan
desde los archivos cargados y no están fijos en la aplicación. Con los archivos `Entradas_12-10.xlsx` y
`Salidas_12-10.xlsx` (01–12/10/2026) el motor reproduce exactamente un cálculo independiente en Python: 2.335 entradas
y 3.774 salidas; 1.077 claves de traspaso, 1.075 conciliadas y 415 con cambio de lote; APT principal 20.779 UND
enlazadas con 1,99 días ponderados. Para el período 09–21/10/2026 cargue los archivos de ese período en *Cargas* y compare
con los controles del requerimiento (ver el informe de entrega).
