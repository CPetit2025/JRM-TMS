# Sesión y acceso biométrico en el APK

La app usa la sesión persistente de Supabase y renueva sus tokens. Abrir `/app/login` con una sesión válida redirige al inicio del conductor o a Actividades, verificando antes que el perfil y, cuando corresponde, el conductor estén activos. Las cookies renovadas también se devuelven en las redirecciones. Una sesión revocada o una cuenta desactivada no se recupera por biometría.

## Activación

Instalar el APK Android 1.0.5 (build 6) mediante el aviso de actualización o la descarga del login. Iniciar sesión y pulsar **Activar** junto a la opción biométrica de la cabecera del Portal Operativo. Android solicita una huella o rostro de seguridad fuerte ya registrado en el teléfono. Los navegadores y APK anteriores mantienen la sesión habitual y no presentan una opción biométrica incompatible.

Se guarda únicamente la preferencia de bloqueo en almacenamiento privado de Android. El plugin no recibe ni almacena contraseñas, PIN ni tokens. El desbloqueo es local: no reemplaza la autenticación ni los permisos de Supabase.

Al abandonar la app, el WebView se oculta y una pantalla nativa impide ver el contenido hasta autenticarse. El seguimiento GPS de un viaje continúa en su servicio. Android impide capturas de pantalla y vistas previas del contenido de este APK. Android 11+ admite la credencial del teléfono como recuperación; versiones anteriores usan biometría fuerte. Cancelar o fallar mantiene la pantalla bloqueada.

Para volver a ingresar con contraseña se ofrece **Cerrar sesión e ingresar con contraseña** en la pantalla bloqueada, con aviso de que detendrá el GPS. Se limpia la sesión local y se reinicia la app. El cierre de sesión del portal desactiva la preferencia biométrica de ese dispositivo. La desactivación voluntaria desde la cabecera exige verificación de Android.

## Validación

`node scripts/test-app-session.cjs`: seis pruebas del proxy con renovación/eliminación de cookies, restauración por tipo de perfil, cuentas inactivas y conductores desvinculados.

En CI, `assembleDebug testDebugUnitTest` compila el plugin real y ejecuta pruebas Robolectric sobre la actividad: ocultación antes de autenticarse, imposibilidad de quitar el bloqueo mientras está activo, pantalla accesible sin activación, protección de capturas y bloqueo al pasar a segundo plano.

La publicación firmada usa el workflow Android existente con las credenciales de CI. Su script verifica firma, identidad, versión y SHA-256 de la descarga antes de registrar el APK publicado.

El arnés simula el servicio Chromium de service workers, que Robolectric no implementa, y la versión instalada del WebView; ejecuta la actividad y el bloqueo reales.

La autenticación con hardware real requiere comprobar en un teléfono: activación, cierre/apertura y reinicio del proceso; huella correcta/incorrecta y cancelación; bloqueo al regresar de segundo plano; recuperación con credencial o contraseña; continuidad del GPS durante el bloqueo; y cierre de sesión. Robolectric y la compilación no sustituyen esta comprobación física.
