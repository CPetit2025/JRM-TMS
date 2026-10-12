const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const name = `jrm-calendar-family-${process.pid}`
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function docker(args, input) {
 const r=spawnSync('docker',args,{input,encoding:'utf8'})
 if(r.status)throw Error(r.stderr||r.stdout)
 return r.stdout
}
const sql = input => docker(['exec','-i',name,'psql','-U','postgres','-At','-v','ON_ERROR_STOP=1'],input).trim().split('\n').at(-1)
try {
 docker(['run','-d','--name',name,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine'])
 let ready=false
 for(let i=0;i<40;i++) {
  if(spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']).status===0){ready=true;break}
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200)
 }
 assert.ok(ready)
 sql(`CREATE TABLE contracts(id uuid PRIMARY KEY,code text,parent_contract_id uuid,site_id uuid,type text);
 CREATE TABLE transport_requests(id uuid PRIMARY KEY,contract_id uuid);
 CREATE TABLE transport_request_components(request_id uuid,component_contract_id uuid);
 CREATE FUNCTION get_public_tracking_portal_info(p_token uuid,p_pin text,p_from date,p_to date) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE link record; v_all boolean:=false;v_ids uuid[]:=ARRAY['${id(1)}','${id(2)}','${id(3)}']::uuid[]; result jsonb;
 BEGIN
 IF p_pin<>'A1B2' THEN RETURN jsonb_build_object('error','Código incorrecto');END IF;
 SELECT '${id(90)}'::uuid AS site_id INTO link;
 SELECT jsonb_build_object('ot_code',c.code,'parent_ot',pc.code,'status','PENDIENTE') INTO result
 FROM transport_requests t JOIN contracts c ON c.id=t.contract_id LEFT JOIN contracts pc ON pc.id=c.parent_contract_id WHERE t.id=p_token;
 RETURN result||jsonb_build_object('route',(SELECT jsonb_build_object('ot_type',ot_type,'reference_type',ref_type,'request_id',request_id)
 FROM (SELECT rt.id AS request_id,'ERROR'::text AS ot_type,NULL::text AS ref_type FROM transport_requests rt WHERE rt.id=p_token) stops));END $$;
 INSERT INTO contracts VALUES
 ('${id(1)}','16528',NULL,'${id(90)}','CONTRATO'),
 ('${id(2)}','16528-S001','${id(1)}','${id(90)}','SUBCONTRATO'),
 ('${id(3)}','16528-E014','${id(2)}','${id(90)}','ERROR'),
 ('${id(4)}','PRIVATE-E001','${id(1)}','${id(90)}','ERROR'),
 ('${id(5)}','OTHER-S001','${id(1)}','${id(91)}','SUBCONTRATO');
 INSERT INTO transport_requests VALUES('${id(10)}','${id(3)}'),('${id(11)}','${id(1)}');
 INSERT INTO transport_request_components VALUES('${id(10)}','${id(2)}'),('${id(10)}','${id(3)}'),('${id(10)}','${id(4)}'),('${id(10)}','${id(5)}');`)
 sql(readFileSync(path.join(__dirname,'../supabase/migrations/20261012030000_tracking_request_family_context.sql'),'utf8'))
 const query=(request,pin='A1B2')=>JSON.parse(sql(`SELECT get_public_tracking_portal_info('${id(request)}','${pin}',current_date,current_date);`))
 const result=query(10)
 assert.equal(result.parent_ot,'16528','resolve root through multiple ancestors')
 assert.deepEqual(result.components.map(c=>c.code),['16528-E014','16528-S001'],'only selected authorized components in same site')
 assert.equal(result.route.parent_ot,'16528','routes retain mother OT even when request list is capped')
 assert.deepEqual(result.route.components,result.components,'route counts use the same selected authorized components')
 assert.deepEqual(query(11).components,[],'do not invent family components on requests without them')
 assert.equal(query(10,'WRONG').error,'Código incorrecto','preserve credential check')
 assert.equal(sql(`SELECT proconfig::text FROM pg_proc WHERE oid='get_public_tracking_portal_info(uuid,text,date,date)'::regprocedure;`),'{"search_path=public, pg_temp"}')
 console.log('PASS: public calendar root OT, selected component scope/site privacy and unchanged authentication/search_path')
} finally {spawnSync('docker',['rm','-f',name],{stdio:'ignore'})}
