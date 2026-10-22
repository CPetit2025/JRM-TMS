// Carga módulos TypeScript de src/ en node (transpilación sin tipos) para pruebas del motor. Resuelve «@/…» a src/.
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const SRC = path.join(__dirname, '../../src')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('@/')) request = path.join(SRC, request.slice(2))
  if ((request.startsWith('.') || path.isAbsolute(request)) && parent && !path.extname(request)) {
    const base = path.resolve(path.dirname(parent.filename || ''), request)
    for (const ext of ['.ts', '.tsx', '/index.ts']) if (fs.existsSync(base + ext)) return base + ext
  }
  return origResolve.call(this, request, parent, ...rest)
}
for (const ext of ['.ts', '.tsx']) {
  require.extensions[ext] = (mod, filename) => {
    const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
    mod._compile(out, filename)
  }
}
module.exports = rel => require(path.join(SRC, rel))
