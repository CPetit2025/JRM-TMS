# Inventario multi‑almacén (reingeniería de APT)

Un solo libro de movimientos para **todas las bodegas** del ERP. Cubre cuatro preguntas: dónde está el stock y si está
libre (**stock disponible**), cuánto tiempo pasa en cada bodega (**estadía**), de dónde viene y en qué terminó un lote
(**trazabilidad**) y cómo se mueve el material entre almacenes (**flujo**).

Menú: *Almacén APT → Inventario multi‑almacén* (`/apt`) y *Cargar datos del ERP* (`/apt/datos`). Las pantallas APT anteriores se retiraron: sus direcciones redirigen al módulo nuevo. Permisos: `apt` (ver) y `apt-carga` (cargar,
recalcular y editar catálogos). El Administrador y el Jefe de Distribución tienen ambos.

## Uso diario
1. *Cargas y catálogos* (`/apt/inventario/datos`): subir los reportes del ERP **Entradas** y **Salidas** (todas las
   bodegas, mismas columnas: TIPODOCTO, BODEGA, Numero, Fecha, Producto, GLOSA, Cantidad, UNIDAD, DocRel, NumRel, Lote,
   PesoUnitario, PesoTotalProduccido…). Un mismo libro puede traer ambos: cada fila va al lado que indica el signo de
   Cantidad (el formato del ERP trae dos hojas, ENTRADA con cantidades positivas y SALIDA con negativas). Si el nombre
   de una hoja contradice el signo de sus filas, se avisa antes de aplicar.
   Cada parte se aplica por separado y muestra su resultado; si una falla, las demás quedan cargadas y «Reanudar carga»
   completa solo la pendiente. Al terminar se comprueba en la base que cada lado quedó con el rango completo del archivo,
   y *Cobertura de datos* marca en rojo si faltan las Entradas o las Salidas.
2. El envío se realiza por bloques de 500 filas, con porcentaje de avance y hasta tres intentos ante una interrupción transitoria. Los bloques confirmados no se vuelven a enviar y los reintentos del mismo bloque no duplican filas ni contadores.
3. Cada lado **reemplaza** sus movimientos del rango de fechas del archivo (no duplica). Un archivo que parece filtrado
   (trae muchas menos filas que las que ya hay en su rango) se detiene y pide confirmación.
4. Opcional: subir una **foto de stock** (bodega, producto, lote, saldo y peso) con su fecha de corte. El modelo arranca
   el día siguiente: el saldo inicial deja de ser inferido.
5. El recálculo programado (cada 2 min) no corre mientras hay una carga en preparación, y aplicar espera como máximo
   20 s un recálculo en curso: si sigue ocupado, el navegador reintenta solo (C118).
6. Al aplicar se recalcula el modelo en el servidor (`/api/inventario/procesar`, llave de servicio; el tiempo depende del volumen de movimientos y traspasos).

Si se interrumpe el envío, mantenga abierta la ventana y pulse **Reanudar carga**. Se continúa desde el último bloque
confirmado; las partes ya aplicadas se conservan y solo se vuelve a intentar lo pendiente. Esta reanudación está
limitada a la misma ventana y los mismos archivos seleccionados. Si el recálculo falla tras aplicar, el reintento
no vuelve a importar los movimientos aplicados. Una carga en preparación abandonada por más de un día se limpia
con la siguiente carga, como antes.

Los catálogos cuentan movimientos mediante agregaciones por dimensión, evitando una lectura completa por cada
bodega o tipo de documento. La normalización de lotes conserva las reglas originales, con una sola evaluación.
El recálculo consulta solo las capas dentro de los límites FIFO mediante índices y actualiza las estadísticas
de las tablas de trabajo. Los movimientos toman su clase del catálogo al enviarse, evitando una reclasificación
masiva después de importar. Se conservan las fórmulas de cantidad, peso, consumo y origen.

