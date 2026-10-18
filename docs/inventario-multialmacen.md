# Inventario multi‑almacén (reingeniería de APT)

Un solo libro de movimientos para **todas las bodegas** del ERP. Cubre cuatro preguntas: dónde está el stock y si está
libre (**stock disponible**), cuánto tiempo pasa en cada bodega (**estadía**), de dónde viene y en qué terminó un lote
(**trazabilidad**) y cómo se mueve el material entre almacenes (**flujo**).

Menú: *Almacén APT → Inventario multi‑almacén* (`/apt/inventario`). Permisos: `apt` (ver) y `apt-carga` (cargar,
recalcular y editar catálogos). El Administrador y el Jefe de Distribución tienen ambos.

## Uso diario
1. *Cargas y catálogos* (`/apt/inventario/datos`): subir los reportes del ERP **Entradas** y **Salidas** (todas las
   bodegas, mismas columnas: TIPODOCTO, BODEGA, Numero, Fecha, Producto, GLOSA, Cantidad, UNIDAD, DocRel, NumRel, Lote,
   PesoUnitario, PesoTotalProduccido…). Un mismo libro puede traer ambos: cada fila va al lado que indica el signo de
   Cantidad.
2. El envío se realiza por bloques de 500 filas, con porcentaje de avance y hasta tres intentos ante una interrupción transitoria. Los bloques confirmados no se vuelven a enviar y los reintentos del mismo bloque no duplican filas ni contadores.
3. Cada lado **reemplaza** sus movimientos del rango de fechas del archivo (no duplica). Un archivo que parece filtrado
   (trae muchas menos filas que las que ya hay en su rango) se detiene y pide confirmación.
4. Opcional: subir una **foto de stock** (bodega, producto, lote, saldo y peso) con su fecha de corte. El modelo arranca
   el día siguiente: el saldo inicial deja de ser inferido.
5. Al aplicar se recalcula el modelo en el servidor (`/api/inventario/procesar`, llave de servicio; el tiempo depende del volumen de movimientos y traspasos).

Si se interrumpe el envío, mantenga abierta la ventana y pulse **Reanudar carga**. Se continúa desde el último bloque
confirmado; las partes ya aplicadas se conservan y solo se vuelve a intentar lo pendiente. Esta reanudación está
limitada a la misma ventana y los mismos archivos seleccionados. Si el recálculo falla tras aplicar, el reintento
no vuelve a importar los movimientos aplicados. Una carga en preparación abandonada por más de un día se limpia
con la siguiente carga, como antes.

Los catálogos cuentan movimientos mediante agregaciones por dimensión, evitando una lectura completa por cada
bodega o tipo de documento. La normalización de lotes conserva las reglas originales, con una sola evaluación.

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
