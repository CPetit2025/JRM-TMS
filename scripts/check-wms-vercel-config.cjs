'use strict'
const fs = require('node:fs')
const {parse} = require('dotenv')
const {checkTarget} = require('./check-supabase-target.cjs')
const file=process.argv[2] || '.vercel/.env.production.local'
try {
 const values=parse(fs.readFileSync(file))
 if(values.JRM_APP!==process.env.JRM_APP)throw Error('El proyecto Vercel tiene otro JRM_APP')
 const errors=checkTarget({app:values.JRM_APP,ref:process.env.SUPABASE_PROJECT_REF,url:values.NEXT_PUBLIC_SUPABASE_URL,strict:true})
 if(errors.length)throw Error(errors.join(' '))
 if(!values.NEXT_PUBLIC_SUPABASE_ANON_KEY)throw Error('Falta la clave pública WMS en Vercel')
 console.log('WMS Vercel application identity and database target verified; no secret values printed.')
} catch(error) {console.error(error.message);process.exitCode=1}
finally {if(fs.existsSync(file))fs.unlinkSync(file)}
