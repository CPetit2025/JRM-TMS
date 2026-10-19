# Control de horas extras — piloto JRM TMS

Acceso: **Control de Horas Extras** en el menú o /hhee.

## Activación

Un administrador configura /hhee/configuracion:

1. Mantener habilitada **Distribución** en la sede PRINCIPAL durante el piloto. Las demás áreas existentes quedan deshabilitadas para HHEE sin borrar sus datos. Habilitar otra área requiere una decisión explícita de Configuración HHEE.
2. Registrar las fichas remunerativas manualmente o con el Excel de fichas. Cada trabajador tiene código único, área, conceptos mensuales, condición computable por concepto y horas mensuales de referencia. El costo HHEE es **aproximado** y se deriva de esa ficha. La tarifa integral antigua no se convierte automáticamente en remuneración base.
3. En /permisos, asignar los permisos HHEE a los roles apropiados.
4. Vincular cada usuario —**incluida Gerencia**— con sus áreas habilitadas en Configuración HHEE, además de su acceso existente a las sedes. El rol por sí solo no permite consultar datos de otras áreas.
5. Definir la ventana de recurrencia y los destinatarios del informe. El día/hora son una referencia para el corte semanal; **el envío es manual**, mediante el correo corporativo.

No se otorgan permisos a roles existentes automáticamente. No se crean ejecuciones ni costos de demostración.

| Perfil | Permisos sugeridos | Alcance |
| --- | --- | --- |
| Solicitante | hhee-solicitar:write | Áreas asignadas |
| Jefe del área | hhee-aprobar:write | Áreas asignadas |
| RR. HH. | hhee-validar:write | Áreas asignadas; asistencia y costos individuales |
| Gerencia | hhee-gerencia:read, hhee-excepciones:write | Áreas asignadas y habilitadas, dentro de sedes autorizadas; costos agregados |
| Consulta de área | hhee:read | Áreas asignadas |
| Configuración | hhee-config:write | Sedes autorizadas; directorio y accesos |
| Consulta de costo individual | hhee-costos:read | Áreas asignadas; solo para personal autorizado |

Los permisos :read de solicitar/aprobar/validar permiten consultar, no ejecutar la operación. Los permisos de otros módulos (APT, Transporte, Mantenimiento) no habilitan HHEE. Administración configura el alcance; ninguna área deshabilitada participa en solicitudes ni reportes, incluso para el administrador. Configuración puede consultar la estructura y administrar fichas de las áreas habilitadas de sus sedes.

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

## Ficha remunerativa y estimación

Cada ficha contiene hasta 20 conceptos mensuales: nombre, importe S/ y condición **computable SI/NO**. RR. HH. determina los conceptos aplicables (básico, asignaciones u otros) y el divisor de horas. El valor inicial de **240 horas/mes es editable** y debe confirmarse para cada trabajador; no se impone como criterio laboral.

- Base mensual = suma de conceptos marcados computables. Los conceptos excluidos se conservan pero no suman.
- Tarifa base = base mensual / horas mensuales de referencia, redondeada a cuatro decimales.
- Normal = tarifa base × horas normales. Se presenta separada del costo HHEE.
- HHEE aproximadas = tarifa base × (horas al 25% × 1,25 + horas al 35% × 1,35 + horas al 100% × 2), redondeadas a dos decimales **por trabajador y registro**.
- No hay distribución automática entre categorías: RR. HH. importa el desglose aplicable.
- Sin conceptos computables, la tarifa y la estimación quedan pendientes. Un importe desconocido no se transforma en cero.

El Excel de fichas utiliza **una fila por concepto**: CODIGO, NOMBRE, AREA_ID, HORAS_MES, CONCEPTO, MONTO_MENSUAL, COMPUTABLE (SI/NO). Repetir los mismos datos del trabajador en sus filas; los conceptos deben ser únicos. Máximo 1500 filas, 300 trabajadores y 20 conceptos por ficha. La vista previa informa los conceptos antes de reemplazar las fichas incluidas; no modifica las demás.

La asistencia conserva una copia privada de los conceptos, divisor y tarifa utilizados. Un cambio de ficha no altera cálculos anteriores. Para recalcular un registro, activar **Actualizar la tarifa desde la ficha vigente** y justificar la corrección; si ya está validado, RR. HH. debe reabrirlo antes. Queda historial privado de la ficha y de la asistencia corregidas.

## Excel de asistencia RR. HH.

Primera hoja; entre 1 y 500 filas; máximo 10 MB. Formatos XLS/XLSX, incluidos libros con calendario 1904.

