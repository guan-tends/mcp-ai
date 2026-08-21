import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  resolveMcpPrefix,
  composeToolName,
  resolveCollision,
  create,
} from '../../../src/aggregator/services'
import { McpAggregatorConfig } from '../../../src/common/types'

/**
 * Helper: create a mock MCP Client that simulates the @modelcontextprotocol/sdk Client.
 * Returns an object with stubbed listTools() and callTool() methods.
 */
const createMockClient = (
  tools: Array<{ name: string; description?: string; inputSchema?: any }>,
  callToolResult?: any
) => {
  return {
    listTools: sinon.stub().resolves({ tools, nextCursor: undefined }),
    callTool: sinon.stub().resolves(
      callToolResult ?? {
        content: [{ type: 'text', text: 'ok' }],
      }
    ),
    connect: sinon.stub().resolves(),
    close: sinon.stub().resolves(),
  } as any
}

/**
 * Helper: create a mock client factory for DI into create().
 * Each call returns the next client in the array (or throws if configured).
 */
const createMockClientFactory = (
  clients: Array<any>,
  errors: Array<Error | null> = []
) => {
  let callCount = 0
  return async () => {
    const idx = callCount++
    if (errors[idx]) {
      throw errors[idx]
    }
    return clients[idx] ?? createMockClient([])
  }
}

/**
 * Helper: create a minimal aggregator config with the given MCP entries.
 */
const createConfig = (
  mcps: Array<{
    id: string
    connection: any
    prefix?: string
    disabled?: boolean
  }>,
  extra?: Partial<McpAggregatorConfig>
): McpAggregatorConfig => {
  return {
    mcps,
    server: {
      connection: { type: 'http' as const, url: 'http://localhost:9999' },
    },
    ...extra,
  } as McpAggregatorConfig
}

const CLI_CONNECTION = { type: 'cli' as const, path: 'echo' }

