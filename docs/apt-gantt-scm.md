# Gantt SCM de APT

La consulta `/apt/gantt` reúne OT, lotes, permanencia por almacén, movimientos documentales y saldo en TN. Usa el modelo de flujo multi-almacén; sus cifras se concilian con el Kardex bajo el mismo alcance, no con la estadía simplificada de ENTRADA/SALIDA que excluye consumos y otros movimientos.

## Alcance y lectura

- El inicio disponible es el ingreso registrado de producción. No equivale al inicio de fabricación.
- Las salidas de despacho representan guías registradas, no recepción conforme en destino. El detalle enlaza la trazabilidad existente de guías y TMS.
- Los segmentos representan permanencia reconstruida por FIFO, con resolución diaria. Los eventos documentados permiten consultar fechas, pesos y documentos.
- Los traspasos internos no vuelven a sumar TN ingresadas; asignaciones y cesiones de lote se muestran por separado. Stock previo sin fecha no recibe una fecha de producción inventada.
- Las salidas por consumo/otros almacenes se distinguen del despacho. El saldo residual permanece visible aunque esté dentro de la tolerancia configurada.
- TN×días representa la prioridad del saldo a la fecha de corte; no es la integral histórica de ocupación.

## Consulta y permisos

El acceso reutiliza `apt`/`apt-carga` y la autorización SQL existente. No hay acceso anónimo ni operaciones de edición desde el Gantt. La consulta usa el modelo ya calculado; desplazarse, filtrar o cambiar escala no reconstruye FIFO.

La tabla está paginada. Los totales y prioridades corresponden al conjunto filtrado; el agrupado de OT de la página identifica su alcance para no presentar subtotales como totales completos. Los documentos y segmentos detallados tienen límites visibles.

## Uso

Aplicar los filtros de OT, lote, cliente, almacén y fechas, expandir una OT y seleccionar un lote para consultar su evolución. La fecha de corte y la cobertura de datos permiten interpretar saldos históricos sin confundirlos con monitoreo en vivo. La configuración de alerta y tolerancia se conserva en Cargas y parámetros.

La exportación indica el alcance consultado. En móvil se utiliza un resumen y cronología compacta; la vista amplia de escritorio sincroniza la tabla y la escala temporal.

## Antigüedad y filtros

En el corte del modelo, la antigüedad ponderada usa las piezas de origen ya calculadas: un traspaso no reinicia la antigüedad. En un corte anterior, los saldos se reconstruyen exactamente desde las asignaciones FIFO fechadas, pero la antigüedad disponible se expresa desde el ingreso a la etapa/almacén. La pantalla y la exportación identifican `ORIGEN` o `ALMACEN`; no presentan ambos cálculos como equivalentes.

El filtro de almacén selecciona los lotes con paso registrado por ese almacén, conservando la conciliación completa del lote. No es un filtro de ubicación actual. El rango visible y el corte se identifican separadamente. Las fechas posteriores al corte del modelo se limitan a dicho corte; la cobertura muestra si las cargas y el modelo tienen fechas distintas.

## Validación

`node scripts/test-apt-gantt.cjs` ejecuta la consulta SQL real en PostgreSQL aislado con las tablas documentadas de producción. Comprueba saldos históricos, traspasos internos, salidas parciales, stock previo sin fecha, TN críticas por origen, familias de OT, paginación, permisos y carga sintética de 64.000 capas/salidas/asignaciones. Es una prueba de volumen reproducible; no sustituye la medición de concurrencia real.

`supabase/tests/caja_c65_apt_gantt.test.sql` verifica la instalación y el contrato en el workflow de producción, dentro de una transacción con reversión.

Una carga aplicada después del último recálculo activa el aviso de modelo pendiente, incluso si reemplaza exactamente las mismas fechas. El Gantt conserva el resultado anterior, lo identifica y enlaza a Cargas para revisar el recálculo; consultar la ventana nunca inicia una reconstrucción.
