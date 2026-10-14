import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}

  async create() {
    return this.session
  }

  maybeGet(sessionId: string) {
    if (sessionId !== this.session.sessionId) return undefined
    return this.session
  }

  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) {
      throw new Error(`Unknown sessionId: ${sessionId}`)
    }
    return this.session
  }
}

test('PiAcpAgent: newSession returns configOptions for model and thinking selectors', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return {
            models: [
              { provider: 'test', id: 'alpha', name: 'Alpha' },
              { provider: 'test', id: 'beta', name: 'Beta' }
            ]
          }
        },
        async getState() {
          return {
            thinkingLevel: 'high',
            model: { provider: 'test', id: 'beta' }
          }
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    assert.equal(result.models?.currentModelId, 'test/beta')
    assert.equal(result.modes?.currentModeId, 'high')
    assert.deepEqual(result.configOptions, [
      {
        type: 'select',
        id: 'model',
        category: 'model',
        name: 'Model',
        description: 'Select the model for this session',
        currentValue: 'test/beta',
        options: [
          { value: 'test/alpha', name: 'test/Alpha', description: null },
          { value: 'test/beta', name: 'test/Beta', description: null }
        ]
      },
      {
        type: 'select',
        id: 'thought_level',
        category: 'thought_level',
        name: 'Thinking',
        description: 'Set the reasoning effort for this session',
        currentValue: 'high',
        options: [
          { value: 'off', name: 'Thinking: off', description: null },
          { value: 'minimal', name: 'Thinking: minimal', description: null },
          { value: 'low', name: 'Thinking: low', description: null },
          { value: 'medium', name: 'Thinking: medium', description: null },
          { value: 'high', name: 'Thinking: high', description: null },
          { value: 'xhigh', name: 'Thinking: xhigh', description: null },
          { value: 'max', name: 'Thinking: max', description: null }
        ]
      }
    ])
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})

test('PiAcpAgent: setSessionConfigOption maps model changes to pi and emits config_option_update', async () => {
  const conn = new FakeAgentSideConnection()
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  const setModelCalls: Array<{ provider: string; modelId: string }> = []

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return {
          models: [
            { provider: 'test', id: 'alpha', name: 'Alpha' },
            { provider: 'test', id: 'beta', name: 'Beta' }
          ]
        }
      },
      async getState() {
        return state
      },
      async setModel(provider: string, modelId: string) {
        setModelCalls.push({ provider, modelId })
        state.model = { provider, id: modelId }
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'model',
    value: 'test/beta'
  } as any)

  assert.deepEqual(setModelCalls, [{ provider: 'test', modelId: 'beta' }])
  assert.equal(result.configOptions.find(option => option.id === 'model')?.currentValue, 'test/beta')
  assert.deepEqual(conn.updates, [
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: result.configOptions
      }
    }
  ])
})

test('PiAcpAgent: setSessionConfigOption maps thought level changes to pi and emits sync updates', async () => {
  const conn = new FakeAgentSideConnection()
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  const thinkingLevels: string[] = []

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return {
          models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }]
        }
      },
      async getState() {
        return state
      },
      async setThinkingLevel(level: string) {
        thinkingLevels.push(level)
        state.thinkingLevel = level
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'thought_level',
    value: 'xhigh'
  } as any)

  assert.deepEqual(thinkingLevels, ['xhigh'])
  assert.equal(result.configOptions.find(option => option.id === 'thought_level')?.currentValue, 'xhigh')
  assert.deepEqual(conn.updates, [
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'xhigh'
      }
    },
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: result.configOptions
      }
    }
  ])
})

function thinkingOption(configOptions: any[]) {
  return configOptions.find(option => option.id === 'thought_level')
}

test('PiAcpAgent: thinking selector advertises the levels pi reports for the current model', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'fireworks', id: 'glm', name: 'GLM' }] }
        },
        async getState() {
          return { thinkingLevel: 'max', model: { provider: 'fireworks', id: 'glm' } }
        },
        async getAvailableThinkingLevels() {
          return ['low', 'high', 'max']
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    assert.equal(result.modes?.currentModeId, 'max')
    assert.deepEqual(
      result.modes?.availableModes.map(mode => mode.id),
      ['low', 'high', 'max']
    )
    const option = thinkingOption(result.configOptions ?? [])
    assert.equal(option.currentValue, 'max')
    assert.deepEqual(option.options, [
      { value: 'low', name: 'Thinking: low', description: null },
      { value: 'high', name: 'Thinking: high', description: null },
      { value: 'max', name: 'Thinking: max', description: null }
    ])
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})

