const fs = require('node:fs')

const requiredConfig = {
  buildCommand: 'npm run build',
  installCommand: 'npm install',
  outputDirectory: '.next',
}

function checkVercelConfig() {
  if (!fs.existsSync('vercel.json')) {
    throw new Error('Missing vercel.json')
  }

  const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'))

  for (const [key, expectedValue] of Object.entries(requiredConfig)) {
    if (config[key] !== expectedValue) {
      throw new Error(`Invalid vercel.json ${key}: expected "${expectedValue}"`)
    }
  }

  console.log('Vercel config check passed')
}

try {
  checkVercelConfig()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
