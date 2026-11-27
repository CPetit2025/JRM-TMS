// Imprime solo el elemento (una hoja de vista previa) en un iframe con los estilos de la página
export function imprimirHoja(el: HTMLElement | null, titulo: string, orientacion: 'landscape' | 'portrait') {
  const f = document.createElement('iframe')
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(f)
  const d = f.contentDocument!
  const css = [...document.querySelectorAll('link[rel="stylesheet"],style')].map(n => n.outerHTML).join('')
  d.open(); d.write(`<!doctype html><html><head><meta charset="utf-8"><title>${titulo}</title>${css}<style>@page{size:A4 ${orientacion};margin:10mm}body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}thead{display:table-header-group}tr{break-inside:avoid}</style></head><body>${el?.outerHTML ?? ''}</body></html>`); d.close()
  const go = () => { f.contentWindow?.focus(); f.contentWindow?.print(); setTimeout(() => f.remove(), 1000) }
  // Espera al logo antes de imprimir
  const img = d.querySelector('img')
  if (img && !img.complete) { img.onload = go; img.onerror = go } else setTimeout(go, 300)
}