describe('/src/aggregator/services.ts', () => {
  // eslint-disable-next-line functional/no-let
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  // ─── Pure function tests (existing) ──────────────────────────

  describe('#resolveMcpPrefix()', () => {
    it('returns explicit prefix when provided', () => {
      const mcp = { id: 'flux', prefix: 'custom_' }
      const result = resolveMcpPrefix(mcp, true)
      expect(result).to.equal('custom_')
    })

    it('auto-derives prefix from id when autoPrefix is true and no explicit prefix', () => {
      const mcp = { id: 'flux' }
      const result = resolveMcpPrefix(mcp, true)
      expect(result).to.equal('flux_')
    })

    it('returns empty string when autoPrefix is false and no explicit prefix', () => {
      const mcp = { id: 'flux' }
      const result = resolveMcpPrefix(mcp, false)
      expect(result).to.equal('')
    })

    it('returns empty string when autoPrefix is undefined and no explicit prefix', () => {
      const mcp = { id: 'flux' }
      const result = resolveMcpPrefix(mcp)
      expect(result).to.equal('')
    })

    it('uses explicit prefix even when autoPrefix is false', () => {
      const mcp = { id: 'flux', prefix: 'f_' }
      const result = resolveMcpPrefix(mcp, false)
      expect(result).to.equal('f_')
    })

    it('handles empty string explicit prefix (opt-out of autoPrefix)', () => {
      const mcp = { id: 'flux', prefix: '' }
      const result = resolveMcpPrefix(mcp, true)
      expect(result).to.equal('')
    })
  })

  describe('#composeToolName()', () => {
    it('composes with both aggregator and MCP prefix', () => {
      const result = composeToolName('mcp_', 'flux_', 'list_tasks')
      expect(result).to.equal('mcp_flux_list_tasks')
    })

    it('composes with only MCP prefix', () => {
      const result = composeToolName(undefined, 'flux_', 'list_tasks')
      expect(result).to.equal('flux_list_tasks')
    })

    it('composes with only aggregator prefix', () => {
      const result = composeToolName('mcp_', '', 'list_tasks')
      expect(result).to.equal('mcp_list_tasks')
    })

    it('returns original name when no prefixes', () => {
      const result = composeToolName(undefined, '', 'list_tasks')
      expect(result).to.equal('list_tasks')
    })

    it('handles empty string aggregator prefix', () => {
      const result = composeToolName('', 'flux_', 'list_tasks')
      expect(result).to.equal('flux_list_tasks')
    })
  })

  describe('#resolveCollision()', () => {
    it('returns desired name when no collision', () => {
      const existing = new Set<string>(['other_tool'])
      const result = resolveCollision('list_tasks', existing)
      expect(result).to.equal('list_tasks')
    })

    it('appends _2 on first collision', () => {
      const existing = new Set<string>(['list_tasks'])
      const result = resolveCollision('list_tasks', existing)
      expect(result).to.equal('list_tasks_2')
    })

    it('appends _3 when _2 is also taken', () => {
      const existing = new Set<string>(['list_tasks', 'list_tasks_2'])
      const result = resolveCollision('list_tasks', existing)
      expect(result).to.equal('list_tasks_3')
    })

    it('handles multiple collisions incrementing suffix', () => {
      const existing = new Set<string>([
        'list_tasks',
        'list_tasks_2',
        'list_tasks_3',
      ])
      const result = resolveCollision('list_tasks', existing)
      expect(result).to.equal('list_tasks_4')
    })

    it('returns desired name when empty existing set', () => {
      const existing = new Set<string>()
      const result = resolveCollision('any_tool', existing)
      expect(result).to.equal('any_tool')
    })
  })

  // ─── Disabled flag tests ─────────────────────────────────────

  describe('#create() — disabled flag', () => {
    it('skips MCPs with disabled: true during connect', async () => {
      const infoStub = sandbox.stub(console, 'info')

      const mockClient = createMockClient([])
      const factory = createMockClientFactory([mockClient])

      const config = createConfig([
        { id: 'active', connection: CLI_CONNECTION },
        { id: 'inactive', connection: CLI_CONNECTION, disabled: true },
      ])

      const services = create(config, { createClientFn: factory })
      await services.connect()

      // Verify the disabled MCP was logged as skipped
      const disabledLog = infoStub
        .getCalls()
        .find(c => /inactive.*disabled.*skipping/i.test(c.args[0]))
      expect(disabledLog, 'should log disabled MCP as skipped').to.exist

      // Verify the active MCP was NOT logged as disabled
      // Use a precise match — "active" not "inactive" — by checking the exact MCP id at start
      const activeDisabledLog = infoStub
        .getCalls()
        .find(c => /MCP "active" is disabled, skipping/.test(c.args[0]))
      expect(activeDisabledLog, 'should NOT log active MCP as disabled').to.not
        .exist

      // Verify only 1 client connected (the active one)
      // mockClient.listTools was called 0 times so far (connect only)
      // We verify by calling getTools and checking we only got tools from 1 client
      await services.getTools()
      expect(mockClient.listTools.calledOnce).to.be.true
    })

    it('includes MCPs with disabled: false (explicit, treated as active)', async () => {
      const mockClient = createMockClient([{ name: 'tool1' }])
      const factory = createMockClientFactory([mockClient])

      const config = createConfig([
        { id: 'active', connection: CLI_CONNECTION, disabled: false },
      ])

      const services = create(config, { createClientFn: factory })
      await services.connect()
      const tools = await services.getTools()
      expect(tools).to.have.length(1)
      expect(tools[0].name).to.equal('tool1')
    })

    it('includes MCPs with disabled: undefined (default, backward compat)', async () => {
      const mockClient = createMockClient([{ name: 'tool1' }])
      const factory = createMockClientFactory([mockClient])

      const config = createConfig([
        { id: 'active', connection: CLI_CONNECTION },
      ])

      const services = create(config, { createClientFn: factory })
      await services.connect()
      const tools = await services.getTools()
      expect(tools).to.have.length(1)
    })
  })

  // ─── Resilience: connect ─────────────────────────────────────

  describe('#create() — connect resilience', () => {
    it('does not crash when one MCP fails to connect (allSettled)', async () => {
      const errorStub = sandbox.stub(console, 'error')

      const goodClient = createMockClient([{ name: 'good_tool' }])
      // Factory: first call succeeds, second throws
      let callCount = 0
      const factory = async () => {
        if (callCount++ === 1) {
          throw new Error('Connection refused')
        }
        return goodClient
      }

      const config = createConfig([
        { id: 'good', connection: CLI_CONNECTION },
        { id: 'bad', connection: CLI_CONNECTION },
      ])

      const services = create(config, { createClientFn: factory })

      // connect() should NOT throw
      await services.connect()

      // Verify error was logged for the failed MCP
      const errorLog = errorStub
        .getCalls()
        .find(c => /bad.*failed to connect/i.test(c.args[0]))
      expect(errorLog, 'should log failed MCP connection').to.exist

      // Verify the good client's tools are accessible
      const tools = await services.getTools()
      expect(tools).to.have.length(1)
      expect(tools[0].name).to.equal('good_tool')
    })

    it('connects successfully when all MCPs are healthy', async () => {
      sandbox.stub(console, 'info')

      const client1 = createMockClient([{ name: 'tool_a' }])
      const client2 = createMockClient([{ name: 'tool_b' }])
      const factory = createMockClientFactory([client1, client2])

      const config = createConfig([
        { id: 'mcp1', connection: CLI_CONNECTION },
        { id: 'mcp2', connection: CLI_CONNECTION },
      ])

      const services = create(config, { createClientFn: factory })
      await services.connect()
      const tools = await services.getTools()
      expect(tools).to.have.length(2)
      expect(tools[0].name).to.equal('tool_a')
      expect(tools[1].name).to.equal('tool_b')
    })

    it('logs nothing when no MCPs are disabled', async () => {
      const infoStub = sandbox.stub(console, 'info')

      const mockClient = createMockClient([])
      const factory = createMockClientFactory([mockClient])

      const config = createConfig([{ id: 'mcp1', connection: CLI_CONNECTION }])

      const services = create(config, { createClientFn: factory })
      await services.connect()

      const skipLog = infoStub
        .getCalls()
        .find(c => /disabled.*skipping/i.test(c.args[0]))
      expect(skipLog, 'should not log any disabled skips').to.not.exist
    })
  })

  // ─── Resilience: getTools ────────────────────────────────────

  describe('#create() — getTools resilience', () => {
    it('returns tools from healthy MCPs even when one listTools() fails', async () => {
      sandbox.stub(console, 'info')
      const errorStub = sandbox.stub(console, 'error')

      const goodClient = createMockClient([{ name: 'good_tool' }])
      const badClient = {
        listTools: sinon.stub().rejects(new Error('listTools failed')),
        callTool: sinon.stub(),
        connect: sinon.stub().resolves(),
        close: sinon.stub().resolves(),
      } as any

      const factory = createMockClientFactory([goodClient, badClient])

      const config = createConfig([
        { id: 'good', connection: CLI_CONNECTION },
        { id: 'bad', connection: CLI_CONNECTION },
      ])

      const services = create(config, { createClientFn: factory })
      await services.connect()
      const tools = await services.getTools()

      // Only good_client's tools returned
      expect(tools).to.have.length(1)
      expect(tools[0].name).to.equal('good_tool')

      // Error was logged
      const errorLog = errorStub
        .getCalls()
        .find(c => /bad.*failed to list tools/i.test(c.args[0]))
      expect(errorLog, 'should log failed listTools').to.exist
    })

    it('returns empty array when all clients fail listTools()', async () => {
      sandbox.stub(console, 'info')
      sandbox.stub(console, 'error')

      const badClient = {
        listTools: sinon.stub().rejects(new Error('listTools failed')),
        callTool: sinon.stub(),
        connect: sinon.stub().resolves(),
        close: sinon.stub().resolves(),
      } as any

      const factory = createMockClientFactory([badClient])

      const config = createConfig([{ id: 'bad1', connection: CLI_CONNECTION }])

      const services = create(config, { createClientFn: factory })
      await services.connect()
      const tools = await services.getTools()
      expect(tools).to.have.length(0)
    })
  })

  // ─── Resilience: executeTool ─────────────────────────────────

  describe('#create() — executeTool resilience', () => {
    it('returns structured error when callTool() fails instead of crashing', async () => {
      sandbox.stub(console, 'info')
      sandbox.stub(console, 'error')

      const failClient = {
        listTools: sinon.stub().resolves({
          tools: [{ name: 'failing_tool' }],
          nextCursor: undefined,
        }),
        callTool: sinon.stub().rejects(new Error('Tool execution error')),
        connect: sinon.stub().resolves(),
        close: sinon.stub().resolves(),
      } as any

      const factory = createMockClientFactory([failClient])

      const config = createConfig([
        { id: 'failing', connection: CLI_CONNECTION },
      ])

      const services = create(config, { createClientFn: factory })
      await services.connect()
      await services.getTools()

      const result = (await services.executeTool('failing_tool', {})) as any
      expect(result).to.have.property('isError', true)
      expect(result.content).to.exist
      expect(result.content[0].type).to.equal('text')
      expect(result.content[0].text).to.include('failing_tool')
      expect(result.content[0].text).to.include('Tool execution error')
    })

    it('returns result normally when callTool succeeds', async () => {
      sandbox.stub(console, 'info')
      sandbox.stub(console, 'error')

      const goodClient = createMockClient([{ name: 'good_tool' }], {
        content: [{ type: 'text', text: 'success result' }],
      })
      const factory = createMockClientFactory([goodClient])

      const config = createConfig([{ id: 'good', connection: CLI_CONNECTION }])

      const services = create(config, { createClientFn: factory })
      await services.connect()
      await services.getTools()

      const result = (await services.executeTool('good_tool', {})) as any
      expect(result.content[0].text).to.equal('success result')
    })

    it('throws for unknown tool name', async () => {
      sandbox.stub(console, 'info')
      sandbox.stub(console, 'error')

      const mockClient = createMockClient([])
      const factory = createMockClientFactory([mockClient])

      const config = createConfig([{ id: 'mcp1', connection: CLI_CONNECTION }])

      const services = create(config, { createClientFn: factory })
      await services.connect()

      // eslint-disable-next-line functional/no-try-statements
      try {
        await services.executeTool('nonexistent_tool', {})
        expect.fail('should have thrown for unknown tool')
      } catch (e: any) {
        expect(e.message).to.include('Unknown tool')
      }
    })
  })
})
