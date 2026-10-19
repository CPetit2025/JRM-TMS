# Control de horas extras — piloto JRM TMS

Acceso: **Control de Horas Extras** en el menú o /hhee.

## Activación

Un administrador configura /hhee/configuracion:

1. Revisar áreas y sedes. Las áreas iniciales se crean únicamente en la sede PRINCIPAL.
2. Registrar el directorio de trabajadores manualmente o con el Excel de directorio. El código del trabajador es único. El costo por HHEE es opcional y **solo estimativo**; no es su remuneración básica.
3. En /permisos, asignar los permisos HHEE a los roles apropiados.
4. Vincular cada usuario con sus áreas en Configuración HHEE, además de su acceso existente a las sedes.
5. Definir la ventana de recurrencia y los destinatarios del informe. El día/hora son una referencia para el corte semanal; **el envío es manual**, mediante el correo corporativo.

No se otorgan permisos a roles existentes automáticamente. No se crean ejecuciones ni costos de demostración.

| Perfil | Permisos sugeridos | Alcance |
| --- | --- | --- |
| Solicitante | hhee-solicitar:write | Áreas asignadas |
| Jefe del área | hhee-aprobar:write | Áreas asignadas |
| RR. HH. | hhee-validar:write | Áreas asignadas; asistencia y costos individuales |
| Gerencia | hhee-gerencia:read, hhee-excepciones:write | Sedes autorizadas; costos agregados |
| Consulta de área | hhee:read | Áreas asignadas |
| Configuración | hhee-config:write | Sedes autorizadas; directorio y accesos |
| Consulta de costo individual | hhee-costos:read | Áreas asignadas; solo para personal autorizado |

Los permisos :read de solicitar/aprobar/validar permiten consultar, no ejecutar la operación.

## Flujo

1. Crear solicitud con área, causa propuesta, fecha, justificación, alternativas, resultado esperado y trabajadores. OT/OC/OS/RQ/mantenimiento son referencias opcionales; una OT ingresada se valida contra la sede.
2. Revisar borrador y **presentar al jefe del área**.
3. Otro jefe autorizado aprueba o rechaza con motivo y minutos aprobados por trabajador. No se admite aprobación propia desde la interfaz. El registro técnico de una excepción administrativa exige sustento y revisión de Gerencia.
4. Registrar el resultado operativo, evidencia referenciada y avance cuantitativo cuando haya una meta.
5. RR. HH. descarga la plantilla, importa su Excel y revisa la vista previa. Se comprueba **todo el archivo** antes de aplicarlo: trabajador incluido, solicitud presentada, versiones, duplicados, intervalos y alcance.
6. RR. HH. confirma causa y necesidad y valida la ejecución. Se exige asistencia de todos los trabajadores incluidos y un resultado documentado.
7. Gerencia revisa las excepciones sin borrar ni reducir el registro de horas trabajadas.
8. El jefe/RR. HH. define medidas correctivas y un responsable con acceso al área. Otro responsable autorizado verifica su efectividad.

Una modificación posterior a la validación requiere **reapertura de RR. HH. con motivo**, corrección del Excel y nueva validación. El historial conserva los valores anteriores de forma privada.

## Excel de RR. HH.

Primera hoja; entre 1 y 500 filas; máximo 10 MB. Formatos XLS/XLSX, incluidos libros con calendario 1904.

| Columna | Contenido |
| --- | --- |
| SOLICITUD | Código de la solicitud, por ejemplo HE-000001 |
| CODIGO_TRABAJADOR | Código del directorio HHEE |
| INICIO / FIN | Intervalo efectivo de HHEE, fechas Excel o AAAA-MM-DD HH:mm, hora de Lima |
| DESCANSO_MIN | Minutos enteros, descontados del intervalo |
| HORAS_RECONOCIDAS | Horas reconocidas por RR. HH., opcional; no puede superar las trabajadas |
| COSTO_PEN | **Costo total de la fila**, opcional. Vacío significa pendiente; cero es explícito |
| RESULTADO | Resultado obtenido; puede completarse desde la solicitud |
| SUSTENTO | Referencia al documento/acta, sin información sensible ajena al proceso |
| CONSENTIMIENTO | SI / NO / SIN_DATO. La ausencia no presume consentimiento |

