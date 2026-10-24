# ERP: OT, guías y stock (Almacén APT › ERP: OT, guías y stock)

Pantalla `/apt/erp`. Usa dos Excel conectados al ERP (FLEXLINE) como fuente: **Actualizable Despacho**
(`usp_Rpt_ChecklistContratosListado`) y **Stock Bodega Despacho** (`usp_Rpt_StockBodegasListado`).

## Cómo cargar los Excel (única fuente)

El ERP se carga solo con dos archivos, una vez al día, en **Almacén APT › Cargar datos del ERP** (`/apt/datos`):
**Actualizable Despacho** y **Stock Bodega Despacho**.

1. Abra cada Excel en una PC de la red de JRM y presione **Datos › Actualizar todo**; guárdelo.
2. Seleccione los dos archivos juntos y pulse **Aplicar carga**. Cada uno reemplaza su foto anterior.
3. Con los dos vigentes, el TMS genera los **movimientos del día** comparando el stock de hoy con el del día anterior
   (bodegas 647-04 ALM PT, 540-04 APT LB y ST-VENTAS-IMD) y tomando las guías nuevas:
   - guía nueva del Actualizable → despacho (con la fecha de la guía en el ERP);
   - lote que baja en una bodega y sube en otra → traspaso;
   - lote que sube sin traspaso → ingreso (producción en 647);
   - lote que baja sin guía ni traspaso → ajuste.
4. Esos movimientos actualizan el inventario multi-almacén (stock, estadía, trazabilidad y flujo), el APT clásico, la
   Analítica APT y Distribución y el peso APT de los servicios. Volver a cargar el mismo día recalcula ese día sin duplicar.

La primera carga toma como base el stock del inventario calculado con el último DATA (Entradas y Salidas) cargado; desde
entonces solo se usan los dos archivos. Una bodega que no viene en el Stock (hoy la 540) no se modifica. Si se salta
un día, los cambios entran juntos con la fecha de la carga siguiente (las guías conservan su fecha). «Generar
movimientos del día» reintenta la generación sin volver a subir los archivos.

## OT pendientes (reglas v1)

Por OT: contratado, despachado, avance, pendiente (unidades y toneladas) y **listo en stock**: lo pendiente que ya
tiene stock en el ERP con el lote de la OT o del subcontrato. Por defecto no cuenta los servicios a terceros ni los
documentos «Error de contrato» (se pueden incluir). Al abrir una OT se ven sus líneas, las guías despachadas con sus
dos fechas y el stock con su lote.

## Guías: fecha ERP y fecha TMS

Cada guía del Actualizable se cruza con las rutas del TMS (la guía registrada al programar o al liquidar).

- **Fecha ERP**: exacta cuando la línea tiene una sola guía o cuando la guía está en las Salidas cargadas; si no, es
  la del último despacho de la línea (aproximada).
- **Fecha TMS**: salida programada de la ruta que llevó la guía (programa de entrega).
- **Fecha de referencia**: Automática (TMS y, si no hay, ERP), solo TMS o solo ERP; define el período.
- **Origen**: ERP y TMS, solo ERP (despacho sin ruta en el TMS) o solo TMS (guía de una ruta que el ERP no muestra:
  revisar si está mal digitada o aún no emitida).
- **Desfase**: diferencia entre fechas mayor a la tolerancia (2 días por defecto) u OT del TMS distinta a la del ERP.

## Stock por OT (reglas v1)

Cada lote del stock se clasifica: listo para despachar, sobrante (supera lo pendiente), OT completa, SKU fuera del
contrato, lote sin OT, sin lote o stock negativo. El lote del ERP es la OT o el subcontrato (los ceros a la izquierda
se ignoran). Los productos en cientos («CIEN») se convierten a unidades y su peso se calcula por unidad: el
Peso_Total del ERP queda 100 veces bajo en esos productos.

«OT pendientes» y «Stock por OT» aplican las **reglas heredadas, versión 1, sin aprobación comercial** (ver «Reglas y
comparación»). Sus resultados no cambian; cada pestaña lo indica con un aviso.

## Análisis (cruce exacto)

Cruce **sin reglas de conversión**: el stock se asigna solo si Lote = Nro_Documento, con el mismo Cod_Producto y la misma
unidad del ERP (se normalizan solo espacios y mayúsculas; se conservan ceros iniciales y sufijos).

- Granularidad: documento + producto + unidad (las secuencias del documento se suman; cada lote se suma una vez aunque el
  documento tenga varias líneas o bodegas, así no se multiplican cantidades). Vista por OT: un renglón por OT, **tipo de
  documento y unidad** (contratos, subcontratos, garantías y errores por separado; nunca una demanda neta por OT).
