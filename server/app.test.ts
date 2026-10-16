import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp, type DemoService } from './app.js'

const state = {
  status: 'active' as const,
  contractId: '006f-holding',
  synchronizer: 'private-sync' as const,
  synchronizerId: 'private-sync::id',
  reassignmentCounter: 3,
  holding: {
    owner: 'Alice::id',
    admin: 'RegistryAdmin::id',
    instrumentId: 'HSKD',
    amount: '100.0000000000',
  },
  parties: { alice: 'Alice::id', admin: 'RegistryAdmin::id' },
  synchronizers: {
    global: 'global-sync::id',
    private: 'private-sync::id',
  },
}

const catalog = {
  synchronizers: {
    'global-sync': {
      id: 'global-sync::id',
      parties: [{ id: 'Alice::id', hint: 'Alice' }],
    },
    'private-sync': {
      id: 'private-sync::id',
      parties: [
        { id: 'Alice::id', hint: 'Alice' },
        { id: 'Bob::id', hint: 'Bob' },
      ],
    },
  },
}

const acs = {
  synchronizer: 'private-sync',
  synchronizerId: 'private-sync::id',
  party: { id: 'Bob::id', hint: 'Bob' },
  offset: 12,
  contracts: [],
}

function service(overrides: Partial<DemoService> = {}): DemoService {
  return {
    getState: async () => state,
    getPartyCatalog: async () => catalog,
    getAcs: async () => acs,
    transfer: async () => ({ updateId: 'transfer-update' }),
    actOnTransferInstruction: async (input) => ({
      updateId: 'instruction-update',
      action: input.action,
    }),
    updateWhitelist: async () => ({ policyUpdateId: 'policy-update' }),
    refreshVisibility: async () => ({ updateId: 'refresh-update' }),
    issue: async () => ({ updateId: 'issue-update', synchronizer: 'global-sync' }),
    actOnIssuance: async (input) => ({
      updateId: 'issuance-update',
      action: input.action,
    }),
    reassign: async () => ({
      source: 'global-sync',
      target: 'private-sync',
      reassignmentId: 'reassignment-1',
      updateId: 'assign-update',
      automatic: false,
    }),
    ...overrides,
  }
}

