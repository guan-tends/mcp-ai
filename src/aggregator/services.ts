import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { asyncMap } from 'modern-async'
import {
  McpAggregatorConfig,
  McpClientConfigs,
  Connection,
} from '../common/types.js'
import { createTransport } from '../common/libs.js'

const DEFAULT_MAX_PARALLEL_CALLS = 10
const DEFAULT_TOOL_TIMEOUT_MS = 180_000 // 3 minutes, configurable via aggregator.toolTimeoutMs

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
    return Object.entries(value).reduce(
      (acc, [key, val]) => {
        // eslint-disable-next-line functional/immutable-data
        acc[key] = parseStringifiedParams(val)
        return acc
      },
      {} as Record<string, unknown>
    )
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

/**
 * Optional dependencies for the aggregator service factory.
 * Used for dependency injection in tests to mock client creation.
 */
interface AggregatorDeps {
  /** Custom client factory. Defaults to the internal createClient which uses createTransport. */
  createClientFn?: (connection: Connection) => Promise<Client>
}

const create = (config: McpAggregatorConfig, deps?: AggregatorDeps) => {
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

  // Use injected factory if provided, otherwise use the internal one
  const _createClient = deps?.createClientFn ?? createClient

  return {
    connect: async () => {
      // Filter out disabled MCPs — they are skipped entirely
      const activeMcps = config.mcps.filter(mcp => {
        if (mcp.disabled) {
          console.info(`MCP "${mcp.id}" is disabled, skipping`)
          return false
        }
        return true
      })

      // Use allSettled so one failed MCP doesn't crash the entire aggregator
      const results = await Promise.allSettled(
        activeMcps.map(async mcp => {
          const client = await _createClient(mcp.connection)
          return [mcp.id, client] as const
        })
      )

      // Collect only successfully connected clients; log failures without crashing
      clients = results.reduce(
        (acc, result, index) => {
          if (result.status === 'fulfilled') {
            const [id, client] = result.value
            // eslint-disable-next-line functional/immutable-data
            acc[id] = client
          } else {
            // Log the failure but don't crash — other MCPs still work
            const failedMcp = activeMcps[index]
            console.error(
              `MCP "${failedMcp?.id ?? 'unknown'}" failed to connect: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
            )
          }
          return acc
        },
        {} as Record<string, Client>
      )
    },
    getTools: async () => {
      toolRouting = {}
      const existingNames = new Set<string>()
      const allTools = await asyncMap(
        Object.entries(clients),
        async ([mcpId, client]) => {
          // Per-client try/catch: one failed listTools() doesn't kill all tool discovery
          // eslint-disable-next-line functional/no-try-statements
          try {
            const tools = await client.listTools().then(x => x.tools)
            // Find the MCP config entry for this client to resolve prefix
            const mcpConfig = config.mcps.find(mcp => mcp.id === mcpId)
            const mcpPrefix = mcpConfig
              ? resolveMcpPrefix(mcpConfig, config.autoPrefix)
              : ''
            const aggPrefix = config.prefix

            return tools.map(tool => {
              const desiredName = composeToolName(
                aggPrefix,
                mcpPrefix,
                tool.name
              )
              const finalName = resolveCollision(desiredName, existingNames)

              if (finalName !== desiredName) {
                console.warn(
                  `Tool name collision: "${tool.name}" from MCP "${mcpId}" would conflict. Renamed to "${finalName}".`
                )
              }

              existingNames.add(finalName)
              // eslint-disable-next-line functional/immutable-data
              toolRouting[finalName] = { client, originalName: tool.name }

              return {
                ...tool,
                name: finalName,
              }
            })
          } catch (error) {
            // Log and return empty array — other clients' tools still collected
            console.error(
              `MCP "${mcpId}" failed to list tools: ${error instanceof Error ? error.message : String(error)}`
            )
            return []
          }
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

      // Find the MCP id for this tool for error reporting
      const mcpId =
        Object.entries(clients).find(([, c]) => c === route.client)?.[0] ??
        'unknown'

      return route.client
        .callTool(
          {
            name: route.originalName,
            arguments: parsedParams as Record<string, unknown> | undefined,
          },
          undefined, // resultSchema (default)
          { timeout: config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS }
        )
        .catch((error: unknown) => {
          // Structured MCP error response — don't crash, report clearly
          const message = error instanceof Error ? error.message : String(error)
          console.error(
            `MCP "${mcpId}" tool "${toolName}" execution failed: ${message}`
          )
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `MCP "${mcpId}" tool "${toolName}" execution failed: ${message}`,
              },
            ],
          }
        })
    },
  }
}

export { create, resolveMcpPrefix, composeToolName, resolveCollision }
export type { AggregatorDeps }
