# Etiqueta única de bulto

Recepción (`/almacen/etiquetado`), Control de recepcionados, detalle del paquete e inventario usan `PackageLabel`: logo JRM, cliente en hasta dos líneas sin reducir fuente, OT, lote destacado a la derecha del SKU, descripción centrada, Code 128, código original, IPT, fecha, cantidad/peso y secuencia.

La referencia visual es la etiqueta de Recepción de 6 × 4 pulgadas. La cuadrícula se adapta al **tamaño de etiqueta**, manteniendo proporciones del logo y letras. `PackageLabelPreview` muestra esa misma composición. Primera impresión y reimpresiones recuperan los valores persistidos de `wh_packages`, sin recalcular pesos/cantidades ni sustituir la identidad del bulto.

## Configuración independiente de etiqueta y hoja

Los ajustes se administran únicamente en **Configuración › Etiquetas** (`/almacen/maestros/etiquetas`). Recepción conserva un enlace a ese módulo y aplica las preferencias guardadas a la vista previa, impresión y reimpresión, sin mostrar controles de configuración. «Mi configuración de impresión» distingue:

1. **Formato de la etiqueta de bulto**: formato compartido del almacén, A5 o cualquier formato activo del catálogo. Los supervisores pueden agregar medidas al catálogo.
2. **Orientación de la etiqueta**: original, horizontal o vertical. Horizontal coloca la medida mayor como ancho en cualquier formato; vertical hace lo contrario.
3. **Papel cargado en la impresora**: rollo/papel del tamaño de la etiqueta, hoja A4/A5 vertical u horizontal, o medidas personalizadas. En hojas se configura un margen de 0 a 30 mm. Las medidas personalizadas y el margen se guardan juntos con «Aplicar medidas».

Ejemplo: etiqueta horizontal de **100 × 50 mm** en hoja **A4 de 210 × 297 mm**, con margen de 5 mm. La etiqueta sigue midiendo 100 × 50 mm. Cambiar a A4 no agranda ni reduce su diseño: únicamente cambia el tamaño de la página y la posición de la etiqueta dentro de ella. Se imprime **una etiqueta por hoja**, centrada horizontal y verticalmente por defecto, respetando el margen mínimo. El selector «Posición de la etiqueta en la hoja» permite elegir también la esquina superior izquierda. La vista previa sigue mostrando la etiqueta, no una etiqueta ampliada a toda la hoja.

Si la etiqueta no cabe con las medidas/orientación/margen elegidos, la configuración muestra un aviso. La impresión se rechaza **antes de registrar la auditoría**. No se reduce, recorta ni gira automáticamente para encajar. Por ejemplo, una etiqueta de 210 × 148 mm no cabe en A4 vertical con margen de 5 mm; se puede elegir A4 horizontal o un margen compatible.

La preferencia se guarda por cuenta autenticada y navegador. Se conserva la selección personal anterior al migrar el almacenamiento local a v2. Formato, orientación y hoja se comparten entre vista previa, impresión y reimpresión. No se modifican tablas, datos históricos ni TMS.

## Salida de impresión

En **rollo**, la página tiene las medidas exactas de la etiqueta. Zebra BrowserPrint recibe la imagen `^GFA` de la misma plantilla a los DPI configurados, sin una segunda composición de texto. Una térmica monocromática reproduce los colores en blanco y negro; conserva el contraste del logo. A5 de los formatos personales usa impresora/PDF.

Al elegir una **hoja**, se usa el diálogo de impresora/PDF incluso con BrowserPrint instalado. El `@page` recibe las medidas de la hoja, mientras el contenido conserva las medidas de etiqueta. En el controlador se debe elegir la misma hoja, **tamaño real / 100 %**, sin «ajustar a página», sin márgenes adicionales ni encabezados/pies. El navegador no puede detectar el papel físico ni impedir que el controlador aplique una escala; la capacidad de imprimir hasta el borde depende del dispositivo.

## Validación

- `node scripts/test-unified-package-labels.cjs`: datos originales/decimales, raster/ZPL, orientación de diversos formatos, hoja independiente, rechazo de tamaños incompatibles y preferencias antiguas.
- `node scripts/test-unified-package-labels-browser.cjs`: Chromium con API simulada. Igualdad de HTML y raster Zebra entre cuatro recorridos; cliente largo y descripción legibles; PDFs y dimensiones físicas de etiqueta/hoja; etiqueta 100 × 50 mm inalterada y centrada en A4, posición superior izquierda opcional; lote de dos etiquetas/dos hojas; orientación y persistencia por cuenta; rechazo de impresión incompatible sin auditoría; desplegables y móvil.
- `test-wms-isolation.mjs`, `test-wms-bootstrap.cjs`: aislamiento WMS y ciclo de recepción/permisos.
- TypeScript, lint de archivos modificados y build WMS; CI guarda capturas, PDF y ZPL.

El control global `check:guards` de la rama WMS presenta incidencias C55 previas en migraciones de recepción/picking. Este cambio no altera SQL; se verifica la base WMS independiente y su aislamiento. La Zebra se simula: la prueba no sustituye una impresión física en el almacén.

## Responsable de recepción

Encima de IPT y fecha se imprime **Responsable de recepción: Nombre Apellido**. Se usa el usuario original que generó el bulto, registrado por el servidor con `auth.uid()` en `wh_packages.created_by`. No se atribuye una reimpresión a quien la solicita después. El nombre completo se resuelve desde el perfil de ese usuario original; si no existe nombre disponible se muestra «No registrado», sin inventar un responsable.

La consulta `wh_package_label_responsibles` devuelve únicamente código de bulto y nombre/apellido. Exige sesión activa, los mismos permisos de lectura de bultos, sede autorizada y hasta 100 códigos por llamada. No cambia la RLS de perfiles ni expone correos. Recepción hidrata también las etiquetas pendientes con estos datos, igual que detalle, inventario y control de recepcionados. Se conservan las medidas, orientación y posición de impresión.

## QR complementario y cliente antes de imprimir

Las etiquetas de bulto y bulto agrupado mantienen Code 128 y agregan un QR con exactamente el mismo identificador, sin enlaces ni datos adicionales. El QR tiene cuatro módulos de margen y corrección M. Se genera localmente; vista previa, impresión/PDF y raster Zebra comparten el SVG. La fila de códigos reserva altura para conservar descripción, las cuatro líneas del agrupado y pie.

La consulta de clientes admite bultos pendientes de primera impresión: no depende de `label_print_count`. Resuelve el nombre por snapshot, lote, OT y validación manual, manteniendo sesión activa, permiso de etiquetado/supervisión, sede, exclusión de anulados y máximo de 100 claves. La migración pertenece únicamente a `wms-db`.

`test-wms-label-codes.cjs` decodifica QR y Code 128 con ZXing en Chromium, en ambas etiquetas y con identificadores actuales/antiguos, y verifica textos dentro del papel. `test-wms-bootstrap.cjs` comprueba el cliente antes de imprimir, la resolución por lote y las restricciones de acceso. La comprobación de impresión física sigue correspondiendo al almacén.

La consolidación en Picking vuelve a descargar automáticamente la hoja cuando el LPN recargado contiene más de cuatro combinaciones SKU/lote. Con cuatro o menos no se genera. El botón Contenido permite repetir la descarga. Una falla al descargar conserva el LPN y muestra cómo reintentar; no dispara impresión térmica ni altera los códigos existentes. La prueba de despacho en Chromium cubre consolidación sin hoja, A5, A4 y descarga manual posterior.
