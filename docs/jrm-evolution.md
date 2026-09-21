# Identidad, actualizaciones y JRM IA

## Preparación de base de datos

Aplicar en orden las migraciones `000170_app_versions_ai.sql`, `000171_homologate_products.sql`, `000172_site_scopes.sql` y `000173_ai_maintenance_actions.sql`. El proyecto de Supabase existente no tenía historial de migraciones; antes de `db push` se registraron como aplicadas las versiones antiguas hasta `000169` y `000191`, cuyas estructuras ya estaban presentes en producción. Revisar los roles y la asignación de sedes antes de habilitar JRM IA. La migración asigna los registros y usuarios de oficina existentes a `PRINCIPAL`; los usuarios nuevos de oficina reciben esa sede por defecto. Para añadir sedes reales hay que reasignar los datos y configurar `user_site_access` antes de dar acceso al personal. La tabla `dispatch_events` queda creada o protegida por la migración porque la pantalla de monitoreo ya la utiliza.

Las políticas RLS de las tablas operacionales principales comprueban sede y permiso de módulo. Las consultas de JRM IA usan el JWT de la persona autenticada; la clave de servicio solo escribe la auditoría. El catálogo de versiones publicado se puede leer sin sesión para ofrecer el APK en la pantalla de acceso.

## Configuración del servidor

Configurar `OPENAI_API_KEY` y `SUPABASE_SERVICE_ROLE_KEY` solo en el servidor de Next.js. `OPENAI_AI_MODEL` es opcional; por defecto se usa `gpt-4.1-mini`. El OCR usa `AI_PROVIDER=openai` y `OPENAI_OCR_MODEL=gpt-4o` por defecto. Si se utiliza Gemini para OCR, configurar `AI_PROVIDER=gemini`, `GEMINI_API_KEY` y opcionalmente `GEMINI_OCR_MODEL`. Ninguna clave de proveedor se guarda en el navegador. Al cargar la aplicación se eliminan las claves antiguas de la configuración local.

Las consultas IA requieren `ia:read:<ámbito>` y permiso de lectura del módulo. Los ámbitos son `distribucion`, `inventarios`, `mantenimiento`, `contratos` y `gerencia`. Preparar mantenimiento requiere `ia:action:mantenimiento` y permiso de escritura en `mantenimiento-ot`. El administrador conserva acceso completo. Antes de conceder permisos, comprobar que cada usuario tenga sus sedes correctas.

La función `reserve_ai_request` limita cada usuario a 5 consultas de copiloto por minuto y 50 por día, y 3 OCR por minuto y 30 por día. Cada consulta se audita con usuario, herramientas, contexto de pantalla, modelo, tokens y resultado; no se almacena el texto de la pregunta ni el contenido del comprobante. Las propuestas de mantenimiento caducan a los 30 minutos y una confirmación válida crea una sola OT.

## Iconografía

`npm run brand:assets` genera favicon, iconos web y recursos Android desde `public/jrm-logo-v2.png` sin estirar el logo. Antes de distribuir una versión definitiva conviene sustituir esa imagen de 228 × 218 px por el master vectorial corporativo y ejecutar el generador de nuevo. `public/jrm-tms.ico` sirve para un futuro empaquetado de Windows; actualmente JRM-TMS no tiene instalador Windows.

## Publicación Android

Mantener el mismo keystore de release en todas las versiones. Configurar `JRM_KEYSTORE_PATH`, `JRM_KEYSTORE_PASSWORD`, `JRM_KEY_ALIAS` y `JRM_KEY_PASSWORD` en el entorno de construcción. Configurar `JRM_ANDROID_VERSION_NAME` y `JRM_ANDROID_VERSION_CODE` con una versión y un número de build mayores que los publicados. Ejecutar `npm run build:apk`. El comando genera el APK y su SHA-256 en `artifacts/android/`, que está excluido de Git. Publicar el APK en una URL HTTPS inmutable y registrar una fila `app_versions` con `platform='android'`, `channel='stable'`, `status='published'`, `version`, `build_number`, `release_notes`, `installer_url` y `artifact_sha256`. Publicar la fila solo después de comprobar la descarga y la instalación en un dispositivo.

Las instalaciones anteriores hechas con un APK de depuración no comparten la firma release y requieren una reinstalación manual única. El instalador Android valida HTTPS, hash, paquete, firma y aumento de `versionCode`. Android solicita autorización para instalar desde JRM-TMS cuando sea necesaria. El paquete anterior `public/app-release.apk` era de depuración y se retiró de la descarga pública.

## Publicación web y políticas de actualización

Cada despliegue de Vercel expone su `VERCEL_GIT_COMMIT_SHA` como identificador del build; fuera de Vercel se puede definir `APP_BUILD_ID`. Registrar en `app_versions` una fila `platform='web'` publicada con `version`, `web_build_id`, fecha y notas. Actualizar `package.json` al iniciar una nueva versión semántica. Los usuarios reciben una insignia discreta al aparecer un build nuevo; el aviso opcional solo se abre al pulsarla. `mandatory=true` con `mandatory_after`, o un `minimum_supported_build` en Android / `minimum_supported_version` en web, activa un aviso que exige actualizar. La comprobación ocurre al abrir la sesión, al volver a la ventana y cada seis horas. Comprobar manualmente el regreso de una ruta activa antes de marcar una versión Android como obligatoria.

## Límites de la primera entrega

No se habilitó un service worker ni uso sin conexión. JRM-TMS sigue siendo web en Vercel dentro de un contenedor Capacitor Android. El peso realmente entregado no está estructurado de forma fiable, por lo que JRM IA no afirma toneladas despachadas. Inventarios consulta movimientos reales del kardex para detectar materiales sin movimiento durante 90 días. Los hitos de contratos y las etapas Fabricación → Despacho → Obra necesitan modelarse antes de ofrecer conclusiones automáticas. Las herramientas limitan el detalle devuelto y señalan cuándo una muestra está truncada.
