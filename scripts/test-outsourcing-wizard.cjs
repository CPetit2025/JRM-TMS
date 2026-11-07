const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
const {setupOutsourcing,id}=require('./fixtures/outsourcing-setup.cjs')
const {spec,services}=require('./fixtures/outsourcing-wizard-data.cjs')
const m={exports:{}};new Function('exports','module',ts.transpileModule(fs.readFileSync('src/lib/outsourcing-form.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m.exports,m)
const model=m.exports,clone=x=>JSON.parse(JSON.stringify(x))
;(async()=>{
 const db=await setupOutsourcing()
 try{
  await db.exec(`CREATE TABLE public.transport_request_items(transport_request_id uuid,weight numeric,volume_m3 numeric,quantity numeric);
   ALTER TABLE transport_requests ADD COLUMN status text DEFAULT 'APROBADA';
   CREATE TABLE notif_reglas(evento text PRIMARY KEY,categoria text,descripcion text,severidad text,permisos text[],al_solicitante boolean);
   CREATE TABLE test_notifications(id bigint GENERATED ALWAYS AS IDENTITY,evento text,dedupe text UNIQUE);
   CREATE FUNCTION notif_emit(a text,b text,c text,d text,e text,f uuid) RETURNS bigint LANGUAGE sql AS $$INSERT INTO test_notifications(evento,dedupe) VALUES(a,b) ON CONFLICT DO NOTHING RETURNING id$$;`)
  await db.exec(fs.readFileSync('supabase/migrations/20261228090000_outsourcing_wizard_v2.sql','utf8'))
  assert.deepEqual(model.validateWizard(spec),[])
  assert.equal(model.wizardProgress(model.validateWizard(spec)).percent,100)
  const initial=model.normalizeSpec({required_at:spec.required_at,pickup:spec.pickup,delivery:spec.delivery,responsible:spec.responsible})
  assert.equal(model.wizardProgress(model.validateWizard(initial)).percent,20,'progress follows valid sections, not visits')
  const full={...clone(spec),services:clone(services),services_confirmed:'false'}
  assert.deepEqual(model.validateWizard(full),[],'all five resource forms valid')
  const iso=model.serializeSpec(full)
  assert.equal(iso.required_at,'2026-10-28T08:00:00-05:00')
  assert.equal(model.normalizeSpec(iso).services[0].details.at,'2026-10-28T08:00','Lima date survives roundtrip')
  const validate=async s=>(await db.query('SELECT outsourcing_v2_validate($1) AS errors',[s])).rows[0].errors
  assert.deepEqual(await validate(iso),[],'real SQL validates full structured form')
  for(const [field,value,pattern] of [['unit_count','1.5',/enter/],['capacity_t','0.001',/capacidad conjunta/],['loading_end','2026-10-28T06:00:00-05:00',/ventana/],['cargo_quantity','3',/cantidad consolidada/],['cargo_weight_kg','250',/peso consolidado/],['volume_m3','5',/volumen consolidado/],['loading_start','2026-02-30T07:00:00-05:00',/fecha inválida/]])assert.match((await validate({...iso,[field]:value})).join(' '),pattern,field)
  const bad=clone(iso);bad.services[0].details.quantity='-1'
  assert.match((await validate(bad)).join(' '),/MONTACARGAS/)
  assert.ok(model.validateWizard({...spec,cargo_weight_kg:'5000'}).some(i=>i.field==='capacity_t'))
  assert.ok(model.validateWizard({...spec,unit_count:'1.5'}).some(i=>i.field==='unit_count'))
  const legacy=model.normalizeSpec({required_at:'2026-10-28T13:00:00Z',unit_type:'Unidad especializada',cargo_weight_kg:'321',cargo:'Carga original y dimensiones',intermediate_points:'1. Obra A\n2. Obra B',services:[{kind:'GRUA',requirements:'Requisito original',details:{capacity:'10'}}]})
  assert.equal(legacy.required_at,'2026-10-28T08:00');assert.equal(legacy.unit_other,'Unidad especializada');assert.equal(legacy.cargo_weight_kg,'321');assert.equal(legacy.intermediate_stops.length,2);assert.equal(legacy.services[0].requirements,'Requisito original')
  const submit=(p,v=null)=>db.query('SELECT outsourcing_submit($1,$2,$3,$4) AS row',[id(2),p,v,'Requerimiento revisado para Compras'])
  await assert.rejects(submit({...model.serializeSpec(spec),unit_count:'1.5'}),/cantidades enteras/)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM transport_outsourcing')).rows[0].n,0,'invalid submit rolls back draft too')
  await db.exec("SELECT set_config('test.permission','reader',false)");await assert.rejects(submit(model.serializeSpec(spec)),/Sin permiso/,'read-only cannot submit');await db.exec("SELECT set_config('test.permission','admin',false)");
  await assert.rejects(submit({...model.serializeSpec(spec),attachments:[{name:'otro.pdf',path:'otro-requerimiento/archivo.pdf'}]}),/Adjunto inválido/,'cannot reference foreign attachment');
  await db.exec(`UPDATE contracts SET client_id=NULL WHERE id='${id(9)}'`);await assert.rejects(submit(model.serializeSpec(spec)),/cliente real/,'real linked client required');await db.exec(`UPDATE contracts SET client_id='${id(10)}' WHERE id='${id(9)}'`);
  const preparedSpec={...model.serializeSpec(spec),preparation:{state:'PREPARED',revision:1},mail_draft:{subject:'Asunto editado',text:'Mensaje editado'}}
  const preparedId=(await db.query('SELECT outsourcing_save($1,$2,NULL) AS id',[id(2),preparedSpec])).rows[0].id
  let prepared=(await db.query('SELECT * FROM transport_outsourcing WHERE id=$1',[preparedId])).rows[0]
  assert.equal(prepared.stage,0,'preparation stays in the existing draft stage')
  assert.equal((await db.query('SELECT count(*)::int AS n FROM test_notifications')).rows[0].n,0,'no notification or submission merely by preparing')
  const preparationEvent=(await db.query('SELECT * FROM transport_outsourcing_events WHERE outsourcing_id=$1 ORDER BY created_at DESC LIMIT 1',[preparedId])).rows[0]
  assert.equal(preparationEvent.snapshot.preparation.state,'PREPARED');assert.ok(preparationEvent.actor_id);assert.ok(preparationEvent.created_at)
  await db.query('SELECT outsourcing_save($1,$2,$3)',[id(2),{...preparedSpec,mail_draft:{subject:'Edición conservada',text:'Preparación manual'}},prepared.version])
  prepared=(await db.query('SELECT * FROM transport_outsourcing WHERE id=$1',[preparedId])).rows[0]
  assert.equal(prepared.specification.mail_draft.subject,'Edición conservada')
  const declared={...preparedSpec,preparation:{state:'MANUAL_SENT',revision:1,confirmation_kind:'USER_ATTESTED',reference:'Referencia declarada por usuario'}}
  let row=(await submit(declared,prepared.version)).rows[0].row
  assert.equal(row.id,preparedId,'manual confirmation uses the same linked record')
  assert.equal(row.stage,1);assert.equal(row.review_status,'ACTIVE')
  assert.equal((await db.query('SELECT count(*)::int AS n FROM test_notifications')).rows[0].n,1,'real receipt notification recorded once')
  await assert.rejects(submit(model.serializeSpec(spec)),/cambió/,'double submit cannot duplicate')
  const get=async()=>(await db.query('SELECT * FROM transport_outsourcing WHERE id=$1',[row.id])).rows[0]
  const evidence=`${row.id}/quote.pdf`;await db.query('INSERT INTO storage.objects VALUES($1,$2)',['outsourcing',evidence])
  const move=async(next,quotes=[])=>db.query('SELECT outsourcing_transition($1,$2,$3,$4,$5,$6)',[row.id,(await get()).version,next,'Gestión de Compras',evidence,quotes])
  await move(2)
  const quote=async()=>(await db.query('SELECT outsourcing_add_quote($1,$2,$3,$4,$5,$6) AS id',[row.id,'FLETE',id(4),500,'Incluye IGV y peajes',evidence])).rows[0].id
  const oldQuote=await quote()
  await db.exec("SELECT set_config('test.permission','reader',false)")
  await assert.rejects(db.query('SELECT outsourcing_review($1,$2,$3,$4)',[row.id,(await get()).version,'OBSERVE','Falta especificación de acceso']),/Sin permiso/)
  await db.exec("SELECT set_config('test.permission','compras-tercerizaciones',false)")
  await db.query('SELECT outsourcing_review($1,$2,$3,$4)',[row.id,(await get()).version,'OBSERVE','Falta especificación de acceso'])
  await assert.rejects(db.exec(`UPDATE transport_requests SET contract_id=NULL WHERE id='${id(2)}'`),/vinculada/,'OT stays linked through observations');
  row=await get();assert.equal(row.stage,0);assert.equal(row.review_status,'OBSERVED');assert.equal(row.revision,2)
  await db.exec("SELECT set_config('test.permission','despacho',false)")
  row=(await submit(model.serializeSpec({...spec,notes:'Acceso corregido'}),row.version)).rows[0].row
  assert.equal(row.revision,2);assert.equal(row.stage,1)
  await db.exec("SELECT set_config('test.permission','compras-tercerizaciones',false)")
  await move(2);await assert.rejects(move(3,[oldQuote]),/revisión técnica vigente/,'prior quotes cannot approve changed specs')
  const newQuote=await quote()
  assert.equal((await db.query('SELECT spec_revision FROM transport_outsourcing_quotes WHERE id=$1',[newQuote])).rows[0].spec_revision,2)
  await db.query('SELECT outsourcing_review($1,$2,$3,$4)',[row.id,(await get()).version,'CANCEL','Servicio ya no requerido'])
  assert.equal((await get()).review_status,'CANCELLED')
  await assert.rejects(move(3,[newQuote]),/cancelada/)
  await db.exec("SELECT set_config('test.permission','despacho',false)")
  await assert.rejects(submit(model.serializeSpec(spec),(await get()).version),/cancelada/)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM transport_outsourcing')).rows[0].n,1,'revision keeps same request identity')
  assert.equal((await db.query('SELECT count(*)::int AS n FROM transport_outsourcing_quotes')).rows[0].n,2,'quote history preserved')
  await db.exec("SELECT set_config('test.permission','reader',false),set_config('test.site','no',false)")
  await assert.rejects(db.query('SELECT outsourcing_form_context($1)',[row.id]),/Sin acceso/)
  const grants=await db.query("SELECT has_function_privilege('anon','outsourcing_submit(uuid,jsonb,integer,text)','EXECUTE') AS anon,has_function_privilege('authenticated','outsourcing_transition_v1(uuid,integer,integer,text,text,uuid[],uuid)','EXECUTE') AS legacy")
  assert.deepEqual(grants.rows[0],{anon:false,legacy:false})
  console.log('PASS ficha: preparation stays draft with actor/date snapshot, edited mail persists, manual confirmation reuses identity; partial progress, five resources, numeric/date/capacity/package validation, Lima roundtrip, legacy preservation, atomic receipt, duplicates, observation/resubmission, quote revisions, cancellation and permissions')
 }finally{await db.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