describe('demo API', () => {
  it('returns normalized Holding state', async () => {
    const response = await request(createApp(service())).get('/api/state')
    expect(response.status).toBe(200)
    expect(response.body).toEqual(state)
  })

  it('issues and reassigns using the selected Party identity', async () => {
    const issues: unknown[] = []
    const reassignments: unknown[] = []
    const app = createApp(
      service({
        issue: async (input) => {
          issues.push(input)
          return { updateId: 'issue-update' }
        },
        reassign: async (input) => {
          reassignments.push(input)
          return {
            source: 'global-sync',
            target: 'private-sync',
            reassignmentId: 'reassignment-1',
          }
        },
      }),
    )
    const issue = await request(app)
      .post('/api/issue')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({
        actor: 'RegistryAdmin::id',
        receiver: 'Bob::id',
        amount: '42.125',
      })
    const reassign = await request(app)
      .post('/api/reassign')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({
        synchronizer: 'global-sync',
        actor: 'Alice::id',
        contractId: 'holding-1',
      })

    expect(issue.status).toBe(200)
    expect(issue.body.updateId).toBe('issue-update')
    expect(reassign.status).toBe(200)
    expect(reassign.body.reassignmentId).toBe('reassignment-1')
    expect(issues).toEqual([{
      actor: 'RegistryAdmin::id',
      receiver: 'Bob::id',
      amount: '42.125',
    }])
    expect(reassignments).toEqual([
      {
        synchronizer: 'global-sync',
        actor: 'Alice::id',
        contractId: 'holding-1',
      },
    ])
  })

  it('rejects issue and reassignment requests without a Party identity', async () => {
    const app = createApp(service())
    const issue = await request(app)
      .post('/api/issue')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({})
    const reassign = await request(app)
      .post('/api/reassign')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({})

    expect(issue.status).toBe(400)
    expect(reassign.status).toBe(400)
  })

  it.each([
    '0',
    '-1',
    '1e3',
    'NaN',
    'Infinity',
    '1.12345678901',
    '12345678901234567890123456789',
  ])('rejects invalid issuance amount %s', async (amount) => {
    const response = await request(createApp(service()))
      .post('/api/issue')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({
        actor: 'RegistryAdmin::id',
        receiver: 'Alice::id',
        amount,
      })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('Invalid request parameters')
  })

  it('returns a safe error without a stack trace', async () => {
    const app = createApp(
      service({
        reassign: async () => {
          throw new Error('A reassignment is already in progress. Refresh and retry.')
        },
      }),
    )
    const response = await request(app)
      .post('/api/reassign')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({
        synchronizer: 'global-sync',
        actor: 'Alice::id',
        contractId: 'holding-1',
      })

    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      error: 'A reassignment is already in progress. Refresh and retry.',
    })
    expect(JSON.stringify(response.body)).not.toContain('stack')
  })

  it('rejects cross-site mutation requests', async () => {
    const response = await request(createApp(service()))
      .post('/api/reassign')
      .set('Origin', 'https://evil.example')
      .send({
        synchronizer: 'global-sync',
        actor: 'Alice::id',
        contractId: 'holding-1',
      })

    expect(response.status).toBe(403)
    expect(response.body).toEqual({
      error: 'Rejected a mutating request from a non-local origin',
    })
  })

  it('reports upstream availability failures as bad gateway', async () => {
    const response = await request(
      createApp(
        service({
          getState: async () => {
            throw new Error('fetch failed')
          },
        }),
      ),
    ).get('/api/state')

    expect(response.status).toBe(502)
  })

  it('returns the party catalog and a filtered ACS snapshot', async () => {
    const seen: Array<{ synchronizer: string; party: string }> = []
    const app = createApp(
      service({
        getAcs: async (query) => {
          seen.push(query)
          return acs
        },
      }),
    )

    const catalogResponse = await request(app).get('/api/party-catalog')
    const acsResponse = await request(app).get(
      '/api/acs?sync=private-sync&party=Bob%3A%3Aid',
    )

    expect(catalogResponse.status).toBe(200)
    expect(catalogResponse.body).toEqual(catalog)
    expect(acsResponse.status).toBe(200)
    expect(acsResponse.body).toEqual(acs)
    expect(seen).toEqual([
      { synchronizer: 'private-sync', party: 'Bob::id' },
    ])
  })

  it('rejects ACS requests with missing or invalid query parameters', async () => {
    const response = await request(createApp(service())).get('/api/acs')

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      error: 'Provide a valid synchronizer and party',
    })
  })

  it('routes party-scoped transfer and instruction actions', async () => {
    const transfers: unknown[] = []
    const instructions: unknown[] = []
    const app = createApp(
      service({
        transfer: async (input) => {
          transfers.push(input)
          return { updateId: 'transfer-update' }
        },
        actOnTransferInstruction: async (input) => {
          instructions.push(input)
          return { updateId: 'instruction-update', action: input.action }
        },
      }),
    )

    const transferResponse = await request(app)
      .post('/api/transfer')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({
        synchronizer: 'global-sync',
        actor: 'Alice::id',
        contractId: 'holding-1',
        receiver: 'Bob::id',
      })
    const acceptResponse = await request(app)
      .post('/api/transfer-instruction')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({
        synchronizer: 'global-sync',
        actor: 'Bob::id',
        contractId: 'instruction-1',
        action: 'accept',
      })

    expect(transferResponse.status).toBe(200)
    expect(acceptResponse.status).toBe(200)
    expect(transfers).toEqual([
      {
        synchronizer: 'global-sync',
        actor: 'Alice::id',
        contractId: 'holding-1',
        receiver: 'Bob::id',
      },
    ])
    expect(instructions).toEqual([
      {
        synchronizer: 'global-sync',
        actor: 'Bob::id',
        contractId: 'instruction-1',
        action: 'accept',
      },
    ])
  })

  it('rejects malformed mutation bodies before calling the Ledger API', async () => {
    const response = await request(createApp(service()))
      .post('/api/transfer')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({
        synchronizer: 'global-sync',
        actor: '',
        contractId: 'holding-1',
        receiver: 'Bob::id',
      })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('Invalid request parameters')
  })

  it('reports Party authorization failures as forbidden', async () => {
    const response = await request(
      createApp(
        service({
          transfer: async () => {
            throw new Error('Only the Holding owner can start a transfer')
          },
        }),
      ),
    )
      .post('/api/transfer')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({
        synchronizer: 'global-sync',
        actor: 'Bob::id',
        contractId: 'holding-1',
        receiver: 'Alice::id',
      })

    expect(response.status).toBe(403)
  })

  it('reports non-RegistryAdmin issuance as forbidden', async () => {
    const response = await request(
      createApp(
        service({
          issue: async () => {
            throw new Error('Only RegistryAdmin can issue a Holding')
          },
        }),
      ),
    )
      .post('/api/issue')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({
        actor: 'Alice::id',
        receiver: 'Alice::id',
        amount: '10',
      })

    expect(response.status).toBe(403)
    expect(response.body.error).toBe('Only RegistryAdmin can issue a Holding')
  })
})
