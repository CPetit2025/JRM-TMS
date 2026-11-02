import packageJson from '../../package.json'

// APP_VERSION la fija next.config.ts al compilar (cambia en cada despliegue)
export const webVersion = process.env.APP_VERSION || packageJson.version
export const webBuildId = process.env.VERCEL_GIT_COMMIT_SHA || process.env.APP_BUILD_ID || webVersion
