export type TrackingEmailDraft = { to: string; cc: string; subject: string; body: string }
export type EmailClient = 'outlook' | 'gmail' | 'default'

export function trackingEmailTemplate(label: string, link: string, pin: string) {
  const scope = label.trim() || 'las operaciones autorizadas'
  return {
    subject: `JRM TMS | Seguimiento de despachos — ${scope}`,
    body: `GERENCIA DE LOGÍSTICA\nSeguimiento de operaciones de distribución\n\nEstimados:\n\nCompartimos el acceso al panel de seguimiento de ${scope}, que centraliza el calendario de despachos, las solicitudes registradas y el estado de los servicios.\n\nEsta herramienta permite consultar la programación y los avances operativos, facilitando la supervisión y la toma de decisiones.\n\nCONSULTAR SEGUIMIENTO\n${link}\n\nCódigo de acceso: ${pin}\nEnlace alternativo: ${link}\n\nLa información se actualiza conforme se registran los avances en JRM TMS. El acceso es exclusivamente de consulta.\n\nAtentamente,`,
  }
}

function recipients(value: string, required: boolean): string {
  if (/[\r\n]/.test(value)) throw new Error('Los destinatarios no pueden contener saltos de línea.')
  const addresses = value.split(/[;,]/).map(v => v.trim()).filter(Boolean)
  if (required && !addresses.length) throw new Error('Ingresa al menos un destinatario.')
  if (addresses.some(v => !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(v))) {
    throw new Error('Revisa los correos. Separa varios destinatarios con coma o punto y coma.')
  }
  return [...new Set(addresses)].join(',')
}

export function trackingEmailUrl(client: EmailClient, draft: TrackingEmailDraft): string {
  const to = recipients(draft.to, true), cc = recipients(draft.cc, false)
  if (!draft.subject.trim() || /[\r\n]/.test(draft.subject)) throw new Error('Ingresa un asunto válido, sin saltos de línea.')
  if (!draft.body.trim()) throw new Error('El mensaje no puede estar vacío.')
  const params = new URLSearchParams({ to, ...(cc ? { cc } : {}), subject: draft.subject, body: draft.body })
  if (client === 'outlook') return `https://outlook.office.com/mail/deeplink/compose?${params}`
  if (client === 'gmail') {
    params.delete('subject'); params.set('su', draft.subject); params.set('view', 'cm'); params.set('fs', '1')
    return `https://mail.google.com/mail/?${params}`
  }
  params.delete('to')
  // mailto uses percent encoding: a literal '+' must never replace a space.
  return `mailto:${to.split(',').map(encodeURIComponent).join(',')}?${Array.from(params, ([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
}
