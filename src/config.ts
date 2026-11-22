import type { ZenlevConfig } from './types'

export function defineConfig<const Config extends ZenlevConfig>(config: Config): Config {
  return config
}
