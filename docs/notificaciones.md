# Notificaciones por rol

Cada aviso del panel web llega solo a quien tiene permiso sobre el módulo, configurado en **Roles y Permisos**. Por
ejemplo, lo de Transporte va a los roles con `solicitudes` y lo de Caja a los roles con `caja-aprobacion`. Los
administradores ven todo. Migración: `20261004120000_notificaciones_por_rol.sql`.

## Cómo funciona

- **Eventos.** Disparadores en las tablas del negocio crean el aviso en `notifications` (solicitudes, despachos,
  anticipos, gastos, fallas y OT). Un error en el aviso nunca bloquea la operación que lo originó.
- **Avisos por tiempo.** Los de vencimientos y atrasos se generan cuando se abre la campana, como máximo cada 10 minutos
  (`notif_refresh`). Cubren despachos atrasados, documentos pendientes y SOAT, revisión técnica y licencias que vencen en
  15 días o menos.
- **Sin duplicados.** Cada aviso tiene una clave única.
- **Retención.** Los avisos se borran a los 90 días. La campana muestra los últimos 30 días.
- **Visibilidad.** La define `notif_can_see`. Un permiso cuenta tanto en lectura como en escritura. Un aviso con
  `al_solicitante` también llega a quien creó la solicitud.
- **Tiempo real.** Llega por realtime y está filtrado por RLS. Los avisos críticos y de atención muestran un toast con sonido.

## Reglas (`notif_reglas`)

La tabla es editable: cambiar `permisos`, `severidad` o `activo` de un evento cambia a quién llega, sin tocar código.

| Evento | Categoría | Severidad | Permisos | Al solicitante |
|---|---|---|---|---|
| SOLICITUD_NUEVA | Transporte | info | solicitudes, despacho-aprobacion | |
| SOLICITUD_POR_APROBAR | Transporte | warn | despacho-aprobacion | |
| SOLICITUD_OBSERVADA | Transporte | warn | solicitudes | Sí |
| SOLICITUD_APROBADA | Transporte | info | despacho | Sí |
| SOLICITUD_RECHAZADA | Transporte | info | solicitudes | Sí |
| SOLICITUD_REPROGRAMADA | Transporte | info | solicitudes, despacho | Sí |
| DESPACHO_PROGRAMADO | Despacho | info | despacho, torre-control | |
| DESPACHO_EN_RUTA | Despacho | info | torre-control, monitoreo | |
| DESPACHO_ESPERA | Despacho | warn | despacho, torre-control | |
| DESPACHO_ENTREGADO | Despacho | info | despacho, solicitudes, documentario | |
| DESPACHO_CANCELADO | Despacho | warn | despacho, solicitudes, torre-control | |
| DESPACHO_ATRASADO | Despacho | crit | despacho, torre-control, solicitudes | |
| DOCUMENTOS_PENDIENTES | Despacho | warn | documentario, despacho | |
| ANTICIPO_SOLICITADO | Caja | warn | caja-anticipos, caja-aprobacion | |
| GASTO_POR_APROBAR | Caja | warn | caja-aprobacion | |
| GASTO_OBSERVADO | Caja | info | caja-gastos, caja-aprobacion | |
| FALLA_CRITICA | Mantenimiento | crit | mantenimiento-fallas, mantenimiento-ot, mantenimiento-dashboard | |
| FALLA_REPORTADA | Mantenimiento | info | mantenimiento-fallas | |
| OT_CERRADA | Mantenimiento | info | mantenimiento-ot, despacho, flota | |
| SOAT_VENCE | Cumplimiento | warn | mantenimiento-flota, mantenimiento-vencimientos, flota | |
| REVISION_TECNICA_VENCE | Cumplimiento | warn | mantenimiento-flota, mantenimiento-vencimientos, flota | |
| LICENCIA_VENCE | Cumplimiento | warn | flota, maestros-trabajadores, despacho | |

## En pantalla

- **Campana** (`NotificationBell`):
  - número de avisos sin leer y pestañas por categoría;
  - enlace **Ver →**, que abre la pantalla del aviso y lo marca como leído;
  - **Marcar leídas**;
  - preferencias para silenciar una categoría (`notif_prefs`, por usuario).
- **Franja roja** bajo el encabezado (`NotificationBanner`): hasta 3 avisos críticos sin leer de tus módulos.
- **App del conductor**: sin cambios. Sigue con sus avisos de ruta y anticipos.

## RPC

| Función | Uso |
|---|---|
| `notif_list(p_categoria, p_limit)` | Avisos visibles, sin leer por categoría y categorías silenciadas |
| `notif_mark_read(p_ids)` | Marca como leídos; con `NULL` marca todos |
| `notif_set_pref(p_categoria, p_silenciada)` | Silencia o reactiva una categoría |

## Pruebas

`supabase/tests/caja_c29_notificaciones_por_rol.test.sql` comprueba:

- el permiso por rol: despacho frente a caja, y el aviso al solicitante;
- silenciar una categoría;
- marcar como leído;
- la ausencia de duplicados;
- el disparador de solicitudes;
- que los disparadores existen en las tablas presentes.
