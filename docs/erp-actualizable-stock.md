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

## OT pendientes

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

## Stock por OT

Cada lote del stock se clasifica: listo para despachar, sobrante (supera lo pendiente), OT completa, SKU fuera del
contrato, lote sin OT, sin lote o stock negativo. El lote del ERP es la OT o el subcontrato (los ceros a la izquierda
se ignoran). Los productos en cientos («CIEN») se convierten a unidades y su peso se calcula por unidad: el
Peso_Total del ERP queda 100 veces bajo en esos productos.