## Modelo (`supabase/migrations/20261020100000_inventario_multialmacen.sql`)
| Concepto | Regla |
|---|---|
| Bodega | Código = nombre en mayúsculas y con espacios simples. El tipo (materia prima, producción, producto terminado, despacho ST, pernería, MRO, mantenimiento, herramientas, activos, tercero, obra/cliente) se deduce del nombre y se corrige en el catálogo. |
| Clase de movimiento | Por TIPODOCTO, editable: producción (P/E), compra (N/INGRESO, importación), traspaso, despacho (DESPACHO VENTAS), consumo (vales V/C), servicio de terceros (GS/PE SERV TERCEROS), préstamo (SALIDA HERRAMIENTAS), devolución. |
| Lote | Mayúsculas, sin ceros a la izquierda ni «.0»; «0», «1» y vacío = sin lote. **OT** = lote con forma de contrato (16339 o 16339‑S005). |
| Libre / comprometido | Libre: lote sin OT (stock de OP interna, de proveedor o sin lote). Comprometido: lote de una OT. |
| Traspaso | Se empareja la salida y la entrada del mismo documento y producto: primero líneas con la misma cantidad, luego en orden. El enlace guarda lote de origen y de destino (**reasignación**: 540 o Pernería → contrato). |
| FIFO | Por bodega + producto + lote y por **cantidad** (las unidades no se mezclan). En un mismo día, ingresos antes que salidas. Peso = cantidad × peso unitario (del movimiento o el promedio del producto). |
| Saldo inicial | Foto de stock si existe; si aún falta, lo mínimo para que el saldo nunca sea negativo (**inferido**, se muestra como tal). |
| Origen raíz | Cada capa que llegó por traspaso hereda el origen (producción, compra, servicio) de lo que consumió su salida en la bodega anterior, en cadena. |
| Estadía | Días en la bodega = fecha de la salida − ingreso de la capa. Días desde el origen = fecha de la salida − fecha del origen raíz (si se conoce al menos el 50 %). |

## Pantallas
- **Panorama**: stock por bodega (libre/comprometido), movimientos del período, préstamos de herramientas pendientes,
  material en servicio de terceros y calidad de datos.
- **Stock disponible**: bodega · producto · lote con cantidad, peso, OT, cliente, días en bodega y desde el origen;
  filtros y Excel.
- **Estadía**: promedio, p50, p90 y máximo por bodega; salidas por rango de días; antigüedad del stock; tiempo por etapa
  (origen → última bodega → destino); stock más antiguo.
- **Trazabilidad**: busca lote, OT, guía, documento u OP. Muestra lotes de origen (hacia atrás) y derivados (hacia
  adelante), el recorrido por bodegas con su estadía, reasignaciones, saldo actual y todos los movimientos.
- **Flujo entre almacenes**: diagrama ingresos → bodegas → salidas (kg o líneas), matriz de traspasos con días en origen
  y reasignaciones.

Prueba: `supabase/tests/caja_c115_inventario_multialmacen.test.sql` (C115) y `scripts/test-inventario-parse.cjs`.
Las pantallas APT anteriores siguen disponibles mientras se migran.

Regresiones de reintentos: `scripts/test-inventario-upload.cjs` y C116. Prueba local con PostgreSQL aislado y
201.573 movimientos (130.116 salidas + 71.457 entradas): `node scripts/test-inventario-sql.cjs` (requiere Docker).

El recálculo (`20261020160000_inventario_recalculo_rapido.sql`) guarda lo consumido de cada capa al crearla, recalcula
el origen raíz solo de los traspasos afectados en cada vuelta y no usa llaves foráneas en las tablas derivadas: con
201.573 movimientos baja de 17,6 s a ≈ 10,5 s en local con resultados idénticos. Las pruebas de inventario esperan a
un recálculo real en curso antes de empezar.

Lecturas (`20261020170000_inventario_lecturas_rapidas.sql`): tras cada recálculo se guardan las vistas iniciales
(Resumen, Estadía, Flujo, Verificación, Catálogos) y el stock por clave con glosa y cliente. Las pestañas sin filtro
de fechas y todo Stock disponible leen esa caché (milisegundos) y no esperan a un recálculo en curso; con filtros de
fecha se calcula en vivo. Una caché de un recálculo anterior no se usa. «Recalcular» no espera a otro recálculo en
curso, y el recálculo programado corre con límite de 5 min y deja la caché al día (C119).

C115 aísla sus escenarios funcionales dentro de una transacción que siempre se revierte. C117 ejecuta una sola
reconstrucción del historial real, con presupuesto independiente de 110 s, y comprueba cobertura y conservación
de cantidades. Así las tres reconstrucciones de C115 no comparten el presupuesto de una carga real.

## Verificación (`inv_verify`, pestaña *Datos y verificación*)
Seis controles medibles, con meta y estado (Cumple / Revisar / No cumple), y el cuadre por bodega exportable a Excel:
cuadre de cantidades (saldo = inicial + entradas − salidas, diferencia 0), traspasos emparejados (≥ 99 %), salidas con
origen conocido (≥ 95 %; sube con una foto de stock o más historia), líneas con peso (≥ 90 %), cobertura de fechas y
modelo recalculado. Prueba: `caja_c117_inventario_verificacion.test.sql`.

## Carga única
Al aplicar Entradas/Salidas, los mismos archivos actualizan el modelo APT anterior (647 · 540 · ST), del que aún leen
Registro de Servicios (peso APT), Eficiencia de flota, el detalle de guías, los contadores del menú y la IA. Si esa
actualización falla, el inventario queda cargado y se muestra el aviso.
