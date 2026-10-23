# JRM IA — asistente y orquestador de soluciones

JRM IA (botón del robot, en todas las pantallas) responde dudas del sistema, consulta datos en vivo según los permisos
del usuario, cruza áreas para diagnosticar problemas y recomienda decisiones con evidencia. Nunca guarda nada sin que
el usuario presione **Confirmar**.

## Qué puede hacer

- **Dudas de uso del sistema**: «¿cómo reprogramo una solicitud observada?», «¿dónde cargo las entradas del ERP?»,
  «¿qué significa partida de transporte?», «¿por qué no me deja liquidar?». Busca en la documentación funcional y en el
  mapa de pantallas, y responde con pasos numerados y la ruta de la pantalla (las rutas se abren con un clic).
- **Datos en vivo**: solicitudes, despachos, incidencias, documentos, caja, contratos y partidas, tarifario, flota,
  mantenimiento (CMMS), repuestos, Eficiencia de Flota y Almacén APT, según los permisos IA del usuario.
- **Visión integral y prioridades**: «¿qué debo atender hoy?», «resumen ejecutivo», «¿qué riesgos hay?». Consulta en
  paralelo despachos, incidencias, solicitudes, partidas en riesgo, caja, cumplimiento documentario y flota.
- **Decisiones**: responde con Situación, Causas o hallazgos, Opciones (pros, contras e impacto), Recomendación,
  Próximos pasos (con la pantalla) y Supuestos y límites. Separa los datos del sistema de las recomendaciones generales
  (buenas prácticas de logística, mantenimiento y almacén).
- **Acciones con confirmación**: registrar o corregir gastos de OT, alta de OT, partida de transporte, estado de
  solicitudes, programar mantenimiento y reportes del viaje (conductores).
- **Preguntas de seguimiento**: al final de cada respuesta sugiere hasta 3 preguntas como botones.

## Análisis profundo

El interruptor **Análisis profundo** (debajo del chat) usa un modelo más capaz y más consultas cruzadas. Se activa solo
en preguntas de decisión o análisis (recomendar, priorizar, comparar, diagnosticar, informe, riesgo, plan…). Si el
modelo profundo no está disponible, responde con el estándar.

## Permisos

El acceso a datos se asigna por rol en *Administración → Roles y permisos*: permiso **IA** del área (distribución,
contratos, caja, mantenimiento, inventarios, gerencia) más el permiso del módulo. Sin ningún permiso IA el asistente no
está disponible. Con al menos uno, la ayuda del sistema funciona para todas las pantallas; cuando falta el permiso de un
área, JRM IA lo dice e indica cuál pedir.

## Configuración del servidor

Proveedor: Gemini (`GEMINI_API_KEY`) u OpenAI (`OPENAI_API_KEY`; `AI_PROVIDER=openai` para forzarlo). Modelos:
`GEMINI_AI_MODEL` (estándar, por defecto gemini-2.5-flash) y `GEMINI_AI_MODEL_DEEP` (profundo, por defecto
gemini-2.5-pro); en OpenAI, `OPENAI_AI_MODEL` (gpt-4.1-mini) y `OPENAI_AI_MODEL_DEEP` (gpt-4.1). La documentación de
`docs/` se incluye en la función del servidor (`outputFileTracingIncludes` en `next.config.ts`).
