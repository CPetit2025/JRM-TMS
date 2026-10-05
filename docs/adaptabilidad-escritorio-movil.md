# Revisión de adaptabilidad: escritorio y móvil

## Alcance y problemas corregidos

Se revisaron la estructura del panel web, navegación, notificaciones, ventanas compartidas, Reportes y Analítica, formularios mensuales, Contratos, tarifario y estructura del portal operativo.

- **Encabezado móvil:** con una actualización disponible y un correo largo, el título tenía ancho cero entre 320 y 390 px. El aviso interceptaba el botón del menú. Se compactaron los controles y se reservó espacio para el título; el perfil continúa accesible mediante su icono.
- **Notificaciones y actualizaciones:** el panel de notificaciones comenzaba entre 105 y 175 px fuera del borde izquierdo en móvil. Los paneles usan los bordes del viewport en móvil y siguen anclados a su botón en escritorio, con altura máxima y desplazamiento interno.
- **Contenido común:** márgenes graduados de móvil a escritorio, contenedores flexibles con ancho mínimo cero y altura dinámica del viewport. Se permite acceder al contenido ancho sin recortarlo.
- **Menú:** enlaces y favoritos accesibles por toque; controles principales de 44 px en móvil. El panel cerrado queda fuera del recorrido de foco; el menú fijado de escritorio conserva su distribución.
- **Analítica:** filtros con ancho limitado, campos de 16 px en móvil, acciones que pueden pasar a otra línea, nombres largos de vistas que se ajustan y tarjetas distribuidas en menos columnas antes de pantallas grandes. La tabla conserva todas sus columnas mediante desplazamiento interno y puede recibir foco. El detalle admite referencias extensas sin ensanchar la página.
- **Contratos:** acciones superiores que pasan a otra línea y tabla con ancho legible y desplazamiento horizontal, en lugar de ocultar su contenido.
- **Tarifario:** formularios de una columna en móvil, dos o tres en pantallas intermedias y cuatro donde hay espacio.
- **Ventanas y portal operativo:** modales con altura dinámica, título flexible, cierre de 44 px y contenido desplazable; cabecera del conductor con nombre largo sin desplazar el cierre de sesión. El espacio inferior incorpora el área segura del dispositivo. El copiloto usa altura dinámica y su campo de texto puede reducirse.

## Validación visual

Chromium real, mediante Playwright, renderizando componentes de la aplicación con su CSS de Tailwind. Se sustituyeron autenticación, consultas, rutas y servicios externos; los registros eran sintéticos, con nombres y referencias largas, importes grandes y 51 filas. No se usaron credenciales ni datos de producción.

| Vista | Tamaños (ancho × alto, px) | Resultado |
| --- | --- | --- |
| Panel web y analítica | 320×800, 360×800, 390×800, 640×800, 768×800, 820×800, 1024×800, 1280×800, 1440×900, 1920×1080 | 10 escenarios pasan |
| Horizontal y altura reducida | 844×390, 390×500 | 2 escenarios pasan |
| Cabecera y navegación operativa | 320×800, 390×800, 768×800, 1440×800 | 4 escenarios pasan |

Se verificaron límites del encabezado y paneles, apertura/cierre del menú, acceso al perfil, posición de campos, desplazamiento de la tabla, apertura del sustento, referencias largas, límites del modal y acceso a su última acción. El encabezado y el contenido analítico no tuvieron desbordamiento horizontal en estos escenarios.

Contratos, tarifario, los formularios mensuales y el copiloto también se revisaron en código; sus flujos autenticados completos no se ejecutaron en esta prueba visual. No se probó Safari/iOS, teclado nativo, zoom del navegador, APK ni dispositivos físicos. La altura reducida simula menos espacio disponible, no un teclado real. No se afirma que cada pantalla del sistema haya sido comprobada de extremo a extremo.