| Columna | Contenido |
| --- | --- |
| SOLICITUD | Código de la solicitud, por ejemplo HE-000001 |
| CODIGO_TRABAJADOR | Código de la ficha HHEE |
| INICIO / FIN | Intervalo efectivo **solo de HHEE**, fechas Excel o AAAA-MM-DD HH:mm, hora de Lima |
| DESCANSO_MIN | Minutos enteros descontados del intervalo HHEE |
| HORAS_RECONOCIDAS | Horas extras reconocidas por RR. HH.; si queda vacía se usa la suma de las tres categorías. No puede superar las trabajadas |
| HORAS_NORMALES | Referencia opcional de horas ordinarias; registrar una sola vez por trabajador y fecha. No suma como HHEE |
| HORAS_25 / HORAS_35 / HORAS_100 | Completar las tres, usando 0 si no aplica. Su suma debe coincidir con las HHEE reconocidas |
| RESULTADO | Resultado obtenido; puede completarse desde la solicitud |
| SUSTENTO | Referencia al documento/acta, sin información sensible ajena al proceso |
| CONSENTIMIENTO | SI / NO / SIN_DATO. La ausencia no presume consentimiento |

No se ingresa tarifa ni costo en esta plantilla: se calcula desde la ficha. Se admite el formato anterior de asistencia, sin desglose, para compatibilidad; su costo se muestra como estimación importada RR. HH. y las horas quedan **sin desglose**. No se mezcla un costo manual con horas categorizadas. Los nuevos registros no usan la antigua tarifa integral para calcular presupuestos antes de conocer las categorías.

Si no realizó HHEE, registrar inicio igual a fin, descanso cero, horas reconocidas cero y las tres categorías en cero. No se crean horas ficticias.

La importación conserva nombre del archivo, SHA256 y fila. No almacena el libro completo de planillas. Un reintento de la misma operación no duplica datos y vuelve a comprobar el alcance RR. HH. Una fila registrada sin cambios tampoco se vuelve a aplicar. Modificar una importada requiere motivo; modificar una validada exige reapertura. Los errores impiden aplicar el archivo completo.

## Indicadores e informe

- **Horas normales / 25% / 35% / 100%**: desglose de la ejecución validada; las normales se presentan aparte y los registros antiguos conservan la categoría sin desglose.
- **Horas validadas**: suma de minutos reconocidos/validados de solicitudes VALIDADA, dividida entre 60.
- **Ejecutadas por validar**: minutos efectivamente trabajados en solicitudes EJECUTADA. No se mezclan con los validados.
- **Costo aproximado HHEE**: suma de estimaciones asociadas a asistencias validadas disponibles. No es un costo definitivo ni liquidado. Se informa por separado cuántas filas carecen de valorización. Un importe desconocido nunca se convierte en cero.
- **Aprobación previa**: solicitudes ejecutadas con autorización anterior al inicio y sin exceso respecto a los minutos aprobados / solicitudes efectivamente ejecutadas. Una aprobación posterior no se presenta como previa.
- **Recurrencia**: repetición de la misma causa confirmada/propuesta en el área dentro de la ventana configurada. Es independiente de que la necesidad se evalúe justificada o mejorable.
- **Metas**: conteo de solicitudes que alcanzaron una meta definida. No se suman toneladas con despachos, equipos u otras unidades.
- **Acciones vencidas**: acciones abiertas/en curso cuyo vencimiento fue anterior al día actual en Lima. Las realizadas siguen pendientes de verificación independiente.

Filtros compartidos: período (máximo 366 días), sede, área, causa, estado y búsqueda. Los gráficos permiten acotar por fecha/causa y las tablas ordenan y paginan los resultados. Los agregados incluyen todo el alcance; el detalle muestra un máximo de 500 solicitudes, indicado cuando se alcanza. Excel exige acotar a ese máximo para evitar un detalle incompleto.

PDF: resumen gerencial, costos aproximados/pendientes, causas, resultados y acciones con responsables y plazos. Excel: resumen, tipos de hora, criterios de estimación, áreas, solicitudes y acciones. La exportación respeta la visibilidad de costos. El correo presenta una vista previa editable y abre Outlook/Gmail/correo predeterminado; el usuario adjunta el PDF y confirma el envío en su correo. No se inserta una firma adicional.

## Controles técnicos

Tablas privadas con RLS y barrera de cuenta activa; sin lectura o escritura directa desde usuarios, sin acceso anónimo. Los RPC verifican cuenta, sede, área y capacidad. Los conceptos remunerativos, las tarifas individuales y las imágenes privadas del historial se omiten en la respuesta de Gerencia y solicitantes.

Transacciones atómicas, recibos de idempotencia, control de versiones y bloqueo de escrituras HHEE protegen frente a reintentos, aprobaciones concurrentes y asistencia superpuesta. Índices cubren todas las referencias.

El módulo registra y analiza hechos. **No calcula planillas, descuentos ni decisiones automáticas de pago**, y no reemplaza la revisión de RR. HH. ni la normativa laboral aplicable.

## Verificación aislada

Con Docker y las dependencias instaladas, ejecutar **node scripts/test-hhee-postgres.cjs**.
Crea un PostgreSQL 16 sin red ni puertos publicados, aplica las migraciones HHEE y ejecuta C120/C121/C124. C124 verifica el aislamiento de Distribución, conceptos privados, recargos, horas normales separadas, tarifas históricas y revalorización explícita.
Incluye la columna opcional profiles.area y el límite real de roles.name para detectar conflictos de nombres.
El contenedor se elimina al terminar. No utiliza credenciales ni conexiones de producción.
Este control también se ejecuta en los PR; la batería completa de SQL se mantiene en el despliegue.
