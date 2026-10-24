# ERP: OT, guías y stock (Almacén APT › ERP: OT, guías y stock)

Pantalla `/apt/erp`. Usa dos Excel conectados al ERP (FLEXLINE) como fuente: **Actualizable Despacho**
(`usp_Rpt_ChecklistContratosListado`) y **Stock Bodega Despacho** (`usp_Rpt_StockBodegasListado`).

## Cómo cargar los Excel

1. Abra cada Excel en una PC de la red de JRM y presione **Datos › Actualizar todo**; guárdelo.
2. En **ERP: OT, guías y stock › Carga y estado**, seleccione uno o los dos archivos y pulse **Aplicar carga**.
3. Cada carga es una foto completa: reemplaza a la anterior del mismo archivo. Si la conexión se corta, **Reanudar
   carga** sigue desde el último bloque enviado, sin duplicar.

Requiere el permiso de carga del APT. Las tarjetas superiores muestran la hora de corte del ERP de cada archivo y
avisan cuando tiene más de un día.

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
