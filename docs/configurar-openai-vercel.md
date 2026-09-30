# Activar JRM IA en Vercel

El Copiloto (`/api/jrm-ai`) funciona con **Gemini** o con **OpenAI**: usa Gemini si existe `GEMINI_API_KEY` (modelo `GEMINI_AI_MODEL`, por defecto `gemini-2.5-flash`) y, si no, OpenAI con `OPENAI_API_KEY` (modelo `OPENAI_AI_MODEL`, por defecto `gpt-4.1-mini`). `AI_PROVIDER=openai` fuerza OpenAI aunque exista la clave de Gemini. El dictado por voz (`/api/jrm-ai/transcribe`) usa la misma prioridad. No hay que pegar claves en la pantalla de Configuración de JRM-TMS ni agregarlas al repositorio.

## Cobertura del Copiloto

Cada herramienta exige el permiso IA del ámbito (Roles y Permisos → JRM IA) y al menos un permiso del módulo; el Administrador las tiene todas. Los datos se leen con la sesión del usuario (RLS) y el Copiloto recuerda los últimos mensajes de la conversación.

| Ámbito IA | Herramientas |
| --- | --- |
| Contratos, solicitudes y tarifas | Estado y partida de OT, solicitudes (observadas, por aprobar, por vencer), cotización referencial con el tarifario |
| Distribución, despachos y documentos | Despachos pendientes/retrasados, búsqueda por número o placa (paradas, eventos, documentos, caja), incidencias, costos de flete, cumplimiento documentario (guías faltantes, SOAT/revisión, licencias) |
| Caja | Saldos de cajas, gastos por aprobar, anticipos por aprobar o vencidos, liquidaciones atrasadas |
| Mantenimiento / Inventarios / Gerencia | CMMS (KPI, alertas, disponibilidad de unidad), stock crítico, KPI operativos |
| Conductor (app) | Viaje activo y propuestas de reporte (retraso, incidencia, falla, gasto) que el conductor confirma |

## 1. Crear la clave

En [OpenAI Platform](https://platform.openai.com/api-keys), selecciona el proyecto que financiará JRM-TMS y crea una clave de API para ese proyecto. Guarda el valor en un gestor de secretos; OpenAI lo muestra completo al crearlo. No lo envíes por chat ni correo.

## 2. Configurar producción

1. Abre el proyecto [jrm-tms en Vercel](https://vercel.com/cpetit2025s-projects/jrm-tms) con una cuenta con permisos para cambiar sus variables.
2. Entra en **Settings → Environment Variables**.
3. Agrega `OPENAI_API_KEY` con el valor completo de la clave. Selecciona **Production** y, si la opción está disponible, marca la variable como **Sensitive**.
4. Comprueba que existan `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` para **Production**. La clave de servicio de Supabase y la de OpenAI son secretos de servidor: sus nombres nunca llevan el prefijo `NEXT_PUBLIC_`.
5. Guarda. Para probar en ramas de vista previa, configura también las variables necesarias en **Preview**; puedes usar una clave distinta de OpenAI para ese entorno.
6. Abre **Deployments**, busca el último despliegue de **Production** y usa el menú **… → Redeploy**. Los cambios de variables solo se aplican a un despliegue nuevo.

`OPENAI_AI_MODEL=gpt-4.1-mini`, `AI_PROVIDER=openai` y `OPENAI_OCR_MODEL=gpt-4o` son opcionales: esos son los valores por defecto del código. Comprueba que la clave tenga acceso a los modelos elegidos.

## 3. Verificar

1. Espera a que el despliegue de Vercel quede en estado **Ready** y abre [JRM-TMS](https://jrm-tms.vercel.app/).
2. Entra con un administrador activo y abre el botón **JRM IA**. El mensaje «pendiente de configurar» debe desaparecer. Un usuario sin permiso de IA no verá el botón.
3. Haz una consulta breve, por ejemplo «¿Qué despachos están pendientes?», y comprueba que responda. Si hay un error, revisa **Runtime Logs** de la función `/api/jrm-ai` en Vercel. La respuesta `enabled: false` de `GET /api/jrm-ai` también puede indicar que el usuario no tiene rol, permiso o sede asignada.

No uses la página pública `/api/app-version` para comprobar la clave: ese endpoint solo comprueba el catálogo de actualizaciones.

## Desarrollo local

Si ya existe `.env.local`, agrega allí solo las variables que falten. Para crear uno nuevo, usa `.env.example` como plantilla. Ejecuta `npm run check:ai-config`; el comando solo informa qué nombres están presentes, sin imprimir secretos ni llamar a OpenAI. Luego ejecuta `npm run dev`.

## Si los cambios de código no aparecen

Comprueba en **Deployments** que el último despliegue de Production corresponda a la rama `master` de `CPetit2025/JRM-TMS` y esté **Ready**. Si el dominio aún apunta a una versión anterior, revisa el dominio asignado al despliegue y vuelve a desplegar el commit de producción. Después, recarga el navegador sin caché.