Si un trabajador incluido no realizó HHEE, registrar inicio igual a fin, descanso cero, horas reconocidas cero y costo cero o vacío. No se crean horas ficticias para completar una solicitud.

La importación conserva nombre del archivo, SHA256 y fila como referencia de origen. No almacena el libro completo de planillas. Un reintento de la misma operación devuelve el resultado confirmado sin duplicarlo. Una fila ya registrada sin cambios tampoco vuelve a aplicarse. Modificar una fila importada requiere motivo; modificar una validada exige reapertura.

## Indicadores e informe

- **Horas validadas**: suma de minutos reconocidos/validados de solicitudes VALIDADA, dividida entre 60.
- **Ejecutadas por validar**: minutos efectivamente trabajados en solicitudes EJECUTADA. No se mezclan con los validados.
- **Costo conocido**: suma de costos validados disponibles. Se informa por separado cuántas filas carecen de valorización. Un importe desconocido nunca se convierte en cero.
- **Aprobación previa**: solicitudes ejecutadas con autorización anterior al inicio y sin exceso respecto a los minutos aprobados / solicitudes efectivamente ejecutadas. Una aprobación posterior no se presenta como previa.
- **Recurrencia**: repetición de la misma causa confirmada/propuesta en el área dentro de la ventana configurada. Es independiente de que la necesidad se evalúe justificada o mejorable.
- **Metas**: conteo de solicitudes que alcanzaron una meta definida. No se suman toneladas con despachos, equipos u otras unidades.
- **Acciones vencidas**: acciones abiertas/en curso cuyo vencimiento fue anterior al día actual en Lima. Las realizadas siguen pendientes de verificación independiente.

Filtros compartidos: período (máximo 366 días), sede, área, causa, estado y búsqueda. Los gráficos permiten acotar por fecha/causa y las tablas ordenan y paginan los resultados. Los agregados incluyen todo el alcance; el detalle muestra un máximo de 500 solicitudes, indicado cuando se alcanza. Excel exige acotar a ese máximo para evitar un detalle incompleto.

PDF: resumen gerencial, costos conocidos/pendientes, causas, resultados y acciones con responsables y plazos. Excel: resumen, áreas, solicitudes y acciones. La exportación respeta la visibilidad de costos. El correo presenta una vista previa editable y abre Outlook/Gmail/correo predeterminado; el usuario adjunta el PDF y confirma el envío en su correo. No se inserta una firma adicional.

## Controles técnicos

Tablas privadas con RLS y barrera de cuenta activa; sin lectura o escritura directa desde usuarios, sin acceso anónimo. Los RPC verifican cuenta, sede, área y capacidad. Las tarifas individuales y las imágenes privadas del historial se omiten en la respuesta de Gerencia y solicitantes.

Transacciones atómicas, recibos de idempotencia, control de versiones y bloqueo de escrituras HHEE protegen frente a reintentos, aprobaciones concurrentes y asistencia superpuesta. Índices cubren todas las referencias.

El módulo registra y analiza hechos. **No calcula planillas, descuentos ni decisiones automáticas de pago**, y no reemplaza la revisión de RR. HH. ni la normativa laboral aplicable.

## Verificación aislada

Con Docker y las dependencias instaladas, ejecutar **node scripts/test-hhee-postgres.cjs**.
Crea un PostgreSQL 16 sin red ni puertos publicados, aplica las migraciones HHEE y ejecuta C120/C121.
Incluye la columna opcional profiles.area y el límite real de roles.name para detectar conflictos de nombres.
El contenedor se elimina al terminar. No utiliza credenciales ni conexiones de producción.
Este control también se ejecuta en los PR; la batería completa de SQL se mantiene en el despliegue.
