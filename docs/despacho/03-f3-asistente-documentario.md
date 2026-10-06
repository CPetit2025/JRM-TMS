# Control de documentos de despacho

Pantalla: `/despacho/documentos`, permiso `documentario`. Migración vigente: `20261007160000_provider_access_document_roles.sql`.

## Responsables y etapas

1. El Supervisor de Transporte programa el servicio. Si contrata un tercero, el sistema genera automáticamente un acceso exclusivo para el viaje y abre el panel para compartirlo.
2. **Auditor de Despacho:** adjunta el Packing List firmado, indica su nombre y fecha, y confirma que el archivo contiene la firma. Se admite PDF, fotografía JPG/PNG/WEBP o Excel XLS/XLSX hasta 15 MB. El perfil solo accede a la planificación de despachos en lectura y a la carga/consulta del Packing List. Puede cargar uno consolidado para todas las paradas o uno por parada. En recojos del cliente, el Asistente Documentario adjunta la Nota de Despacho.
3. **Antes de salir:** el Asistente Documentario confirma los documentos. El servidor comprueba firma declarada, cobertura de todas las paradas y disponibilidad del archivo. Un timestamp de confirmación aislado no permite saltar el control. La guía física/emitida acompaña la carga según el proceso operativo; la guía firmada por el receptor se registra después de la entrega.
4. **Conductor propio:** sube obligatoriamente la guía de remisión firmada desde Ruta Activa del app. **Proveedor contratado por JRM:** sube su guía desde `/tracking/entregas`, usando placa y código, sin app ni cuenta. El enlace permite únicamente subir la guía firmada como conformidad de recepción en destino; Transporte registra los hitos de salida y llegada dentro del sistema. Se exige número de guía, receptor y de una a cinco fotos del documento firmado. Se mantienen envío offline y sincronización del app.
5. **Supervisor de Transporte:** aprueba, observa o rechaza cada guía de entrega. El asistente consulta las evidencias y su estado; no las carga en nombre del conductor/proveedor ni las valida. Una nota de texto no sustituye la guía.

La salida se sujeta a los documentos de despacho. La siguiente etapa de entrega, retorno y cierre/consumo de partida se sujetan a las guías aprobadas, según el circuito existente. El recojo por cliente conserva su Nota de Despacho y no se convierte en servicio de proveedor.

## Reemisión y antecedentes

Cambiar unidad, conductor o paradas vuelve a exigir confirmación. Anular un Packing List firmado bloquea de nuevo la salida hasta reemplazarlo y confirmar; después de salir no se anula. Los despachos ya salidos/cerrados y sus archivos conservan la historia. Los programados que estaban confirmados sin Packing List firmado vuelven a control documentario.

Las guías antiguas en `dispatch_documents` siguen visibles como antecedentes. La recepción de todas las guías nuevas se registra automáticamente para trazabilidad, sin otra carga por el asistente y sin aprobación automática. El APK carga la web en vivo; no requiere reinstalación.

## Acceso del proveedor

En Despacho → Avance/Acceso tercero, el panel muestra portal, placa, código, vigencia y un texto completo para compartir. **Copiar instrucciones** incluye todos los datos; **Compartir por WhatsApp** abre el mensaje para que Operaciones revise y lo envíe al contacto registrado. No se envían mensajes automáticamente. Renovar invalida el enlace y código anteriores; cambiar placa, proveedor o contacto rota el acceso. La revocación se mantiene hasta una renovación explícita.

Al subir una guía, esa entrega desaparece de las pendientes y no admite otro envío. Si todas están enviadas, se bloquea el acceso. Una observación o rechazo habilita solo la entrega afectada; una aprobación no la reabre. Un nuevo viaje de la misma placa tiene un acceso distinto. El acceso vence tres días después de la fecha programada o su generación, la que sea posterior.

## Validación

`test-delivery-conformity.cjs` ejecuta las migraciones y funciones reales en PostgreSQL aislado, las reglas financieras/de GPS, los permisos, el acceso automático y su rotación, y el script exacto C9 (7/7, rollback) con índices de conductor/placa activos. C41 verifica servicio tercero, Packing List, envío por proveedor y aprobación antes del cierre en la base real. C44 y C46 verifican privilegios y controles instalados; las pruebas de API y offline cubren fotografías y reintentos. El despliegue aplica migración y todas las pruebas SQL antes de publicar Vercel.

El administrador asigna el nuevo perfil **Auditor de Despacho** desde **Usuarios del Sistema**. El auditor ingresa en `/despacho/planificacion`, consulta OT, unidad y conductor, y abre el Packing List del servicio. Cada reemplazo conserva el archivo anterior y vuelve a requerir confirmación antes de la salida. El permiso de carga no concede acceso a guías, caja, programación, confirmación de salida ni validación de entregas.

C53 prueba el perfil limitado y las políticas reales de Storage por sede, los tres formatos, firma/actor, reintentos e historial. Las pruebas de API verifican que el enlace rechaza salida, llegada y otros documentos.
