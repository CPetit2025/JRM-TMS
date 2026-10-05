# Confirmación APT y límites de tiempo

La carga se envía en lotes de 250 filas, conservando la clave de idempotencia `(upload_id, kind, row_no)`. La aplicación del reemplazo y los recálculos usan exclusivamente `/api/apt/procesar`. Un error de red, ruta inexistente o configuración incompleta no repite el reemplazo desde el navegador, cuyo rol tiene un límite de consulta menor.

La función del servidor dispone de 180 segundos por etapa, con margen para el `statement_timeout=120s` del rol de servicio ya configurado en la migración C22. No se aumenta el límite del rol del navegador.

Si la respuesta de aplicación se pierde, el cliente consulta el estado de la carga. Si está APLICADA, continúa con los modelos. Si falla la estadía o el flujo, informa **Carga aplicada; recálculo pendiente**, conserva el resumen y permite **Reintentar recálculo** sin enviar filas ni volver a reemplazar movimientos.

La nueva migración añade estadísticas de las tablas temporales del FIFO y un índice para las salidas. Modifica solo esos puntos de la función instalada, conserva reglas y permisos, y aborta si la definición no tiene los puntos esperados. No ejecuta una reconstrucción sobre producción durante la migración.

Validación reproducible:

- `node scripts/test-apt-upload.cjs`: 6 casos de aplicación, fallos de red/configuración, respuesta perdida, timeouts del recálculo y reintento sin reemplazo.
- `node scripts/test-apt-fifo.cjs`: Docker/PostgreSQL aislado, 64.000 movimientos, comparación exacta de capas, asignaciones y clasificación antes/después; permisos preservados; migración repetible y reconstrucción bajo 8 segundos en el arnés. El conjunto es sintético y no reproduce la distribución ni la concurrencia de producción.
- `caja_c41_apt_fifo_plan.test.sql`: verifica instalación de la optimización en las pruebas de despliegue. Las pruebas existentes de APT comprueban las reglas de negocio.

La compilación local completa requiere las variables Supabase existentes en Vercel; no se sustituyen por valores ficticios. Antes de publicar se verifica CI/Vercel y el resultado real del paso SQL de producción.
