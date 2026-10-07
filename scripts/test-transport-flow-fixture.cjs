const http=require('node:http')
const user={id:'00000000-0000-4000-8000-000000000011',email:'qa@example.test',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{}}
const policy={enabled:true,zones:{LIMA:{enabled:true,hours:24},PROVINCIA:{enabled:true,hours:48},EXTERIOR:{enabled:true,hours:72}},version:1}
http.createServer((req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');res.setHeader('Content-Type','application/json')
 if(req.method==='OPTIONS'){res.end();return}
 const url=new URL(req.url,'http://fixture'), fn=url.pathname.split('/').at(-1);let value=[]
 if(url.pathname.startsWith('/auth/v1/user'))value=user
 else if(url.pathname.startsWith('/rest/v1/profiles')){const profile={...user,first_name:'Supervisor',last_name:'QA',is_active:true,employee_type:'ADMINISTRATIVO',roles:{name:'Administrador',permissions:['dashboard','solicitudes','despacho','despacho-aprobacion','documentario','packing-list','planificacion','configuracion','clientes','contratos-servicios']}};value=req.headers.accept?.includes('vnd.pgrst.object')?profile:[profile]}
 else if(url.pathname.includes('/rpc/')){
  if(fn==='get_transport_lead_time_settings')value=policy
  else if(fn==='notif_list')value={success:true,items:[],no_leidas:0}
  else if(fn==='get_public_tracking_portal_info')value={mode:'permanent',rows:[],requests:[],locations:[]}
  else if(fn==='get_tower_dispatches')value=[]
 }
 res.end(JSON.stringify(value))
}).listen(3019,'127.0.0.1',()=>console.log('Synthetic Supabase transport fixture ready on3019; no production connection'))
