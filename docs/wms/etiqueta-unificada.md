# Etiqueta única de bulto

Recepción (`/almacen/etiquetado`), Control de recepcionados, detalle del paquete e inventario usan `PackageLabel`: logo JRM, cliente en hasta dos líneas sin reducir fuente, OT, lote destacado a la derecha del SKU, descripción centrada, Code 128, código original, IPT, fecha, cantidad/peso y secuencia.

La referencia visual es la etiqueta de Recepción de 6 × 4 pulgadas. La cuadrícula se adapta al **tamaño de etiqueta**, manteniendo proporciones del logo y letras. `PackageLabelPreview` muestra esa misma composición. Primera impresión y reimpresiones recuperan los valores persistidos de `wh_packages`, sin recalcular pesos/cantidades ni sustituir la identidad del bulto.

## Configuración independiente de etiqueta y hoja

En Recepción y en **Configuración › Tamaños de etiqueta**, «Mi configuración de impresión» distingue:

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
