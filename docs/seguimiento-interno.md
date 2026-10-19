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
