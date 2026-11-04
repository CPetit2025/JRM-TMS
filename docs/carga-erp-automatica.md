# Carga automática del ERP (Actualizable Despacho y Stock Bodega Despacho)

Hace solo lo que una persona hace cada día en **Almacén APT › Cargar datos del ERP** (`/apt/datos`), con los mismos
pasos y validaciones de la pantalla:

1. `refrescar.ps1`: abre cada Excel con Excel (oculto), **actualiza todo** (Power Query `Consulta1` →
   `DATAFLEX\FLEXLINE`, base `BDFLEXLINE`), comprueba que `Consulta1` trae filas y que `Fecha_Actualizacion` es de
   hoy, y guarda. Usa la credencial del origen de datos que Excel ya tiene guardada.
2. `cargar.mjs`: un robot con Microsoft Edge (sin ventana, `playwright-core`) entra al TMS con un usuario, abre
   `/apt/datos`, selecciona los dos archivos y pulsa **Aplicar carga y recalcular**. Espera el mensaje final (verde o
   de error). Cada intento queda además en el registro de cargas del ERP del TMS.
3. `ejecutar.ps1`: hace 1 y 2, guarda un log por ejecución y se programa en el Programador de tareas.

Los scripts están en `scripts/erp-auto/`.

## Requisitos

- PC con Windows en la red de JRM (llega a `DATAFLEX`), con Excel, Microsoft Edge y Node.js.
- Que en esa PC Excel ya actualice los dos libros a mano (**Datos › Actualizar todo**) sin pedir credenciales.
- Un usuario del TMS para el robot, con permiso de carga del ERP (`apt-carga`, Administrador o Jefe de Distribución) y
  de alta de OT desde el ERP. Conviene un usuario propio («carga ERP») para distinguir sus cargas en el registro.
- Los dos Excel en una carpeta fija (no en Descargas). Pueden estar abiertos: el robot copia los dos libros a
  `%LOCALAPPDATA%JRM-TMSerp-auto	rabajo`, refresca y sube esas copias, y no toca los originales.

## Instalar (una vez)

En PowerShell, desde la carpeta del repositorio:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\erp-auto\ejecutar.ps1 -Instalar -Actualizable "C:\ERP\Actualizable Despacho.xlsm" -Stock "C:\ERP\StockBodegaDespacho.xlsm" -Hora 07:00
```

Copia los scripts a `%LOCALAPPDATA%\JRM-TMS\erp-auto`, instala `playwright-core` y pide el usuario y la contraseña
del TMS. Se guardan cifrados con DPAPI: solo ese usuario de Windows, en ese equipo, puede leerlos. Además registra la
tarea **JRM-TMS carga ERP**: todos los días cada 3 horas desde la hora indicada, 5 veces (con 07:00: 07, 10, 13, 16 y 19 h).
No es cada hora porque cada carga ocupa la base de producción unos 13 minutos (subida, inventario y recálculos). Cada
ejecución tiene 55 minutos como máximo y no se superpone con la siguiente; volver a cargar el mismo día recalcula ese día sin duplicar. La tarea corre solo con la sesión de Windows
iniciada, porque Excel la necesita; si la PC estaba apagada, corre al encenderla.

Probar sin aplicar nada (refresca los Excel, entra al TMS y lee los archivos en la pantalla):

```powershell
& "$env:LOCALAPPDATA\JRM-TMS\erp-auto\ejecutar.ps1" -Revisar
```

Ejecutar la carga completa ahora: el mismo comando sin `-Revisar`, o **Ejecutar** sobre la tarea en el Programador de
tareas.

## Revisar

- Log de cada ejecución: `%LOCALAPPDATA%\JRM-TMS\erp-auto\logs` (se guardan las últimas 400). La línea `OK …` repite
  el mensaje verde de la pantalla; `ERROR …` dice en qué paso falló.
- Programador de tareas › **JRM-TMS carga ERP** › «Resultado de la última ejecución»: `0` = bien, `1` = falló.
- En el TMS: `/apt/erp` › Cargas.

## Fallas comunes

| Mensaje | Qué hacer |
|---|---|
| `Consulta1 no se actualizó` / quedó vacía | Abrir el Excel y actualizar a mano: si pide credenciales, volver a escribirlas en **Datos › Obtener datos › Configuración de origen de datos**. |
| `No se pudo iniciar sesión` | Cambió la contraseña del usuario del robot: repetir la instalación. |
| `el usuario no tiene permiso de carga del ERP` | Darle el permiso al usuario del robot. |
| `Lectura:` / `Carga:` | Es el mismo error que mostraría la pantalla; corregir y volver a ejecutar (la carga reanuda sin duplicar). |

Si cambian los textos de la pantalla `/apt/datos` (botón «Aplicar carga y recalcular», mensaje verde), hay que ajustar
`cargar.mjs`.
