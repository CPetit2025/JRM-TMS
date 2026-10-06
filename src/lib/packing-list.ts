const formats: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export function packingMime(file: { name: string; type: string }): string | null {
  const extension = file.name.split('.').at(-1)?.toLowerCase() || ''
  if (file.name.includes('.') && !formats[extension]) return null
  return formats[extension] || (Object.values(formats).includes(file.type) ? file.type : null)
}

export const PACKING_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.xls,.xlsx'
