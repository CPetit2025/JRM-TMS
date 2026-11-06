# Robot WMS: importación de ingresos para etiquetado

La tarea lee solo `C:\\WMS\\entrada.xlsx` y lo importa en la fuente exclusiva de recepción WMS, desde `/almacen/apt/etiquetado`. No lee ni modifica `C:\\WMS\\salida.xlsx` y no pasa por el Inventario multi‑almacén de TMS. Ese sigue usando el robot existente y sus archivos de `C:\\ERP`.

El Excel compartido contiene la hoja `Entrada ALM PT` y las columnas de IPT, fecha, producto, cantidad, lote, cliente y referencias. El libro no contiene conexiones de Excel; este robot detecta cambios en el archivo y sube la versión nueva. No obtiene datos nuevos desde ERP si otro proceso no actualiza el archivo.

## Instalar en Windows

Requisitos: PC Windows con acceso a `C:\\WMS`, Microsoft Edge y Node.js LTS. En PowerShell desde la carpeta del repositorio:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\\wms-auto\\ejecutar.ps1 -Instalar
```

Se pide una cuenta WMS con permiso de carga; la credencial queda cifrada con DPAPI en ese usuario y equipo. La instalación usa el preview WMS y bloquea Producción.

## Probar y operar

```powershell
& "$env:LOCALAPPDATA\\JRM-TMS\\wms-auto\\ejecutar.ps1" -Revisar
```

Esta revisión valida cuenta, acceso a la pantalla y lectura del archivo sin importarlo. Para importar ahora, ejecute el mismo comando sin `-Revisar`. Solo después de validar los registros en Recepción, programe la tarea diaria a la hora elegida:

```powershell
& "$env:LOCALAPPDATA\\JRM-TMS\\wms-auto\\ejecutar.ps1" -Programar -Hora 07:00
```

Si el archivo no cambió, el robot no lo vuelve a subir. Una nueva versión del mismo contenido es idempotente en la base WMS. La tarea no toca `salida.xlsx`; ese libro queda para la fase posterior de conciliación. Los logs se guardan en `%LOCALAPPDATA%\\JRM-TMS\\wms-auto\\logs`. La tarea corre una vez al día y requiere que la sesión de Windows esté iniciada. El archivo de salida no se lee ni modifica.
