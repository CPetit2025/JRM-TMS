import assert from 'node:assert/strict'
import { validateWmsTarget } from './wms-auto/targets.mjs'
for (const host of ['jrm-wms.vercel.app','jrm-wms-staging.vercel.app']) assert.equal(validateWmsTarget(`https://${host}/`),`https://${host}`)
for (const url of ['https://jrm-tms.vercel.app','https://jrm-tms-git-feature-warehouse-wms-portal.vercel.app','http://jrm-wms.vercel.app','https://jrm-wms.vercel.app.evil.test','https://user@jrm-wms.vercel.app','https://jrm-wms.vercel.app/api','https://jrm-wms.vercel.app?token=secret']) assert.throws(()=>validateWmsTarget(url))
console.log('PASS: robot permits dedicated WMS sites only and rejects TMS, arbitrary previews and injected URLs.')
