import type { McpAggregatorConfig } from '../common/types.js'

import { create as createServices } from './services.js'
import type { AggregatorDeps } from './services.js'

const create = (config: McpAggregatorConfig, deps?: AggregatorDeps) => {
  // eslint-disable-next-line functional/no-let
  let services: ReturnType<typeof createServices> | undefined

  return {
    connect: async () => {
      services = createServices(config, deps)
      await services.connect()
    },
    getTools: async () => {
      if (!services) {
        throw new Error('Services not initialized')
      }
      return services.getTools()
    },
    executeTool: async (toolName: string, params: any) => {
      if (!services) {
        throw new Error('Services not initialized')
      }
      return services.executeTool(toolName, params)
    },
  }
}

export { create }