- Stock: **vacío (—) = sin coincidencia de stock**; **0 = stock coincidente igual a cero**. Faltante = máx(pendiente −
  stock, 0) solo si hay pendiente; cobertura solo con pendiente y coincidencia.
- Estado del cruce: coincide, unidad distinta, lote con ceros, lote con sufijo D o sin coincidencia (la causa se informa,
  no se asigna stock).
- «ERROR DE CONTRATO» y «SERVICIO A TERCEROS» se ven siempre (filtro por tipo de documento).
- «Fecha de vencimiento superada» = pendiente con Fecha_Vcto anterior a hoy. Vigencia_Contrato se muestra como atributo del
  ERP, sin interpretarla por fecha.
- Filtros: OT, documento, cliente o RUC, SKU o producto, familia, estado del ERP, tipo de documento, unidad, bodega,
  vigencia, cruce, solo con pendiente y vencimiento superado. Detalle con las líneas del ERP (fila del Excel de origen),
  lotes y guías. Exportación a Excel.
- El Actualizable guarda la unidad original del ERP (`unidad_erp`), la fila del Excel y qué cantidades venían vacías
  (`cantidades_ausentes_campos`).
- **Cantidades ausentes**: las vistas v1 conservan su comportamiento (la cantidad vacía cuenta como 0). En el análisis
  exacto la cantidad vacía queda «s/d» y también los indicadores que dependen de ella (avance, faltante, cobertura); la fila
  se marca incompleta y «solo con pendiente» no la oculta. En el resumen y en la vista por OT una fila incompleta queda
  fuera de **todas** las sumas, conteos e indicadores (contratado, despachado, reemplazado, pendiente, stock, faltante,
  avance y cobertura): cada porcentaje se calcula con la misma población de filas válidas. Se informan las filas válidas y
  las excluidas, y el total se marca «parcial». Un aviso indica cuántas filas del filtro están incompletas.
- **Filtro de bodega**: selecciona los documentos con stock coincidente en esa bodega; el stock, el faltante y la cobertura
  mostrados incluyen todas las bodegas del documento (se ve la lista de bodegas en cada fila).
- **Detalle**: un lote «coincide» solo si lote = documento, mismo producto y misma unidad, con la misma normalización de la
  tabla. Los lotes con ceros a la izquierda, sufijo D u otra unidad se muestran como **candidatos** y no suman.
- **Exportación**: trae todo el filtro por páginas de 5.000 con orden estable (la base entrega como máximo 20.000 por
  consulta) y comprueba que las filas exportadas coincidan con el total filtrado, sin repetidos; si no, no genera el
  archivo. Las cargas del Actualizable y del Stock de la primera página quedan fijas para documentos, OT y resumen: cada
  página siguiente las envía y la base la rechaza si otra carga las reemplazó (aunque el total y las claves sean iguales),
  igual que una consulta durante la cual cambien. La hoja «Control» registra total filtrado, filas exportadas, los
  identificadores de ambas cargas, filtros y fecha.

## Calidad de datos

Controles sobre los cortes vigentes, con ejemplos: claves repetidas o vacías, filas omitidas, fórmula del pendiente,
sobredespacho, cantidades ausentes, Cant_Reemplazada siempre 0, escrituras de unidad, Vigencia S con Fecha_Vcto superada,
fechas faltantes; en el Stock, claves repetidas, filas sin lote, lotes con ceros o sufijo D, stock negativo, stock en
falla y medidas por producto repetidas por lote (Stock_Comprometido, Requerimiento, Orden_Compra); en el cruce, unidad
distinta y diferencia de horas entre los cortes de los dos archivos.

## Reglas y comparación

Las reglas vigentes están versionadas (`erp_rule_versions`). Hoy rige la **versión 1, heredada**: CIEN → UND, UNID → UND,
lote sin ceros, peso por unidad, total por OT sumando tipos y unidades, y exclusión por defecto de errores y servicios.
Cada carga del ERP y cada día derivado guardan la versión aplicada. Una versión nueva solo se crea con reglas aprobadas.

Comparación con y sin cada regla, mismos cortes (Actualizable 23/10 16:51, Stock 23/10 21:47):

