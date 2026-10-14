// Países para clientes extranjeros (sin SUNAT): código ISO-3166 alfa-2, nombre y nombre del documento tributario.
export const FOREIGN_COUNTRIES: { code: string; name: string; doc: string }[] = [
  { code: 'BO', name: 'Bolivia', doc: 'NIT' },
  { code: 'CO', name: 'Colombia', doc: 'NIT' },
  { code: 'CL', name: 'Chile', doc: 'RUT' },
  { code: 'EC', name: 'Ecuador', doc: 'RUC' },
  { code: 'AR', name: 'Argentina', doc: 'CUIT' },
  { code: 'BR', name: 'Brasil', doc: 'CNPJ' },
  { code: 'PY', name: 'Paraguay', doc: 'RUC' },
  { code: 'UY', name: 'Uruguay', doc: 'RUT' },
  { code: 'VE', name: 'Venezuela', doc: 'RIF' },
  { code: 'PA', name: 'Panamá', doc: 'RUC' },
  { code: 'MX', name: 'México', doc: 'RFC' },
  { code: 'US', name: 'Estados Unidos', doc: 'EIN / Tax ID' },
  { code: 'CA', name: 'Canadá', doc: 'BN / Tax ID' },
  { code: 'ES', name: 'España', doc: 'NIF / CIF' },
  { code: 'CN', name: 'China', doc: 'USCC / Tax ID' },
]

export const isForeignCountry = (code: string | null | undefined) => !!code && code.toUpperCase() !== 'PE'
export const foreignCountry = (code: string | null | undefined) => FOREIGN_COUNTRIES.find(c => c.code === (code || '').toUpperCase())
/** Documento tributario extranjero: letras y números, sin espacios ni signos (igual que el servidor). */
export const normalizeForeignTaxId = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20)
/** Texto del documento para listas: «RUC 20…» o «NIT 1234567 · Bolivia». */
export function clientDocLabel(c: { tax_id?: string | null; country_code?: string | null; country_name?: string | null }) {
  if (!isForeignCountry(c.country_code)) return c.tax_id ? `RUC ${c.tax_id}` : 'Sin RUC'
  const country = foreignCountry(c.country_code)
  return `${country?.doc || 'Doc.'} ${c.tax_id || '—'} · ${country?.name || c.country_name || c.country_code}`
}
