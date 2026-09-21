import packageJson from '../../package.json'

export const webVersion = packageJson.version
export const webBuildId = process.env.VERCEL_GIT_COMMIT_SHA || process.env.APP_BUILD_ID || webVersion
