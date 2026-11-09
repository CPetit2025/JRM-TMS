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

## Lote destacado y papel personal

El lote se muestra a la derecha del SKU, en la misma fila, dentro de un recuadro negro con letras blancas en negrita. La bodega permanece en el encabezado.

En **Recepción, validación y etiquetado** y en **Configuración › Tamaños de etiqueta**, el selector **Mi papel para etiquetas de bulto** permite usar el formato compartido del almacén, A5 vertical (148 × 210 mm), A5 horizontal (210 × 148 mm) o un formato activo del catálogo. La preferencia se guarda por cuenta autenticada **en ese navegador**: otra cuenta o equipo conserva su propia configuración. Seleccionar «Usar configuración del almacén» elimina la preferencia personal. A5 usa el diálogo de impresora/PDF, aunque BrowserPrint esté instalado; los formatos térmicos conservan la integración Zebra.

La plantilla distribuye sus filas en el ancho y alto del papel completo. No recorta una etiqueta de proporción fija ni estira el logo o las letras: ajusta la cuadrícula y conserva la proporción de esos elementos. Vista previa, impresión y reimpresión reciben exactamente el mismo formato. Una etiqueta ocupa una hoja, incluidos los lotes. Al imprimir hay que seleccionar el papel correspondiente en el controlador, escala 100 % / tamaño real, sin márgenes ni encabezados. El área física imprimible depende de la impresora.

Pruebas Chromium: posición y colores del lote, ocupación completa del papel en ambos ejes, PDFs con dimensiones A5 vertical/horizontal y 100 × 50 mm, persistencia entre pantallas y preferencias independientes de dos cuentas. No se modificaron tablas, datos históricos ni TMS.
