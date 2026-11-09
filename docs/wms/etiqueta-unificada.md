# Etiqueta única de bulto

Recepción (`/almacen/etiquetado`), Control de recepcionados, detalle del paquete e inventario usan `PackageLabel`. Conserva el diseño de Recepción: logo JRM, cliente, OT, lote/bodega, SKU, descripción, Code 128, código original, IPT, fecha, cantidad/peso y secuencia.

La composición canónica es de 6 × 4 pulgadas. `PackageLabelPreview` escala la etiqueta completa, sin cambiar fuentes o proporciones según la pantalla. `printPackageLabels` crea las páginas con esa misma plantilla y el tamaño PAQUETE configurado. Ya no hay etiquetas alternativas de 100 × 50 mm ni un tamaño fijo exclusivo de reimpresión.

Zebra Browser Print recibe `^GFA`: imagen de la misma plantilla a la resolución configurada, no una segunda composición de textos ZPL. Una impresora térmica monocromática reproduce el diseño en blanco y negro; no puede producir el azul/amarillo del original en color. Se conserva el contraste del logo. El navegador/PDF conserva los colores. La salida física requiere tamaño real / 100 %, sin ajustes de escala del controlador.

Los valores de la primera impresión se recuperan de `wh_packages`, en vez de volver a calcular cantidades y pesos en el navegador. Las reimpresiones usan los mismos campos originales y la resolución de cliente existente. Inventario no sustituye el IPT original por el código de campaña. Se mantienen los permisos, el código y la auditoría de impresión/reimpresión con motivo. No se modifican esquema ni datos históricos.

## Validación

- `node scripts/test-unified-package-labels.cjs`: datos originales, decimales, cliente/OT, orden del lote, fallos de lectura y conversión binaria/ZPL.
- `node scripts/test-unified-package-labels-browser.cjs`: Chromium y API local simulada. Compara el HTML completo de vista previa/impresión en los cuatro recorridos. Compara byte por byte la imagen Zebra de los cuatro recorridos. Comprueba una página PDF por etiqueta, tamaño configurable 100 × 50 mm y móvil sin desbordamiento. Conserva código original y motivo auditado, sin generar bultos al reimprimir.
- `test-wms-isolation.mjs`, `test-wms-bootstrap.cjs`: aislamiento WMS y regresión del ciclo de recepción/permisos.
- TypeScript, lint de archivos modificados y compilación dedicada WMS.
- CI `WMS unified package labels` guarda capturas, PDF y ZPL como artefactos.

El control global `check:guards` de la rama WMS presenta incidencias C55 previas en migraciones de recepción/picking; este cambio no altera SQL. Los controles de esta entrega verifican la base WMS independiente y su aislamiento.

La prueba de Zebra usa un dispositivo simulado y valida los datos enviados. No sustituye una prueba física en la impresora del almacén.
