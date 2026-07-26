/**
 * Pins the node-type catalogue helpers used by the Inspector + canvas.
 * Adding a new node type means extending the runtime union, the preset map,
 * the display map, and the config-summary helper — these tests catch the
 * cases where one of those forgets to land.
 */
import { describe, expect, it } from 'vitest'
import { formatCompactDuration, nodePresets, nodeTypes, getNodeLabel, getNodeHelper, getNodeConfigSummary, getNodePreset } from './constants'
import { changeAppLanguage } from './i18n'

describe('run metadata formatting', () => {
  it('formats dense durations without noisy zero units', () => {
    expect(formatCompactDuration(250)).toBe('250ms')
    expect(formatCompactDuration(1_250)).toBe('1s')
    expect(formatCompactDuration(62_000)).toBe('1m 2s')
    expect(formatCompactDuration(3_720_000)).toBe('1h 2m')
  })
})

describe('node-type catalogue', () => {
  it('declares parallel_fork and join in the preset map and ordered list', () => {
    expect(nodePresets.parallel_fork).toEqual({ branches: [{ label: 'a' }, { label: 'b' }] })
    expect(nodePresets.join).toEqual({ sources: { a: '', b: '' } })
    expect(nodeTypes).toContain('parallel_fork')
    expect(nodeTypes).toContain('join')
  })

  it('exposes display labels and helpers for parallel_fork / join', () => {
    expect(getNodeLabel('parallel_fork')).toBe('Fan out')
    expect(getNodeLabel('join')).toBe('Merge branches')
    expect(getNodeHelper('parallel_fork')).toBe('Run named branches in parallel')
    expect(getNodeHelper('join')).toBe('Gather labelled outputs from a fan-out')
  })

  describe('getNodeConfigSummary', () => {
    it('surfaces an exact subworkflow version pin', () => {
      expect(getNodeConfigSummary('subworkflow', { workflowId: 'child-flow', version: 3 }))
        .toBe('child-flow · v3')
      expect(getNodeConfigSummary('subworkflow', { workflowId: 'child-flow', version: 2_147_483_647 }))
        .toBe('child-flow · v2147483647')
      expect(getNodeConfigSummary('subworkflow', { workflowId: 'child-flow' })).toBe('child-flow')
    })

    it('does not present an out-of-range subworkflow version as an active pin', () => {
      expect(getNodeConfigSummary('subworkflow', { workflowId: 'child-flow', version: 2_147_483_648 }))
        .toBe('child-flow')
    })

    it('summarises the executable loop mode by tool and bounded concurrency', () => {
      expect(getNodeConfigSummary('loop', {
        mode: 'for_each',
        tool: 'json.parse',
        concurrency: 8,
      })).toBe('json.parse for each item · 8 concurrent calls')
      expect(getNodeConfigSummary('loop', {
        mode: 'for_each',
        tool: 'text.uppercase',
      })).toBe('text.uppercase for each item · 4 concurrent calls')
      expect(getNodeConfigSummary('loop', {
        mode: 'for_each',
        tool: 'json.parse',
        concurrency: 1,
      })).toBe('json.parse for each item · 1 concurrent call')
    })

    it('summarises parallel_fork by branch count', () => {
      expect(getNodeConfigSummary('parallel_fork', { branches: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }))
        .toBe('3 branches')
      expect(getNodeConfigSummary('parallel_fork', { branches: [{ label: 'only' }] }))
        .toBe('1 branch')
    })

    it('prompts the operator when parallel_fork has no branches yet', () => {
      expect(getNodeConfigSummary('parallel_fork', {})).toBe('Add at least 2 branches')
      expect(getNodeConfigSummary('parallel_fork', { branches: [] })).toBe('Add at least 2 branches')
    })

    it('summarises join by source count', () => {
      expect(getNodeConfigSummary('join', { sources: { a: 'http_a', b: 'http_b' } }))
        .toBe('Merging 2 branches')
      expect(getNodeConfigSummary('join', { sources: { a: 'only_one' } }))
        .toBe('Merging 1 branch')
    })

    it('prompts the operator when join sources are empty / missing', () => {
      expect(getNodeConfigSummary('join', {})).toBe('Map branches to predecessor nodes')
      expect(getNodeConfigSummary('join', { sources: {} })).toBe('Map branches to predecessor nodes')
    })

    it('ignores a non-object sources value defensively', () => {
      expect(getNodeConfigSummary('join', { sources: 'oops' })).toBe('Map branches to predecessor nodes')
      expect(getNodeConfigSummary('join', { sources: ['a', 'b'] })).toBe('Map branches to predecessor nodes')
    })
  })

  describe('schedule node type', () => {
    it('declares schedule in the preset map and ordered list', () => {
      expect(nodePresets.schedule).toEqual({ cronExpression: '0 9 * * *', enabled: true })
      expect(nodeTypes).toContain('schedule')
    })

    it('exposes display label + helper', () => {
      expect(getNodeLabel('schedule')).toBe('Schedule')
      expect(getNodeHelper('schedule')).toBe('Trigger this workflow on a cron schedule')
    })

    it('summarises schedule by cron expression and paused flag', () => {
      expect(getNodeConfigSummary('schedule', { cronExpression: '0 9 * * *', enabled: true })).toBe('0 9 * * *')
      expect(getNodeConfigSummary('schedule', { cronExpression: '*/5 * * * *', enabled: false }))
        .toBe('*/5 * * * * (paused)')
    })

    it('prompts the operator when cron is missing', () => {
      expect(getNodeConfigSummary('schedule', {})).toBe('Set a cron expression')
      expect(getNodeConfigSummary('schedule', { cronExpression: '' })).toBe('Set a cron expression')
    })
  })

  describe('webhook_received node type', () => {
    it('declares a safe empty preset and localized authoring copy', () => {
      expect(nodePresets.webhook_received).toEqual({ endpointKey: '' })
      expect(nodeTypes).toContain('webhook_received')
      expect(getNodeLabel('webhook_received')).toBe('Inbound webhook')
      expect(getNodeHelper('webhook_received')).toBe('Start this workflow from an authenticated JSON event')
    })

    it('summarises the endpoint selector', () => {
      expect(getNodeConfigSummary('webhook_received', {})).toBe('Set an endpoint key')
      expect(getNodeConfigSummary('webhook_received', { endpointKey: 'incident-triage' }))
        .toBe('Endpoint: incident-triage')
    })
  })

  describe('human_form node type', () => {
    it('declares a usable default form preset', () => {
      expect(nodeTypes).toContain('human_form')
      expect(getNodePreset('human_form')).toMatchObject({
        title: 'Collect request details',
        schema: {
          type: 'object',
          required: ['requester', 'reason'],
        },
      })
    })

    it('exposes display label, helper, and summary', () => {
      expect(getNodeLabel('human_form')).toBe('Collect form')
      expect(getNodeHelper('human_form')).toBe('Pause for structured input')
      expect(getNodeConfigSummary('human_form', { title: 'Access review' })).toBe('Access review')
      expect(getNodeConfigSummary('human_form', {})).toBe('Add form fields')
    })

    it('localizes seeded node defaults through the active locale', () => {
      changeAppLanguage('es')

      expect(getNodePreset('approval')).toEqual({ message: 'Aprueba este paso del flujo.' })
      expect(getNodePreset('human_form')).toMatchObject({
        title: 'Recolectar detalles de la solicitud',
        schema: {
          properties: {
            requester: { description: '¿Sobre quién es esto?' },
          },
        },
      })
    })
  })
})
