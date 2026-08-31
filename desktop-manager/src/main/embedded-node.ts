import { homedir } from 'node:os'
import { join } from 'node:path'

const REMOVED_ENVIRONMENT_KEYS = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_AUTH_TOKEN',
  'NPM_TOKEN',
  'npm_config_userconfig',
  'npm_config_registry',
] as const

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of REMOVED_ENVIRONMENT_KEYS) delete env[key]
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_package_') || key.startsWith('npm_config_')) delete env[key]
  }
  return env
}

function toolEnvironment(): NodeJS.ProcessEnv {
  const inherited = process.env.PATH?.split(':').filter(Boolean) ?? []
  const candidates = [
    join(homedir(), 'Library', 'pnpm'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
  return { ...process.env, PATH: [...new Set([...inherited, ...candidates])].join(':') }
}

export function systemNodeLaunch(extra: NodeJS.ProcessEnv = {}): { executable: string; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...sanitizedEnvironment(), PATH: toolEnvironment().PATH }
  delete env.ELECTRON_RUN_AS_NODE
  return { executable: 'node', env: { ...env, ...extra } }
}

export function embeddedNodeLaunch(extra: NodeJS.ProcessEnv = {}): {
  executable: string
  env: NodeJS.ProcessEnv
} {
  const env = sanitizedEnvironment()
  return {
    executable: process.execPath,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1', ...extra },
  }
}

export function isolatedInstallerEnvironment(home: string, userConfig: string, cache: string): NodeJS.ProcessEnv {
  const { env } = embeddedNodeLaunch({
    HOME: home,
    DSH_HOME: home,
    npm_config_userconfig: userConfig,
    npm_config_cache: cache,
    npm_config_registry: 'https://registry.npmjs.org',
  })
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete env[key]
  }
  return env
}