| Regla | Afecta | Sin la regla | Con la regla |
|---|---|---|---|
| CIEN → UND | 89 lotes, 10 productos (arandelas, tuercas, pernos) | 1.298,85 CIEN sin cruce («unidad distinta») | 129.885 UND; cruza 127.231 UND pendientes |
| Lote sin ceros | 57 lotes con ceros; 32 coinciden con la clave auxiliar | sin stock coincidente | 17.733 de stock cruzan; 0 colisiones, 0 claves ambiguas |
| Peso por unidad | 60 lotes en CIEN con peso | 28,7 kg (Peso_Total ERP = stock × Peso_Unitario en los 60) | 2.874,5 kg |
| Suma de tipos por OT | 397 de 1.485 OT con pendiente tienen varios tipos; 67 varias unidades | por tipo y unidad | un total por OT; 5 líneas con sobredespacho (−431) cuentan como 0 |
| Exclusión por defecto | ERROR DE CONTRATO 6.320 líneas (1.306 con pendiente); SERVICIO A TERCEROS 6.826 | visibles | fuera de «OT pendientes» salvo casillas |
| UNID → UND | 15 líneas | unidad UNID aparte | sumadas a UND |

Análisis exacto con esos cortes: 63.923 documento-producto (16.708 con pendiente); de los que tienen pendiente, 1.104
coinciden con stock, 79 tienen unidad distinta, 41 lote con ceros y 15.484 no tienen stock.

**Decisiones comerciales pendientes**: equivalencia CIEN/UND por producto; interpretación de Peso_Unitario; clave sin
ceros; sufijo D; relación contrato / subcontrato / garantía / error para la demanda por OT; tratamiento de errores y
servicios a terceros; significado de Fecha_Vcto y Vigencia_Contrato; equivalencias de unidad; uso de Stock_Falla y
Stock_Comprometido; metas y responsables de los indicadores.

## Diccionario de indicadores

Cada indicador con propósito, fórmula, granularidad, origen, filtros, tratamiento de nulos y ceros, exclusiones y
limitaciones, y si depende de reglas v1. Meta y responsable: pendientes de configuración.

## Cargas

- Registro de cada intento (`erp_load_log`), también los fallidos: lectura del archivo, Actualizable, Stock y movimientos
  del día, con filas esperadas y cargadas, duración, usuario, error y versión de reglas. Una carga del mismo archivo en
  curso de otro usuario (últimos 15 min) bloquea la segunda.
- Marcas de tiempo: **corte del ERP** (de cuándo son los datos) y **procesado en el TMS** (cuándo se aplicaron).
- La actualización es manual. La actualización automática cada 20 minutos **no está operativa**: requiere un proceso
  de extracción y envío desde la red del ERP que aún no existe ni se ha probado.

## Referencia del ERP en Operaciones (solo lectura)

Las pantallas de Operaciones consultan el ERP vigente como referencia, sin crear ni modificar registros del TMS y con las
reglas del análisis exacto (sin conversiones de unidad; filas con cantidades ausentes fuera de las sumas).

- **Registro de Servicios** (vista de acopio de Comercial a Operaciones): columna **ERP** por servicio con sus guías
  contra el Actualizable (✓ en el ERP, ⚠ de otra OT, ✗ no está) y la actividad de la OT, y filtro «ERP» (diferencias,
  guía que no está, guía de otra OT, OT inactiva). En el detalle de un servicio se ven la referencia de la OT y la
  validación de cada guía.
- **Programación y Ruteo** (Armar ruta): cada parada elegida muestra en una línea el pendiente del ERP de su OT, el stock
  coincidente y cuántas guías del ERP no tienen ruta.
- **Torre de Control**: tarjeta «Guías ERP vs TMS» de los últimos 7 días (en ambos, solo ERP, solo TMS y desfase de fecha)
  y, en el expediente del despacho, la referencia de cada OT.
- **Documentos de Despacho**: en «Estado documentario» las guías del servicio se validan contra el ERP y se muestra la OT.
- Monitoreo GPS no cambia: muestra posiciones y no tiene datos del ERP que cruzar.

Funciones: `erp_ref_ot`, `erp_ref_guias`, `erp_ref_guias_resumen` (permiso `erp_ref_can_view`: APT, Contratos y OTs o
alguna pantalla de Operaciones). El Administrador de Contratos solo ve las OT de su cartera (`erp_ref_ot_visible`) y nadie
ve una OT de una sede a la que no tiene acceso. Prueba: C145.

## Contratos con el ERP

El módulo Contratos usa el Actualizable y el Stock como fuente de verificación. El ERP numera igual que el TMS (`15304`,
`15304-S008`, `15304-E011`, `14840-G01`); se enlaza por código sin ceros a la izquierda en el correlativo (`E01` = `E001`).

