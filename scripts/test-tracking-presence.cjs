// Real PostgreSQL, no linked database: migration identity/scope/session logic with a bounded operational payload fixture.
const {spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path')
const root=path.resolve(__dirname,'..'),name='jrm-tracking-presence-'+process.pid+'-'+Date.now()
function docker(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});if(r.error)throw r.error;return {status:r.status,output:(r.stdout||'')+(r.stderr||'')}}
function sql(file){return docker(['exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],fs.readFileSync(path.join(root,file),'utf8'))}
async function main(){try{
 const start=docker(['run','-d','--rm','--network','none','--name',name,'-e','POSTGRES_PASSWORD=isolated-tracking-test','postgres:16-alpine']);if(start.status)throw Error(start.output)
 let ready=false;for(let i=0;i<40;i++){if(!docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']).status){ready=true;break}await new Promise(r=>setTimeout(r,250))}if(!ready)throw Error('PostgreSQL no inició')
 for(const f of ['scripts/fixtures/hhee-schema.sql','scripts/fixtures/tracking-presence-schema.sql','supabase/migrations/20261016120000_tracking_portal_viewers.sql','supabase/migrations/20261021020000_seguimiento_interno.sql','supabase/migrations/20261021030000_seguimiento_interno_perfil.sql','supabase/migrations/20261021090000_tracking_presence_scoped.sql']){const r=sql(f);if(r.status)throw Error(f+'\n'+r.output)}
 // Reproduce a populated production site: C108 must use its own synthetic site rather than assume nobody is online.
 const baseline=docker(['exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],`DO $$
 DECLARE v_actor uuid;v_site uuid;v_link jsonb;v_signin jsonb;v_view jsonb;
 BEGIN
  SELECT p.id INTO v_actor FROM public.profiles p JOIN public.roles r ON r.id=p.role_id WHERE r.name='Administrador' ORDER BY p.id LIMIT 1;
  v_site:=public.primary_site_id();
  PERFORM set_config('request.jwt.claim.sub',v_actor::text,true);
  PERFORM public.get_internal_tracking_view(v_site,current_date,current_date);
  v_link:=public.generate_tracking_portal_link(jsonb_build_object('site_id',v_site));
  PERFORM set_config('request.jwt.claim.sub','',true);
  v_signin:=public.tracking_portal_sign_in_session((v_link->>'token')::uuid,v_link->>'pin','Espectador previo de prueba',gen_random_uuid());
  v_view:=public.get_public_tracking_portal_view((v_link->>'token')::uuid,v_link->>'pin',(v_signin->>'viewer_id')::uuid,current_date,current_date);
  IF (v_view->>'active_count')::int IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'No se preparó la presencia previa de regresión'; END IF;
 END $$;`)
 if(baseline.status)throw Error('Presencia previa\n'+baseline.output)
 for(const [f,label] of [['supabase/tests/caja_c108_portal_nombre_presencia.test.sql','C108'],['supabase/tests/caja_c123_seguimiento_interno.test.sql','C123'],['supabase/tests/caja_c128_tracking_presencia_unificada.test.sql','C128']]){const r=sql(f);if(!r.output.includes('CAJA '+label+' PASS')||r.output.includes('CAJA '+label+' FAIL'))throw Error(f+'\n'+r.output);console.log('PASS tracking PostgreSQL '+label)}
}finally{docker(['rm','-f',name])}}
main().catch(e=>{console.error(e.message);process.exitCode=1})
