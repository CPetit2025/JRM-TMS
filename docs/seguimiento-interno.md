# Planificación y Seguimiento de Transporte desde el TMS

El portal público (`/tracking/<enlace>`) se comparte con los clientes desde Torre de Control: enlace + código de 4
caracteres, con alcance de un cliente, OT específicas o toda la sede.

Los usuarios del TMS lo abren desde el menú lateral, debajo de **Inicio** → **Planificación y Seguimiento**
(`/seguimiento`), **sin código**: la sesión del TMS ya identifica a la persona.

- **Alcance**: toda la sede, para las sedes a las que el usuario tiene acceso (`can_access_site`); con más de una,
  se elige arriba y se recuerda en el navegador. Cuenta inactiva o sin sesión: sin acceso.
- **Mismo contenido** que ve el cliente: calendario y ruta del día con guías y Packing List, actualizado cada 15 s.
  En «personas viendo» aparece el nombre del usuario.
- **Cómo funciona**: cada sede tiene un enlace interno («Acceso interno del TMS (sin código)», visible en la lista de
  accesos de Torre de Control). Su código se guarda en `tracking_portal_internal`, que no es legible desde la web; la
  base (`get_internal_tracking_view`) y el servidor (documentos en `/api/tracking/documento`) lo usan sin enviarlo al
  navegador. Si alguien revoca ese enlace o cambia su código, se crea uno nuevo solo.
- Los clientes siguen entrando con su enlace y código.

Migración: `20261021020000_seguimiento_interno.sql`. Prueba: `caja_c123_seguimiento_interno.test.sql`.

## Personas conectadas y avisos de ingreso

La lista **Personas conectadas** reúne usuarios del TMS y visitantes que ingresaron con enlace y código.
Cada persona muestra su nombre, tipo de acceso y hora de ingreso en Lima. Los nombres públicos son
declarados por el visitante; las cuentas TMS se identifican desde su sesión autenticada. Dos personas con
el mismo nombre conservan identidades distintas.

- Los usuarios internos ven las presencias de su sede autorizada. Los visitantes ven al personal de esa
  sede y a otros visitantes con el mismo alcance de cliente y familia de OT; no ven visitantes de otros clientes.
- La consulta se actualiza cada 15 segundos. Una persona deja de aparecer después de 60 segundos sin
  actividad del portal. Actualizar la página o abrir otra pestaña no duplica al mismo usuario interno.
  Los accesos públicos del mismo navegador, enlace y nombre reutilizan su sesión; salir explícitamente la revoca.
- Cada ingreso real genera un aviso en la campana del responsable que creó el enlace público, siempre que
  conserve acceso a la sede. Los ingresos internos notifican a los responsables de enlaces públicos activos
  de esa sede, salvo al propio usuario. El enlace interno automático no convierte a su creador en responsable.
- Mientras un usuario consulta `/seguimiento`, también recibe un aviso breve de los nuevos ingresos de
  la sede. La primera carga no repite avisos anteriores y las pestañas coordinan los avisos para evitar duplicados.
- Las listas exponen identificadores de presentación independientes de las credenciales de sesión.
  El registro de ingresos y las credenciales no son tablas legibles desde el navegador.

Migración: `20261021090000_tracking_presence_scoped.sql`. Pruebas PostgreSQL C108, C123 y C128:
`node scripts/test-tracking-presence.cjs`. El arnés usa PostgreSQL aislado y un contenido operativo reducido;
valida las funciones reales de acceso, presencia y notificaciones, sin consultar producción.

## Informe de programación (PDF y correo)

En el **Registro de solicitudes** cada fila tiene una casilla; la del encabezado elige todas las mostradas. «Próxima
semana» marca los servicios con fecha programada de lunes a domingo de la semana siguiente (respeta los orígenes
ocultos). La selección se conserva al cambiar de mes, así una semana que cruza de mes se arma completa.

Con servicios elegidos aparecen:
- **Generar PDF**: A4 horizontal agrupado por fecha programada (salida de la ruta o, sin ruta, la atención solicitada),
  con solicitud, OT y componentes, cliente o proveedor, servicio, origen y destino, atención solicitada, ruta, unidad,
  conductor y estado.
- **Enviar por correo**: arma asunto y mensaje con el resumen por día; «Compartir» adjunta el PDF (Outlook, Correo,
  WhatsApp) y Outlook web, Gmail o el programa de correo abren el mensaje listo y descargan el PDF para adjuntarlo.

Funciona igual en `/seguimiento` y en el portal público de seguimiento.
