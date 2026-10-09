const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const ts = require('typescript')
const Module = require('node:module')
const path = require('node:path')
const file = path.resolve(__dirname, '../src/lib/tracking-email.ts')
const compiled = new Module(file, module)
compiled._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, file)
const { trackingEmailTemplate, trackingEmailUrl } = compiled.exports
const link = 'https://jrm-tms.vercel.app/tracking/11111111-2222-4333-8444-555555555555'
const draft = { to: 'gerencia@example.com; operaciones@example.com', cc: 'control@example.com', ...trackingEmailTemplate('Gerencia JRM', link, '12345678') }
test('approved template includes correct credentials and no personal signature', () => {
  assert.match(draft.body, /GERENCIA DE LOGÍSTICA/)
  assert.ok(draft.body.includes(link))
  assert.match(draft.body, /Código de acceso: 12345678/)
  assert.ok(draft.body.endsWith('Atentamente,'))
  assert.ok(!draft.body.includes('cpetit@'))
  assert.equal(new URL(link).search, '')
  const rotated = trackingEmailTemplate('Nuevo cliente', link, '87654321')
  assert.ok(!rotated.body.includes('12345678'))
  assert.match(rotated.body, /87654321/)
})
test('Outlook and Gmail preserve recipients, edited body and subject with reserved characters', () => {
  for (const client of ['outlook', 'gmail']) {
    const edited = { ...draft, subject: 'Revisión & OT + "A"', body: draft.body + '\nConsulta: <pendiente> & + ? #' }
    const url = new URL(trackingEmailUrl(client, edited))
    assert.equal(url.searchParams.get('to'), 'gerencia@example.com,operaciones@example.com')
    assert.equal(url.searchParams.get('cc'), draft.cc)
    assert.equal(url.searchParams.get(client === 'gmail' ? 'su' : 'subject'), edited.subject)
    assert.equal(url.searchParams.get('body'), edited.body)
  }
})
test('mailto preserves spaces, unicode, plus and newlines without extra headers', () => {
  const url = trackingEmailUrl('default', { ...draft, body: 'Código + enlace\nÁmbito & detalle' })
  assert.ok(url.startsWith('mailto:gerencia%40example.com,operaciones%40example.com?'))
  const values = Object.fromEntries(url.split('?')[1].split('&').map(pair => pair.split('=').map(decodeURIComponent)))
  assert.equal(values.body, 'Código + enlace\nÁmbito & detalle')
  assert.equal(values.cc, draft.cc)
})
test('invalid recipients and header injection are rejected before a composer opens', () => {
  for (const patch of [{ to: '' }, { to: 'user@example.com\r\nBcc: other@example.com' }, { cc: 'not-an-email' }, { subject: 'Hi\nBcc: bad@example.com' }, { body: '' }]) {
    assert.throws(() => trackingEmailUrl('outlook', { ...draft, ...patch }))
  }
})
