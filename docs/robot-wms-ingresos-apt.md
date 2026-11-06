# Robot WMS para actualizar ingresos APT

El robot WMS automatiza solo el libro de **Entradas APT** que alimenta la recepción por IPT. Copia el Excel a una carpeta de trabajo, ejecuta `RefreshAll` si el libro tiene conexiones, valida `Consulta1`, `Nro_Documento` y `Fecha_Actualizacion`, entra al preview WMS y usa la misma pantalla y validaciones de **Actualizar APT**. No modifica el Excel original ni la carga automática del TMS.

El `entrada.xlsx` compartido tiene la hoja `Entrada ALM PT`, tabla `Consulta1` y `Fecha_Actualizacion`, pero no incluye conexiones de Excel. En ese formato el robot verifica la fecha del actualizable; no puede regenerar información nueva que no venga en el archivo. Si el ERP entrega luego un libro con consulta conectada, `RefreshAll` se ejecuta sobre la copia antes de la validación. Los libros con más de 30 horas desde `Fecha_Actualizacion` se rechazan sin subirlos.

La pantalla reemplaza idempotentemente los movimientos del rango de fechas importado. Repetir una carga de la misma versión no crea IPT duplicados. Solo se manda un archivo de entradas; el robot no sube el Stock Bodega Despacho ni el Actualizable de TMS.

## Instalar en la PC que recibe el Excel

Requisitos: Windows, Excel de escritorio, Microsoft Edge, Node.js LTS y una cuenta del WMS aprobada con permiso de actualizar APT. La PC debe mantener iniciada la sesión de Windows cuando se ejecute el robot.

Descargue el repositorio/branch de preview y abra PowerShell en su carpeta. Instale indicando la ruta del archivo fuente:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\wms-auto\ejecutar.ps1 -Instalar -Entrada "C:\Users\cpetit\Downloads\entrada.xlsx"
```

El asistente pide la cuenta WMS y la cifra con DPAPI para ese usuario de Windows. No se suben ni guardan contraseñas en GitHub o Vercel. El destino queda limitado al preview de `feature/warehouse-wms-portal`.

## Prueba previa sin aplicar cambios

```powershell
& "$env:LOCALAPPDATA\JRM-TMS\wms-auto\ejecutar.ps1" -Revisar
```

Debe registrar `Revisión OK: login y lectura correctos; no se aplicó la carga.`. Si falla, revisar el log en `%LOCALAPPDATA%\JRM-TMS\wms-auto\logs` y corregir acceso/credencial o el Excel antes de ejecutar una carga real.

## Carga manual de validación y programación

Después de una revisión correcta, la ejecución manual aplica el actualizable al proyecto de staging configurado:

```powershell
& "$env:LOCALAPPDATA\JRM-TMS\wms-auto\ejecutar.ps1"
```

Solo después de validar el resultado en **WMS › Recepción**, active la tarea cada 3 horas desde las 07:00:

```powershell
& "$env:LOCALAPPDATA\JRM-TMS\wms-auto\ejecutar.ps1" -Programar -Hora 07:00
```

La tarea se llama **JRM WMS ingresos APT**, corre cinco veces entre 07:00 y 19:00, exige una sesión de Windows iniciada y no se superpone. Los logs se conservan en la carpeta indicada. La carga puede reiniciarse desde la pantalla porque el servidor ya registra y valida los rangos.

## Operación y fallos

- El exit code `0` y línea `OK …` confirman la carga; `ERROR …` identifica el paso fallido.
- `Actualizable APT vencido`: actualizar primero el archivo de origen. El robot no sube una copia antigua.
- `No aparece la carga`: confirmar cuenta aprobada y permiso de carga APT en WMS.
- `No se pudo iniciar sesión`: reejecutar la instalación para guardar la contraseña actualizada.
- Los avisos `Permissions-Policy` del navegador no son fallos del robot; la respuesta de autenticación y el resultado de la carga sí lo son.

El robot sigue apuntando al preview mientras se realizan las pruebas. No despliega a producción, no migra Supabase y no programa cargas hasta ejecutar explícitamente `-Programar` en la computadora de operación.
