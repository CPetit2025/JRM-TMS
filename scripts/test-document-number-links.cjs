const { test } = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript'), vm = require('node:vm'), fs = require('node:fs'), React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
function load(canEdit) {
 const calls=[], errors=[]; let refs=[]
 const ctx={exports:{},window:{setTimeout,clearTimeout},require(name){
  if(name==='@/lib/supabase/client')return{createClient:()=>({rpc:async(name,args)=>{if(name==='get_dispatch_document_references')return{data:refs};calls.push(args);refs=args.p_numbers.map((number,i)=>({id:String(i),request_id:'request',doc_type:args.p_type,document_number:number}));return{data:{success:true}}}})}
  if(name==='@/lib/caja')return{errorMessage:e=>e.message}
  if(name==='sonner')return{toast:{success(){},error:e=>errors.push(e)}}
  if(name==='@/components/ui/data-table')return{DataTable:props=>React.createElement('table',props)}
  return require(name)
 }}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/components/despacho/DocumentNumberLinks.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,ctx)
 return{Component:ctx.exports.DocumentNumberLinks,props:{dispatchId:'route',services:[{request_id:'request',request_number:'RT-1',ot_code:'16339'}],canEdit,onChanged:async()=>{}},calls,errors}
}
const text=n=>typeof n==='string'?n:(n?.children||[]).map(text).join('')
test('assistant form links several numbers preserving zeros, rejects invalid/duplicate input and refreshes service table',async()=>{
 const f=load(true);let tree
 await act(async()=>{tree=create(React.createElement(f.Component,f.props))})
 await act(async()=>{await new Promise(r=>setTimeout(r,20))})
 await act(async()=>{tree.root.findAllByType('button').find(b=>text(b)==='Vincular números').props.onClick()})
 await act(async()=>{tree.root.findAllByType('input')[0].props.onChange({target:{value:'16339'}})})
 await act(async()=>{await tree.root.findByType('form').props.onSubmit({preventDefault(){}})})
 assert.equal(f.calls.length,0);assert.equal(f.errors.length,1)
 await act(async()=>{tree.root.findAllByType('input')[0].props.onChange({target:{value:'t001-00006591'}});tree.root.findAllByType('button').find(b=>text(b)==='Agregar otro número').props.onClick()})
 await act(async()=>{tree.root.findAllByType('input')[1].props.onChange({target:{value:'T001-00006591'}})})
 await act(async()=>{await tree.root.findByType('form').props.onSubmit({preventDefault(){}})})
 assert.equal(f.calls.length,0);assert.equal(f.errors.length,2)
 await act(async()=>{tree.root.findAllByType('input')[1].props.onChange({target:{value:'E001-6592'}})})
 await act(async()=>{await tree.root.findByType('form').props.onSubmit({preventDefault(){}})})
 assert.deepEqual(Array.from(f.calls[0].p_numbers),['T001-00006591','E001-6592'])
 assert.match(text(tree.toJSON()),/16339.*T001-00006591.*E001-6592/)
 assert.equal(tree.root.findAllByType('input').filter(i=>i.props.type==='file').length,0)
 await act(async()=>tree.unmount())
})
test('read-only view has no linkage or upload controls',async()=>{
 const f=load(false);let tree
 await act(async()=>{tree=create(React.createElement(f.Component,f.props))})
 await act(async()=>{await new Promise(r=>setTimeout(r,20))})
 assert.equal(tree.root.findAllByType('button').length,0)
 assert.equal(tree.root.findAllByType('input').length,0)
 await act(async()=>tree.unmount())
})
