# Robot WMS: actualización de ingresos para etiquetado

Hace lo mismo que el robot del ERP del TMS (`scripts/erp-auto`, ver `docs/carga-erp-automatica.md`), pero para el
WMS y con otra frecuencia:

1. `refrescar.ps1` (copia del TMS): abre una copia de `C:\WMS\entrada.xlsx` con Excel oculto, actualiza **solo la
   conexión `Consulta - Consulta1`** en primer plano (Power Query sobre `despacho.usp_Rpt_EntradasBodegaListado`, hoja
   `Entrada ALM PT`; «Actualizar todo» no la dejaba al día y `Consulta2`, de salidas, no se usa), comprueba que trae
   filas y que `Fecha_Actualizacion` es de ahora, y guarda. Usa la credencial del origen de datos que Excel ya tiene guardada. El original no se toca.
2. `cargar-entrada.mjs`: Microsoft Edge sin ventana entra al WMS, abre `/almacen/apt/etiquetado`, selecciona la copia
   y pulsa **Importar Excel seleccionado** (botón `#wms-receipt-import`). Espera el mensaje verde o el de error.
3. `robot.mjs`: pregunta a la base WMS si toca actualizar y luego informa el resultado (tabla `wh_receipt_robot_runs`).
4. `ejecutar.ps1`: une todo, guarda un log por ejecución y se registra en el Programador de tareas.

No lee ni modifica `C:\WMS\salida.xlsx` ni el Inventario multi‑almacén del TMS.

## Cuándo actualiza

- **Cada 30 minutos**, automáticamente.
- **Al pulsar «Actualizar ahora»** en `/almacen/apt/etiquetado`: la página deja una solicitud en la base y el robot la
  toma en el minuto siguiente. Mientras hay una en curso el botón queda deshabilitado y muestra su estado.

La tarea **JRM WMS ingresos para etiquetas** corre cada minuto, pero solo consulta a la base si toca
(`wh_receipt_robot_due`, sin iniciar sesión); la base decide cuándo, así nunca corren dos a la vez. Una ejecución sin
resultado en 30 minutos se marca con error (PC apagada o ejecución cortada). La página muestra las últimas
ejecuciones, la última correcta y la próxima automática.

## Requisitos

- PC Windows con `C:\WMS\entrada.xlsx`, Excel, Microsoft Edge y Node.js LTS, en la red de JRM (llega al ERP).
- Que en esa PC Excel ya actualice el libro a mano (**Datos › Actualizar todo**) sin pedir credenciales.
- Una cuenta del WMS con permiso `almacen-carga` (o Administrador). Conviene una cuenta propia para el robot.
- La sesión de Windows iniciada: Excel la necesita.

## Instalar (una vez)

En PowerShell, desde la carpeta del repositorio (rama del WMS):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\wms-auto\ejecutar.ps1 -Instalar -SupabaseUrl https://<ref>.supabase.co -SupabaseAnon <clave pública anon>
```

`-SupabaseUrl` y `-SupabaseAnon` son la URL y la clave pública de la base WMS (las mismas `NEXT_PUBLIC_SUPABASE_*` del
proyecto Vercel `jrm-wms`); la base del TMS se rechaza. `-Url` es `https://wms.jrmlogistica.app` por defecto y solo
admite sitios WMS. Copia los scripts a `%LOCALAPPDATA%\JRM-TMS\wms-auto`, instala `playwright-core`, pide la cuenta WMS
(queda cifrada con DPAPI: solo ese usuario de Windows en ese equipo la lee) y registra la tarea.

Probar sin importar (actualiza la copia del Excel, entra al WMS y selecciona el archivo):

```powershell
& "$env:LOCALAPPDATA\JRM-TMS\wms-auto\ejecutar.ps1" -Revisar
```

## Revisar

- En el WMS: `/almacen/apt/etiquetado` › **Actualización automática**.
- Logs de cada ejecución: `%LOCALAPPDATA%\JRM-TMS\wms-auto\logs` (las últimas 400). Si falla la consulta de cada minuto
  (sin red, cuenta), queda en `logs\ciclo-errores.log`.
- Programador de tareas › **JRM WMS ingresos para etiquetas**.

## Fallas comunes

| Mensaje | Qué hacer |
|---|---|
| `Consulta1 no se actualizó` / quedó vacía | Abrir el Excel y actualizar a mano; si pide credenciales, volver a escribirlas en **Datos › Obtener datos › Configuración de origen de datos**. |
| `No se pudo iniciar sesión WMS` | Cambió la contraseña de la cuenta del robot: repetir la instalación. |
| `Sin permiso para actualizar ingresos WMS` | Dar el permiso `almacen-carga` a la cuenta del robot. |
| «El robot no informó el resultado en 30 minutos» | La PC estaba apagada, sin sesión o se cortó: revisar el log de esa hora. |

Si cambia la pantalla `/almacen/apt/etiquetado` (botón `#wms-receipt-import`, mensaje verde), hay que ajustar
`cargar-entrada.mjs`.
