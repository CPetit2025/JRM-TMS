// La caché de listas solo devuelve datos del mismo usuario de la sesión.
const assert = require('node:assert/strict'), ts = require('typescript'), fs = require('node:fs')
const store = new Map(); let cookie = ''
global.sessionStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) }
Object.defineProperty(global, 'document', { value: { get cookie() { return cookie } } })
const m = { exports: {} }; new Function('module', 'exports', ts.transpile(fs.readFileSync('src/lib/use-cached.ts', 'utf8'), { module: 1 }))(m, m.exports)
const { readCache, writeCache } = m.exports
const as = id => 'base64-' + Buffer.from(JSON.stringify({ user: { id } })).toString('base64url')
const half = as('ana'), chunks = [half.slice(0, 20), half.slice(20)]
cookie = `x=1; sb-abc-auth-token.1=${chunks[1]}; sb-abc-auth-token.0=${chunks[0]}`
writeCache('k', [1]); assert.deepEqual(readCache('k'), [1], 'mismo usuario (cookie en partes)')
cookie = `sb-abc-auth-token=${as('beto')}`; assert.equal(readCache('k'), undefined, 'otro usuario no ve la caché')
cookie = ''; assert.equal(readCache('k'), undefined, 'sin sesión no hay caché')
console.log('PASS: caché de listas ligada al usuario de la sesión.')