- **Columna ERP** en la lista de Contratos: si la OT está en el ERP, su estado (sin despacho, parcial, completo), avance
  (solo con una unidad; no se suman unidades distintas), stock listo (lote = documento, mismo producto y unidad, con
  pendiente), OT activa o inactiva y diferencias: no está en el ERP, cliente distinto, RUC no válido, documentos del ERP
  sin alta y garantía sin Error. Filtro «Verificación con el ERP». La OT independiente no aplica.
- **OT activa**: el último despacho (el más reciente entre el ERP y las rutas del TMS) está dentro del umbral (90 días por
  defecto). La reactivan, aunque no haya despacho reciente, los eventos marcados: garantía nueva (ERP o TMS), subcontrato
  o error nuevo en el ERP y solicitud en el TMS. Un contrato sin despachos cuenta desde su fecha de contrato. El umbral,
  los eventos y las horas para avisar que el corte está desactualizado los cambia el Administrador (botón de
  configuración). La marca solo informa y filtra: no bloquea solicitudes ni libera partidas (reglas comerciales pendientes).
- **Garantía de ventas**: tipo de documento hijo de la OT madre, sin partida propia. Al registrarla (alta, ficha de la OT
  o carga masiva) se genera siempre su **Error de contrato** con el siguiente correlativo libre en el TMS y en el ERP,
  vinculado a la garantía; ese Error lleva el transporte y su costo con la partida de la familia. La garantía no se elige
  en Solicitudes.
- **Cliente según el ERP**: al cargar el Actualizable, el cliente de cada OT madre se corrige con el RUC del ERP (si el
  cliente no existe se registra; RUC con dígito verificador SUNAT; un RUC no válido no corrige nada y queda como
  diferencia). Se corrigen la OT, sus subcontratos, errores y garantías, y las solicitudes que aún no salen a ruta; las que
  están en ruta, entregadas o cerradas conservan su cliente. Queda un historial con el cliente anterior y se avisa al
  responsable de la OT (aviso «Cliente de una OT corregido», categoría Cumplimiento). En «Correcciones de cliente» el
  Administrador puede aplicar la corrección también a las solicitudes cerradas o revertirla; una corrección revertida no
  se vuelve a aplicar mientras el ERP mantenga el mismo RUC. También se puede revisar y corregir a mano («Revisar
  diferencias con el ERP»).
- **Alta automática**: al cargar el Actualizable, las OT **activas** del ERP que no existen en el TMS se dan de alta solas:
  primero la OT madre (con su cliente por RUC, registrado si no existe; sede principal) y luego sus subcontratos y
  errores, colgados de la madre con su cliente y sede. Quedan **sin partida** (se asigna en Contratos; nada se libera por
  el ERP). No se dan de alta solas: las garantías (llevan su Error de contrato, decisión comercial), las OT madre sin RUC
  válido y los hijos cuya madre falta; esos siguen en «ERP sin alta». Cada alta queda registrada (`erp_contract_altas`) y
  se avisa a Contratos y OTs (aviso «OT dadas de alta desde el ERP», Cumplimiento). En «ERP sin alta», «Dar de alta
  automáticamente ahora» muestra cuántas se crearán y pide confirmación. Se ejecuta en el servidor (sin el límite de 8 s).
- **Alta asistida**: «ERP sin alta» lista los documentos del ERP que no existen en el TMS (por defecto de OT activas) y
  «Dar de alta» abre el alta con el tipo, la madre y el código. Al escribir un código en el alta se muestra lo que dice el
  ERP y se puede tomar su cliente (se registra si no existe). El destino y la partida los completa una persona: el ERP no
  los trae.
- **Ficha rápida de la OT**: referencia del ERP con el pendiente por tipo y unidad, stock y guías.
- **Cliente en el APT** («OT con más stock», Contratos y ficha de la OT): el de las guías; si la OT no tiene guías, el del
  contrato en el TMS (madre o hijos); si tampoco, el del Actualizable vigente.

Funciones: `erp_ref_contratos` (por lotes de hasta 5.000 códigos), `erp_ref_documento`, `erp_ref_sin_alta`,
`erp_ref_guias_lote`, `erp_cliente_desde_erp`, `erp_contratos_alta_automatica` (núcleo `_core` en el servidor),
`erp_contratos_sincronizar_clientes`, `erp_cliente_correcciones`,
`erp_cliente_correccion_aplicar_cerradas`, `erp_cliente_correccion_revertir`, `erp_contratos_config_json` y
`erp_contratos_config_set`. Tablas: `erp_contract_settings`, `contract_client_corrections`; columna
`contracts.garantia_id`, `erp_contract_altas`. Pruebas: C146 y C149.