test('PiAcpAgent: thinking levels fall back to the model thinkingLevelMap when pi lacks the RPC command', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'baseten', id: 'glm', name: 'GLM' }] }
        },
        async getState() {
          return {
            thinkingLevel: 'high',
            model: {
              provider: 'baseten',
              id: 'glm',
              reasoning: true,
              thinkingLevelMap: { off: null, minimal: 'minimal', xhigh: 'xhigh', max: 'max' }
            }
          }
        },
        async getAvailableThinkingLevels() {
          throw new Error('pi get_available_thinking_levels failed: Unknown command: get_available_thinking_levels')
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    assert.deepEqual(
      thinkingOption(result.configOptions ?? []).options.map((option: any) => option.value),
      ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    )
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})

test('PiAcpAgent: setSessionConfigOption passes max through to pi unchanged', async () => {
  const conn = new FakeAgentSideConnection()
  const state = { thinkingLevel: 'high', model: { provider: 'fireworks', id: 'glm' } }
  const thinkingLevels: string[] = []

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'fireworks', id: 'glm', name: 'GLM' }] }
      },
      async getState() {
        return state
      },
      async getAvailableThinkingLevels() {
        return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      },
      async setThinkingLevel(level: string) {
        thinkingLevels.push(level)
        state.thinkingLevel = level
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'thought_level',
    value: 'max'
  } as any)

  assert.deepEqual(thinkingLevels, ['max'])
  assert.equal(thinkingOption(result.configOptions).currentValue, 'max')
  assert.deepEqual(conn.updates[0], {
    sessionId: 's1',
    update: { sessionUpdate: 'current_mode_update', currentModeId: 'max' }
  })
})

test('PiAcpAgent: a level the model lacks reports the level pi clamped it to', async () => {
  const conn = new FakeAgentSideConnection()
  const state = { thinkingLevel: 'high', model: { provider: 'fireworks', id: 'glm' } }
  const supported = ['low', 'high', 'max']

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'fireworks', id: 'glm', name: 'GLM' }] }
      },
      async getState() {
        return state
      },
      async getAvailableThinkingLevels() {
        return supported
      },
      async setThinkingLevel(level: string) {
        // pi clamps xhigh up to the next supported level.
        state.thinkingLevel = supported.includes(level) ? level : 'max'
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'thought_level',
    value: 'xhigh'
  } as any)

  assert.equal(thinkingOption(result.configOptions).currentValue, 'max')
  assert.deepEqual(conn.updates, [
    { sessionId: 's1', update: { sessionUpdate: 'current_mode_update', currentModeId: 'max' } },
    { sessionId: 's1', update: { sessionUpdate: 'config_option_update', configOptions: result.configOptions } }
  ])
})

test('PiAcpAgent: switching model re-advertises that model thinking levels', async () => {
  const conn = new FakeAgentSideConnection()
  const levelsByModel: Record<string, string[]> = {
    'test/alpha': ['off', 'minimal', 'low', 'medium', 'high'],
    'test/glm': ['low', 'high', 'max']
  }
  const state = { thinkingLevel: 'medium', model: { provider: 'test', id: 'alpha' } }

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return {
          models: [
            { provider: 'test', id: 'alpha', name: 'Alpha' },
            { provider: 'test', id: 'glm', name: 'GLM' }
          ]
        }
      },
      async getState() {
        return state
      },
      async getAvailableThinkingLevels() {
        return levelsByModel[`${state.model.provider}/${state.model.id}`]
      },
      async setModel(provider: string, modelId: string) {
        state.model = { provider, id: modelId }
        state.thinkingLevel = 'high'
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'model',
    value: 'test/glm'
  } as any)

  const option = thinkingOption(result.configOptions)
  assert.equal(option.currentValue, 'high')
  assert.deepEqual(
    option.options.map((o: any) => o.value),
    ['low', 'high', 'max']
  )
})

test('PiAcpAgent: setSessionConfigOption rejects names outside pi thinking vocabulary', async () => {
  const conn = new FakeAgentSideConnection()
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async setThinkingLevel() {
        throw new Error('should not be called')
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  await assert.rejects(
    () => agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'ultra' } as any),
    /invalid params/i
  )
})
