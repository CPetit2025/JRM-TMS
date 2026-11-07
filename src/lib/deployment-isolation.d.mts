export const WMS_PRODUCTION_REF: string
export const WMS_STAGING_REF: string
export function assertDeploymentIsolation(system: string | undefined, supabaseUrl: string | undefined, environment: string | undefined): void
export function wmsRouteAllowed(path: string, method: string): boolean
