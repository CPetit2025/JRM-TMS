# Conductores conectados en Monitoreo GPS

`/monitoreo` consulta presencia del app y estado operativo por separado. El app registra una señal autenticada cada 15 segundos, con o sin ruta y aunque no disponga de GPS. La identidad se obtiene de `auth.uid()` y de un conductor/perfil activos; el cliente no envía conductor, placa ni estado de ruta.

«App conectada» significa señal recibida en 90 segundos. Cerrar sesión registra desconexión; una sesión guardada o una ubicación antigua no acredita conexión. El app en segundo plano puede suspender los temporizadores: el monitor muestra la falta de señal, sin prometer presencia permanente. Los puntos del rastreador de ruta también actualizan presencia cuando los sube el conductor autenticado.

Se muestran conductores con conexión en las últimas 24 horas o un servicio abierto, con acceso limitado a la sede del observador. Sin ruta se usa el acceso de sede del perfil; no se inventa una unidad asignada. Monitoreo/Torre de Control y administradores activos pueden consultar; otros conductores, roles sin permiso y usuarios anónimos no consultan la flota ni escriben presencia ajena.

Estados: Sin ruta; Con ruta esperando Packing List; Con ruta listo para salir; En ruta; En destino esperando guía; Guía en validación; Guía observada/rechazada; Esperando autorización de retorno; Retorno; En base/Entregado pendiente de cierre. Se derivan de programación, documentos confirmados, llegada explícita y conformidad del supervisor. Ni velocidad cero ni GPS se usan para inferir entrega o aprobación.

El mapa incluye ubicaciones reales, señala precisión y fecha, y usa gris cuando el GPS supera dos minutos o está denegado/no disponible. Un conductor sin coordenadas permanece en la lista. La velocidad desconocida se muestra sin dato. Ubicaciones fuera de ruta no ingresan en `route_track_points` ni alteran kilómetros; los puntos tardíos no desplazan la última ubicación hacia atrás. Los filtros de la lista y del mapa se aplican juntos.

El APK carga la web publicada, así que no requiere reinstalación. El conductor debe abrir el app con sesión válida y conceder GPS para aparecer también en el mapa; sin permiso aparece en la lista.

Validación: migración completa en PostgreSQL aislado, punto real con cálculo de distancia, identidad/rol/sede, conexión sin ruta/GPS, desconexión y vencimiento, estados documentarios y bloqueo de avance sin guía aprobada; C47 contra base real con rollback. `test-driver-presence.cjs` cubre el reportero y el GPSGuard montado, desconexión de red, limpieza, GPS no válido, señal antigua y velocidad desconocida. Revisión responsive con Supabase sintético, sin usuarios de producción.
