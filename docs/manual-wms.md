# Manual operativo WMS — versión candidata

## Acceso

Use el sitio independiente de WMS y su cuenta WMS. La cuenta debe estar activa y tener los permisos de almacén correspondientes. El inicio de sesión utiliza el proyecto Supabase de ese entorno; no comparte cuentas con el proyecto TMS. Solicite el alta inicial al administrador WMS. Recuperar contraseña envía un enlace del proyecto WMS; el administrador debe configurar las URL de retorno de su proyecto Auth.

## Importar ingresos

En «01 · Actualizar ingresos WMS», seleccione `entrada.xlsx` y pulse «Actualizar manualmente». La hoja debe llamarse `Entrada ALM PT`; se necesitan IPT, fecha, bodega, producto y cantidad positiva. El cliente se lee de la columna Z o de un encabezado equivalente. La importación es transaccional: una fila inválida rechaza el archivo completo y conserva los datos previos. El mensaje explica el error.

Un archivo ya cargado no duplica registros. El historial muestra las importaciones confirmadas; supervisión puede consultar los intentos aceptados, duplicados y rechazados en Auditoría. Si el fallo impide leer todas las filas, el número de registros rechazados se conserva como desconocido, no como un conteo inventado. Una caída de red puede impedir también registrar el intento: conserve el mensaje y avise a supervisión.

Un cambio de datos de un ingreso con etiquetas activas se rechaza para conciliación de supervisión. No se actualizan silenciosamente sus bultos ni códigos. Los cambios de un ingreso validado sin etiquetas requieren volver a validar su revisión vigente antes de generar LPN.

## Consultar y validar

En «02 · Recepción por IPT» la bandeja muestra ingresos sin etiqueta o pendientes de confirmar impresión y se actualiza cada 30 segundos. Puede buscar IPT, contrato, lote, cliente o producto. Los filtros de fecha y validación se aplican a los registros devueltos por la consulta (máximo 5000); no constituyen una consulta histórica sin límite.

Abra «Recibir». Cuando un IPT contiene varios productos, seleccione cada ítem en el modal. Verifique cliente, producto, cantidad ERP y peso. Registre la cantidad física real. Una diferencia o un cambio respecto del conteo anterior necesita un motivo. El ERP conserva su cantidad original. Un cliente que no esté en el Excel ni en los catálogos locales debe registrarse antes de validar.

## Distribuir y generar

La opción inicial es «Paquetes completos + saldo». Indique capacidad y número de paquetes completos; el saldo se calcula automáticamente. Para bultos diferentes use «Cantidades diferentes por bulto», separadas por coma o salto de línea; el separador decimal es punto.

Ejemplo: `100,100,100,100,100,100,100,100,75,25` conserva 900 unidades en diez bultos. El servidor exige cantidades positivas de hasta tres decimales y suma exacta del conteo validado. No se mezclan productos de distintas líneas. Pulse «Generar bultos y LPN». El servidor devuelve los registros persistidos; un reintento idéntico recupera los mismos códigos. Cambiar la distribución de etiquetas ya generadas se rechaza.

Los códigos anteriores se conservan. Los nuevos paquetes usan `LPN-YYYYMMDD-NNNNNN` con secuencia de base de datos y fecha de generación en Lima. No deben editarse ni reemplazarse al reimprimir.

## Imprimir y confirmar

Abra la vista previa o imprima el lote/etiqueta. El formato es 6 × 4 pulgadas en horizontal, equivalente al material 4 × 6 girado. Seleccione el tamaño real del material, escala 100 %, márgenes cero y sin encabezados/pies del navegador. El PDF automatizado verifica una página por etiqueta; no certifica la impresora física.

Después de imprimir, pulse «Confirmar impresión» solamente si las etiquetas salieron correctamente. Si canceló el diálogo o la impresora falló, pulse «Cancelar registro»: el ingreso sigue pendiente. Una pérdida de respuesta al confirmar puede reintentarse con el mismo identificador; no duplica el registro.

Browser Print/Zebra se habilita únicamente con verificación específica del dispositivo a 203 DPI y `NEXT_PUBLIC_WMS_ZEBRA_VERIFIED_DPI=203`. Si no está verificado, se usa el navegador. No se ha certificado una Zebra física en esta ejecución.

## Control y reimpresión

«03 · Control de recepción» consolida bultos por línea ingresada, conservando IPT y lote. «Ver detalle» muestra sus códigos, responsable, cantidades y reimpresiones. «Reimprimir» conserva el código, solicita motivo y registra la operación después de confirmarla.

## Auditoría y errores

Supervisión puede abrir «Auditoría de recepción»: consulta las últimas 200 operaciones autorizadas por RLS, identifica usuario, fecha y detalle. No modifica eventos. Para una discrepancia, conserve el IPT, LPN, nombre del archivo, mensaje y hora. No anule ni regenere etiquetas para resolver una incidencia de impresora.

## Robot Windows

El robot lee un archivo ya existente; no actualiza el Excel desde ERP. Se debe identificar y autorizar por separado el proceso que produce `C:\WMS\entrada.xlsx`. El robot sólo se instala en el equipo autorizado, con Edge, Node.js y una cuenta WMS con carga. Las credenciales quedan cifradas mediante DPAPI para ese usuario Windows. No instale ni programe el robot hasta validar el sitio WMS independiente y su cuenta. `salida.xlsx` queda fuera de esta fase.
