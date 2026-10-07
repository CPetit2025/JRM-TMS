import assert from 'node:assert/strict'
import { monthDays,limaDay,requestAnticipation,portalAllowedTime } from '../src/lib/tracking-calendar.ts'
const grid=monthDays('2026-10')
assert.equal(grid.length,42);assert.equal(grid[0],'2026-09-28');assert.equal(grid[41],'2026-11-08')
assert.equal(limaDay('2026-10-08T03:30:00Z'),'2026-10-07')
const request={request_type:'DESPACHO',attention_mode:'TRANSPORTE_JRM',created_at:'2026-10-07T22:45:00Z',required_at:'2026-10-08T13:00:00Z',delivery_zone:'LIMA',lead_time_policy:{enabled:true,zones:{LIMA:{enabled:true,hours:24}}}}
assert.equal(requestAnticipation(request).label,'Anticipación insuficiente')
assert.equal(requestAnticipation(request).earliest,'2026-10-08T22:45:00.000Z')
assert.equal(requestAnticipation({...request,required_at:'2026-10-08T22:45:00Z'}).label,'Cumple anticipación')
assert.equal(requestAnticipation({...request,lead_time_policy:null}).label,'Sin evaluación histórica')
assert.equal(requestAnticipation({...request,attention_mode:'RECOJO_CLIENTE'}).label,'No aplica')
assert.equal(requestAnticipation({...request,lead_time_policy:{...request.lead_time_policy,enabled:false}}).label,'Control desactivado')
assert.match(portalAllowedTime('2026-10-08T22:45:32Z'),/17:46/)
console.log('PASS: calendar Monday-start42daygrid, LimaUTCboundary, exact17:45 cutoff, historicalsnapshots and pickup exemption')
