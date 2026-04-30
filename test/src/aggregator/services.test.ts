import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  resolveMcpPrefix,
  composeToolName,
  resolveCollision,
} from '../../../src/aggregator/services'

describe('/src/aggregator/services.ts', () => {
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
})