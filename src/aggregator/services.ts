import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { asyncMap } from 'modern-async'
import {
  McpAggregatorConfig,
  McpClientConfigs,
  Connection,
} from '../common/types.js'
import { createTransport } from '../common/libs.js'

const DEFAULT_MAX_PARALLEL_CALLS = 10

/**
 * Defensive parser for stringified JSON values in params.
 * Some MCP clients (like Kai) may stringify arrays/objects in the JSON-RPC request.
 * This recursively walks params and parses any stringified JSON.
 */
const parseStringifiedParams = (value: unknown): unknown => {
  // If it's a string, try to parse it as JSON
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      // Recursively parse the result (in case of nested stringification)
      return parseStringifiedParams(parsed)
    } catch {
      // Not valid JSON, return as-is
      return value
    }
  }
  // If it's an array, recursively parse each element
  if (Array.isArray(value)) {
    return value.map(parseStringifiedParams)
  }
  // If it's an object, recursively parse each value
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).reduce((acc, [key, val]) => {
      // eslint-disable-next-line functional/immutable-data
      acc[key] = parseStringifiedParams(val)
      return acc
    }, {} as Record<string, unknown>)
  }
  // Primitive value, return as-is
  return value
}

/**
 * Resolve the effective prefix for an MCP entry.
 * If an explicit prefix is provided, use it.
 * If autoPrefix is enabled and no explicit prefix, derive from id + "_".
 * Otherwise, no prefix (empty string).
 */
const resolveMcpPrefix = (
  mcp: { id: string; prefix?: string },
  autoPrefix?: boolean
): string => {
  if (mcp.prefix !== undefined) {
    return mcp.prefix
  }
  if (autoPrefix) {
    return `${mcp.id}_`
  }
  return ''
}

/**
 * Compose the final tool name from aggregator prefix, MCP prefix, and original tool name.
 */
const composeToolName = (
  aggregatorPrefix: string | undefined,
  mcpPrefix: string,
  toolName: string
): string => {
  return `${aggregatorPrefix ?? ''}${mcpPrefix}${toolName}`
}

/**
 * Resolve a collision by appending a numeric suffix.
 * If "foo" is taken, try "foo_2", then "foo_3", etc.
 */
const resolveCollision = (
  desiredName: string,
  existingNames: Set<string>
): string => {
  if (!existingNames.has(desiredName)) {
    return desiredName
  }
  let suffix = 2
  // eslint-disable-next-line functional/no-loop-statements
  while (existingNames.has(`${desiredName}_${suffix}`)) {
    suffix++
  }
  return `${desiredName}_${suffix}`
}

interface ToolRoute {
  client: Client
  originalName: string
}

const create = (config: McpAggregatorConfig) => {
  // eslint-disable-next-line functional/no-let
  let clients: Record<string, Client> = {}
  // eslint-disable-next-line functional/no-let
  let toolRouting: Record<string, ToolRoute> = {}

  const createClient = async (connection: Connection) => {
    const transport = createTransport(connection)
    const client = new Client(McpClientConfigs.integrator)
    await client.connect(transport)
    return client
  }

  return {
    connect: async () => {
      clients = await Promise.all(
        config.mcps.map(async mcp => {
          const client = await createClient(mcp.connection)
          return [mcp.id, client]
        })
      ).then(Object.fromEntries)
    },
    getTools: async () => {
      toolRouting = {}
      const existingNames = new Set<string>()
      const allTools = await asyncMap(
        Object.entries(clients),
        async ([mcpId, client]) => {
          const tools = await client.listTools().then(x => x.tools)
          // Find the MCP config entry for this client to resolve prefix
          const mcpConfig = config.mcps.find(mcp => mcp.id === mcpId)
          const mcpPrefix = mcpConfig
            ? resolveMcpPrefix(mcpConfig, config.autoPrefix)
            : ''
          const aggPrefix = config.prefix

          return tools.map(tool => {
            const desiredName = composeToolName(aggPrefix, mcpPrefix, tool.name)
            const finalName = resolveCollision(desiredName, existingNames)

            if (finalName !== desiredName) {
              console.warn(
                `Tool name collision: "${tool.name}" from MCP "${mcpId}" would conflict. Renamed to "${finalName}".`
              )
            }

            // eslint-disable-next-line functional/immutable-data
            existingNames.add(finalName)
            // eslint-disable-next-line functional/immutable-data
            toolRouting[finalName] = { client, originalName: tool.name }

            return {
              ...tool,
              name: finalName,
            }
          })
        },
        config.maxParallelCalls || DEFAULT_MAX_PARALLEL_CALLS
      )
      return allTools.flat()
    },
    executeTool: async (toolName: string, params: any) => {
      // Parse any stringified JSON in params (defensive fix for Kai stringification bug)
      const parsedParams = parseStringifiedParams(params)

      const route = toolRouting[toolName]
      if (!route) {
        throw new Error(`Unknown tool: ${toolName}`)
      }
      return route.client
        .callTool({
          name: route.originalName,
          arguments: parsedParams as Record<string, unknown> | undefined,
        })
        .catch(() => [])
    },
  }
}

export { create, resolveMcpPrefix, composeToolName, resolveCollision }