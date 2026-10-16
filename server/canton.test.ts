import { describe, expect, it } from 'vitest'
import {
  CantonClient,
  type CantonTransport,
  type LedgerRequest,
} from './canton.js'
import type { SinglePartyCommand } from './custody/submit.js'

const ALICE = 'Alice::alice-namespace'
const ADMIN = 'RegistryAdmin::admin-namespace'
const BOB = 'Bob::bob-namespace'
const CAROL = 'Carol::carol-namespace'
const GLOBAL = 'global-sync::global-id'
const PRIVATE = 'private-sync::private-id'
const CONTRACT_ID = '006f-holding'
const SECOND_CONTRACT_ID = '00second-holding'

function fixtureTransport(
  handler: (request: LedgerRequest) => unknown | Promise<unknown>,
): CantonTransport {
  return { request: handler }
}

function recordSubmit(updateId: string, sink: SinglePartyCommand[]) {
  return async (_transport: CantonTransport, command: SinglePartyCommand) => {
    sink.push(command)
    return { updateId }
  }
}

describe('CantonClient', () => {
  it('reads a CIP-56 Holding interface view and its synchronizer', async () => {
    let activeContractsRequest: LedgerRequest | undefined
    const transport = fixtureTransport((request) => {
      const { path } = request
      if (path === '/v2/parties') {
        return {
          partyDetails: [
            { party: ALICE, isLocal: true },
            { party: ADMIN, isLocal: true },
          ],
        }
      }
      if (path === '/v2/state/ledger-end') return { offset: 42 }
      if (path === '/v2/state/connected-synchronizers') {
        return {
          connectedSynchronizers: [
            { synchronizerAlias: 'global-sync', synchronizerId: GLOBAL },
            { synchronizerAlias: 'private-sync', synchronizerId: PRIVATE },
          ],
        }
      }
      if (path === '/v2/state/active-contracts') {
        activeContractsRequest = request
        return [
          {
            contractEntry: {
              JsActiveContract: {
                createdEvent: {
                  contractId: CONTRACT_ID,
                  interfaceViews: [
                    {
                      interfaceId: 'pkg:Splice.Api.Token.HoldingV1:Holding',
                      viewStatus: { code: 0 },
                      viewValue: {
                        owner: ALICE,
                        instrumentId: { admin: ADMIN, id: 'HSKD' },
                        amount: '100.0000000000',
                        lock: null,
                        meta: { values: {} },
                      },
                    },
                  ],
                },
                synchronizerId: PRIVATE,
                reassignmentCounter: 3,
              },
            },
          },
          {
            contractEntry: {
              JsActiveContract: {
                createdEvent: {
                  contractId: SECOND_CONTRACT_ID,
                  interfaceViews: [
                    {
                      interfaceId: 'pkg:Splice.Api.Token.HoldingV1:Holding',
                      viewStatus: { code: 0 },
                      viewValue: {
                        owner: BOB,
                        instrumentId: { admin: ADMIN, id: 'HSKD' },
                        amount: '50.0000000000',
                        lock: { lockId: 'transfer-lock' },
                        meta: { values: {} },
                      },
                    },
                  ],
                },
                synchronizerId: GLOBAL,
                reassignmentCounter: 0,
              },
            },
          },
        ]
      }
      throw new Error(`unexpected request: ${path}`)
    })

    const state = await new CantonClient(transport).getState()

    expect(state).toMatchObject({
      status: 'active',
      contractId: CONTRACT_ID,
      synchronizer: 'private-sync',
      reassignmentCounter: 3,
      holding: {
        owner: ALICE,
        admin: ADMIN,
        instrumentId: 'HSKD',
        amount: '100.0000000000',
        locked: false,
      },
      holdings: [
        {
          contractId: CONTRACT_ID,
          owner: ALICE,
          admin: ADMIN,
          instrumentId: 'HSKD',
          amount: '100.0000000000',
          locked: false,
          synchronizer: 'private-sync',
          reassignmentCounter: 3,
        },
        {
          contractId: SECOND_CONTRACT_ID,
          owner: BOB,
          admin: ADMIN,
          instrumentId: 'HSKD',
          amount: '50.0000000000',
          locked: true,
          synchronizer: 'global-sync',
          reassignmentCounter: 0,
        },
      ],
    })
    expect(activeContractsRequest?.body).toMatchObject({
      eventFormat: {
        filtersByParty: {
          [ADMIN]: expect.any(Object),
        },
      },
    })
  })

  it('allows RegistryAdmin to issue when an active Holding already exists', async () => {
    const submitted: SinglePartyCommand[] = []
    const transport = fixtureTransport((request) => {
      throw new Error(`unexpected request: ${request.path}`)
    })
    const client = new CantonClient(transport, {
      submitCommand: recordSubmit('issue-update', submitted),
    })
    client.getState = async () => ({
      status: 'active',
      contractId: CONTRACT_ID,
      synchronizer: 'private-sync',
      synchronizerId: PRIVATE,
      reassignmentCounter: 0,
      holding: {
        owner: ALICE,
        admin: ADMIN,
        instrumentId: 'HSKD',
        amount: '100.0000000000',
      },
      parties: { alice: ALICE, admin: ADMIN },
      synchronizers: { global: GLOBAL, private: PRIVATE },
    })
    client.getAcs = async () => ({
      synchronizer: 'global-sync',
      synchronizerId: GLOBAL,
      party: { id: ADMIN, hint: 'RegistryAdmin' },
      offset: 1,
      contracts: [
        {
          contractId: 'policy-1',
          templateId: '#simple-token:SimpleToken.Visibility:VisibilityPolicy',
          status: 'active',
          synchronizerId: GLOBAL,
          reassignmentCounter: 0,
          signatories: [ADMIN],
          observers: [ALICE, BOB],
          createArgument: {
            observers: [BOB],
            version: 2,
          },
        },
        {
          contractId: 'rules-1',
          templateId: '#simple-token:SimpleToken.Rules:SimpleTokenRules',
          status: 'active',
          synchronizerId: GLOBAL,
          reassignmentCounter: 0,
          signatories: [ADMIN],
          observers: [],
          createArgument: {},
        },
      ],
    })
    client.getPartyCatalog = async () => ({
      synchronizers: {
        'global-sync': {
          id: GLOBAL,
          parties: [
            { id: ADMIN, hint: 'RegistryAdmin' },
            { id: ALICE, hint: 'Alice' },
            { id: BOB, hint: 'Bob' },
          ],
        },
        'private-sync': { id: PRIVATE, parties: [] },
      },
    })

    const result = await client.issue({
      actor: ADMIN,
      receiver: BOB,
      amount: '42.125',
    })

    expect(result.updateId).toBe('issue-update')
    expect(submitted[0]).toMatchObject({
      actAs: ADMIN,
      commands: [
        {
          ExerciseCommand: {
            templateId: '#simple-token:SimpleToken.Rules:SimpleTokenRules',
            contractId: 'rules-1',
            choice: 'SimpleTokenRules_Issue',
            choiceArgument: {
              owner: BOB,
              instrumentId: { admin: ADMIN, id: 'HSKD' },
              amount: '42.125',
            },
          },
        },
      ],
    })
  })

  it('allows only RegistryAdmin to issue a Holding', async () => {
    const client = new CantonClient(fixtureTransport(() => ({})))
    client.getState = async () => ({
      status: 'not-issued',
      parties: { alice: ALICE, admin: ADMIN },
      synchronizers: { global: GLOBAL, private: PRIVATE },
    })

    await expect(client.issue({
      actor: ALICE,
      receiver: BOB,
      amount: '10',
    })).rejects.toThrow(
      'Only RegistryAdmin can issue a Holding',
    )
  })

  it('rejects an issuance receiver not registered on global-sync', async () => {
    const client = new CantonClient(fixtureTransport(() => ({})))
    client.getState = async () => ({
      status: 'not-issued',
      parties: { alice: ALICE, admin: ADMIN },
      synchronizers: { global: GLOBAL, private: PRIVATE },
    })
    client.getPartyCatalog = async () => ({
      synchronizers: {
        'global-sync': {
          id: GLOBAL,
          parties: [
            { id: ADMIN, hint: 'RegistryAdmin' },
            { id: ALICE, hint: 'Alice' },
          ],
        },
        'private-sync': { id: PRIVATE, parties: [] },
      },
    })

    await expect(client.issue({
      actor: ADMIN,
      receiver: BOB,
      amount: '10',
    })).rejects.toThrow('Unknown party')
  })

  it('allows only the current Holding owner to reassign it', async () => {
    const client = new CantonClient(fixtureTransport(() => ({})))
    let locked = false
    client.getState = async () => ({
      status: 'active',
      contractId: CONTRACT_ID,
      synchronizer: 'global-sync',
      synchronizerId: GLOBAL,
      reassignmentCounter: 0,
      holding: {
        owner: ALICE,
        admin: ADMIN,
        instrumentId: 'HSKD',
        amount: '100.0000000000',
        locked,
      },
      parties: { alice: ALICE, admin: ADMIN },
      synchronizers: { global: GLOBAL, private: PRIVATE },
    })

    await expect(
      client.reassign({
        synchronizer: 'global-sync',
        actor: BOB,
        contractId: CONTRACT_ID,
      }),
    ).rejects.toThrow('Only the Holding owner can reassign a Holding')

    locked = true
    await expect(
      client.reassign({
        synchronizer: 'global-sync',
        actor: ALICE,
        contractId: CONTRACT_ID,
      }),
    ).rejects.toThrow('A locked Holding cannot be reassigned until the transfer completes')
  })

  it('unassigns and then assigns to the other synchronizer', async () => {
    const submitted: LedgerRequest[] = []
    const client = new CantonClient(
      fixtureTransport((request) => {
        submitted.push(request)
        if (submitted.length === 1) {
          return {
            reassignment: {
              updateId: 'unassign-update',
              events: [
                {
                  JsUnassignedEvent: {
                    value: { reassignmentId: 'reassignment-1' },
                  },
                },
              ],
            },
          }
        }
        return {
          reassignment: {
            updateId: 'assign-update',
            events: [],
          },
        }
      }),
      { autoAssignPolls: 1, pollIntervalMs: 0 },
    )
    let stateCalls = 0
    client.getState = async () => {
      stateCalls += 1
      return stateCalls === 2
        ? {
            status: 'reassigning',
            contractId: SECOND_CONTRACT_ID,
            reassignmentId: 'reassignment-1',
            sourceSynchronizerId: GLOBAL,
            targetSynchronizerId: PRIVATE,
            parties: { alice: ALICE, admin: ADMIN },
            synchronizers: { global: GLOBAL, private: PRIVATE },
          }
        : {
        status: 'active',
        contractId: CONTRACT_ID,
        synchronizer: 'global-sync',
        synchronizerId: GLOBAL,
        reassignmentCounter: 0,
        holding: {
          owner: ALICE,
          admin: ADMIN,
          instrumentId: 'HSKD',
          amount: '100.0000000000',
        },
        holdings: [
          {
            contractId: CONTRACT_ID,
            owner: ALICE,
            admin: ADMIN,
            instrumentId: 'HSKD',
            amount: '100.0000000000',
            synchronizer: 'global-sync',
            reassignmentCounter: 0,
          },
          {
            contractId: SECOND_CONTRACT_ID,
            owner: BOB,
            admin: ADMIN,
            instrumentId: 'HSKD',
            amount: '25.0000000000',
            synchronizer: 'global-sync',
            reassignmentCounter: 0,
          },
        ],
        parties: { alice: ALICE, admin: ADMIN },
        synchronizers: { global: GLOBAL, private: PRIVATE },
      }
    }

    const result = await client.reassign({
      synchronizer: 'global-sync',
      actor: BOB,
      contractId: SECOND_CONTRACT_ID,
    })

    expect(result).toMatchObject({
      source: 'global-sync',
      target: 'private-sync',
      reassignmentId: 'reassignment-1',
      updateId: 'assign-update',
    })
    expect(submitted[0].body).toMatchObject({
      eventFormat: {
        filtersByParty: {
          [BOB]: {
            cumulative: [
              {
                identifierFilter: {
                  WildcardFilter: {
                    value: { includeCreatedEventBlob: false },
                  },
                },
              },
            ],
          },
        },
      },
      reassignmentCommands: {
        commands: [
          {
            command: {
              UnassignCommand: {
                value: {
                  contractId: SECOND_CONTRACT_ID,
                  source: GLOBAL,
                  target: PRIVATE,
                },
              },
            },
          },
        ],
      },
    })
    expect(submitted[1].body).toMatchObject({
      reassignmentCommands: {
        commands: [
          {
            command: {
              AssignCommand: {
                value: {
                  reassignmentId: 'reassignment-1',
                  source: GLOBAL,
                  target: PRIVATE,
                },
              },
            },
          },
        ],
      },
    })
  })

  it('treats an assign race as success when Canton already auto-assigned', async () => {
    let requestCount = 0
    const client = new CantonClient(
      fixtureTransport(() => {
        requestCount += 1
        if (requestCount === 1) {
          return {
            reassignment: {
              updateId: 'unassign-update',
              events: [
                {
                  JsUnassignedEvent: {
                    value: { reassignmentId: 'reassignment-race' },
                  },
                },
              ],
            },
          }
        }
        throw new Error(
          'INVALID_ARGUMENT/UNKNOWN_REASSIGNMENT_ID: reassignment data not found',
        )
      }),
      { autoAssignPolls: 1, pollIntervalMs: 0 },
    )
    let stateCalls = 0
    client.getState = async () => {
      stateCalls += 1
      if (stateCalls === 1) {
        return {
          status: 'active',
          contractId: CONTRACT_ID,
          synchronizer: 'global-sync',
          synchronizerId: GLOBAL,
          reassignmentCounter: 0,
          holding: {
            owner: ALICE,
            admin: ADMIN,
            instrumentId: 'HSKD',
            amount: '100.0000000000',
          },
          parties: { alice: ALICE, admin: ADMIN },
          synchronizers: { global: GLOBAL, private: PRIVATE },
        }
      }
      if (stateCalls === 2) {
        return {
          status: 'reassigning',
          contractId: CONTRACT_ID,
          reassignmentId: 'reassignment-race',
          sourceSynchronizerId: GLOBAL,
          targetSynchronizerId: PRIVATE,
          parties: { alice: ALICE, admin: ADMIN },
          synchronizers: { global: GLOBAL, private: PRIVATE },
        }
      }
      return {
        status: 'active',
        contractId: CONTRACT_ID,
        synchronizer: 'private-sync',
        synchronizerId: PRIVATE,
        reassignmentCounter: 1,
        holding: {
          owner: ALICE,
          admin: ADMIN,
          instrumentId: 'HSKD',
          amount: '100.0000000000',
        },
        parties: { alice: ALICE, admin: ADMIN },
        synchronizers: { global: GLOBAL, private: PRIVATE },
      }
    }

    await expect(client.reassign({
      synchronizer: 'global-sync',
      actor: ALICE,
      contractId: CONTRACT_ID,
    })).resolves.toMatchObject({
      target: 'private-sync',
      reassignmentId: 'reassignment-race',
      automatic: true,
    })
  })

  it('serializes mutation requests to prevent duplicate issuance', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = new CantonClient(fixtureTransport(() => ({})), {
      submitCommand: async () => {
        await blocked
        return { updateId: 'issue-update' }
      },
    })
    client.getState = async () => ({
      status: 'not-issued',
      parties: { alice: ALICE, admin: ADMIN },
      synchronizers: { global: GLOBAL, private: PRIVATE },
    })
    client.getAcs = async () => ({
      synchronizer: 'global-sync',
      synchronizerId: GLOBAL,
      party: { id: ADMIN, hint: 'RegistryAdmin' },
      offset: 1,
      contracts: [
        {
          contractId: 'policy-1',
          templateId: '#simple-token:SimpleToken.Visibility:VisibilityPolicy',
          status: 'active',
          synchronizerId: GLOBAL,
          reassignmentCounter: 0,
          signatories: [ADMIN],
          observers: [ALICE],
          createArgument: { observers: [], version: 1 },
        },
        {
          contractId: 'rules-1',
          templateId: '#simple-token:SimpleToken.Rules:SimpleTokenRules',
          status: 'active',
          synchronizerId: GLOBAL,
          reassignmentCounter: 0,
          signatories: [ADMIN],
          observers: [],
          createArgument: {},
        },
      ],
    })
    client.getPartyCatalog = async () => ({
      synchronizers: {
        'global-sync': {
          id: GLOBAL,
          parties: [
            { id: ADMIN, hint: 'RegistryAdmin' },
            { id: ALICE, hint: 'Alice' },
          ],
        },
        'private-sync': { id: PRIVATE, parties: [] },
      },
    })

    const input = { actor: ADMIN, receiver: ALICE, amount: '100' }
    const first = client.issue(input)
    await expect(client.issue(input)).rejects.toThrow(
      'Another change is already running',
    )
    release?.()
    await expect(first).resolves.toMatchObject({ updateId: 'issue-update' })
  })

  it('falls back to manual assign when an auto-assign status poll fails', async () => {
    let requests = 0
    const client = new CantonClient(
      fixtureTransport(() => {
        requests += 1
        return requests === 1
          ? {
              reassignment: {
                updateId: 'unassign-update',
                events: [
                  {
                    JsUnassignedEvent: {
                      value: { reassignmentId: 'poll-error-id' },
                    },
                  },
                ],
              },
            }
          : {
              reassignment: { updateId: 'manual-assign-update', events: [] },
            }
      }),
      { autoAssignPolls: 1, pollIntervalMs: 0 },
    )
    let calls = 0
    client.getState = async () => {
      calls += 1
      if (calls > 1) throw new Error('temporary ACS failure')
      return {
        status: 'active',
        contractId: CONTRACT_ID,
        synchronizer: 'global-sync',
        synchronizerId: GLOBAL,
        reassignmentCounter: 0,
        holding: {
          owner: ALICE,
          admin: ADMIN,
          instrumentId: 'HSKD',
          amount: '100.0000000000',
        },
        parties: { alice: ALICE, admin: ADMIN },
        synchronizers: { global: GLOBAL, private: PRIVATE },
      }
    }

    await expect(client.reassign({
      synchronizer: 'global-sync',
      actor: ALICE,
      contractId: CONTRACT_ID,
    })).resolves.toMatchObject({
      updateId: 'manual-assign-update',
      automatic: false,
    })
  })

  it('does not report not-issued for an incomplete assigned entry', async () => {
    const transport = fixtureTransport(({ path }) => {
      if (path === '/v2/parties') {
        return {
          partyDetails: [{ party: ALICE }, { party: ADMIN }],
        }
      }
      if (path === '/v2/state/connected-synchronizers') {
        return {
          connectedSynchronizers: [
            { synchronizerAlias: 'global-sync', synchronizerId: GLOBAL },
            { synchronizerAlias: 'private-sync', synchronizerId: PRIVATE },
          ],
        }
      }
      if (path === '/v2/state/ledger-end') return { offset: 50 }
      return [
        {
          contractEntry: {
            JsIncompleteAssigned: {
              assignedEvent: {
                reassignmentId: 'incomplete-assigned-id',
                source: GLOBAL,
                target: PRIVATE,
                reassignmentCounter: 1,
                createdEvent: {
                  contractId: CONTRACT_ID,
                  interfaceViews: [
                    {
                      viewStatus: { code: 0 },
                      viewValue: {
                        owner: ALICE,
                        instrumentId: { admin: ADMIN, id: 'HSKD' },
                        amount: '100.0000000000',
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ]
    })

    await expect(new CantonClient(transport).getState()).resolves.toMatchObject({
      status: 'active',
      contractId: CONTRACT_ID,
      synchronizer: 'private-sync',
      reassignmentCounter: 1,
    })
  })

  it('groups local parties by the synchronizers they are connected to', async () => {
    const queried: string[] = []
    const transport = fixtureTransport(({ path, query }) => {
      if (path === '/v2/parties') {
        return {
          partyDetails: [
            { party: ALICE, isLocal: true },
            { party: ADMIN, isLocal: true },
            { party: BOB, isLocal: true },
            { party: 'Remote::ns', isLocal: false },
          ],
        }
      }
      if (path === '/v2/state/connected-synchronizers') {
        queried.push(String(query?.party))
        if (query?.party === BOB) {
          return {
            connectedSynchronizers: [
              { synchronizerAlias: 'private-sync', synchronizerId: PRIVATE },
            ],
          }
        }
        return {
          connectedSynchronizers: [
            { synchronizerAlias: 'global-sync', synchronizerId: GLOBAL },
            { synchronizerAlias: 'private-sync', synchronizerId: PRIVATE },
          ],
        }
      }
      throw new Error(`unexpected request: ${path}`)
    })

    const catalog = await new CantonClient(transport).getPartyCatalog()

    expect(queried).toEqual([ALICE, ADMIN, BOB])
    expect(catalog).toEqual({
      synchronizers: {
        'global-sync': {
          id: GLOBAL,
          parties: [
            { id: ADMIN, hint: 'RegistryAdmin' },
            { id: ALICE, hint: 'Alice' },
          ],
        },
        'private-sync': {
          id: PRIVATE,
          parties: [
            { id: ADMIN, hint: 'RegistryAdmin' },
            { id: ALICE, hint: 'Alice' },
            { id: BOB, hint: 'Bob' },
          ],
        },
      },
    })
  })

  it('loads ACS for one party on one synchronizer and skips other domains', async () => {
    const submitted: LedgerRequest[] = []
    const transport = fixtureTransport((request) => {
      submitted.push(request)
      if (request.path === '/v2/parties') {
        return {
          partyDetails: [
            { party: ALICE, isLocal: true },
            { party: ADMIN, isLocal: true },
            { party: BOB, isLocal: true },
          ],
        }
      }
      if (request.path === '/v2/state/connected-synchronizers') {
        return {
          connectedSynchronizers: [
            { synchronizerAlias: 'global-sync', synchronizerId: GLOBAL },
            { synchronizerAlias: 'private-sync', synchronizerId: PRIVATE },
          ],
        }
      }
      if (request.path === '/v2/state/ledger-end') return { offset: 88 }
      if (request.path === '/v2/state/active-contracts') {
        return [
          {
            contractEntry: {
              JsActiveContract: {
                createdEvent: {
                  contractId: CONTRACT_ID,
                  templateId: '#simple-token:SimpleToken.Holding:SimpleHolding',
                  signatories: [ADMIN, ALICE],
                  observers: [],
                  createArgument: {
                    admin: ADMIN,
                    owner: ALICE,
                    amount: '100.0000000000',
                  },
                  interfaceViews: [
                    {
                      viewStatus: { code: 0 },
                      viewValue: {
                        owner: ALICE,
                        instrumentId: { admin: ADMIN, id: 'HSKD' },
                        amount: '100.0000000000',
                      },
                    },
                  ],
                },
                synchronizerId: GLOBAL,
                reassignmentCounter: 2,
              },
            },
          },
          {
            contractEntry: {
              JsActiveContract: {
                createdEvent: {
                  contractId: '00-private-only',
                  templateId: '#pkg:Module:Other',
                  signatories: [ALICE],
                  observers: [],
                  createArgument: { note: 'other-domain' },
                },
                synchronizerId: PRIVATE,
                reassignmentCounter: 0,
              },
            },
          },
          {
            contractEntry: {
              JsIncompleteUnassigned: {
                createdEvent: {
                  contractId: '00-moving',
                  templateId: '#pkg:Module:Moving',
                  signatories: [ALICE],
                  observers: [],
                  createArgument: { note: 'in-flight' },
                },
                unassignedEvent: {
                  reassignmentId: 'reid-1',
                  source: GLOBAL,
                  target: PRIVATE,
                  reassignmentCounter: 4,
                },
              },
            },
          },
        ]
      }
      throw new Error(`unexpected request: ${request.path}`)
    })

    const snapshot = await new CantonClient(transport).getAcs({
      synchronizer: 'global-sync',
      party: ALICE,
    })

    expect(submitted.at(-1)).toMatchObject({
      path: '/v2/state/active-contracts',
      body: {
        eventFormat: {
          filtersByParty: {
            [ALICE]: {
              cumulative: [
                {
                  identifierFilter: {
                    WildcardFilter: {
                      value: { includeCreatedEventBlob: false },
                    },
                  },
                },
                {
                  identifierFilter: {
                    InterfaceFilter: {
                      value: {
                        includeInterfaceView: true,
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    })
    expect(snapshot).toMatchObject({
      synchronizer: 'global-sync',
      synchronizerId: GLOBAL,
      party: { id: ALICE, hint: 'Alice' },
      offset: 88,
    })
    expect(snapshot.contracts).toHaveLength(2)
    expect(snapshot.contracts[0]).toMatchObject({
      contractId: CONTRACT_ID,
      templateId: '#simple-token:SimpleToken.Holding:SimpleHolding',
      status: 'active',
      reassignmentCounter: 2,
      signatories: [ADMIN, ALICE],
      holding: {
        owner: ALICE,
        admin: ADMIN,
        instrumentId: 'HSKD',
        amount: '100.0000000000',
      },
    })
    expect(snapshot.contracts[1]).toMatchObject({
      contractId: '00-moving',
      status: 'reassigning',
      reassignmentId: 'reid-1',
    })
  })

  it('rejects ACS queries for unknown parties or synchronizers', async () => {
    const transport = fixtureTransport(({ path }) => {
      if (path === '/v2/parties') {
        return {
          partyDetails: [
            { party: ALICE, isLocal: true },
            { party: ADMIN, isLocal: true },
          ],
        }
      }
      if (path === '/v2/state/connected-synchronizers') {
        return {
          connectedSynchronizers: [
            { synchronizerAlias: 'global-sync', synchronizerId: GLOBAL },
            { synchronizerAlias: 'private-sync', synchronizerId: PRIVATE },
          ],
        }
      }
      throw new Error(`unexpected request: ${path}`)
    })
    const client = new CantonClient(transport)

    await expect(
      client.getAcs({ synchronizer: 'global-sync', party: 'Eve::ns' }),
    ).rejects.toThrow('Unknown party')
    await expect(
      client.getAcs({ synchronizer: 'other-sync', party: ALICE }),
    ).rejects.toThrow('Unknown synchronizer')
  })

  it('submits a full two-step CIP-56 transfer only for the Holding owner', async () => {
    const submitted: SinglePartyCommand[] = []
    let locked = false
    const client = new CantonClient(fixtureTransport(() => ({})), {
      submitCommand: recordSubmit('transfer-update', submitted),
    })
    client.getPartyCatalog = async () => ({
      synchronizers: {
        'global-sync': {
          id: GLOBAL,
          parties: [
            { id: ADMIN, hint: 'RegistryAdmin' },
            { id: ALICE, hint: 'Alice' },
            { id: BOB, hint: 'Bob' },
          ],
        },
        'private-sync': { id: PRIVATE, parties: [] },
      },
    })
    client.getAcs = async ({ party }) => ({
      synchronizer: 'global-sync',
      synchronizerId: GLOBAL,
      party: { id: party, hint: party.split('::')[0] },
      offset: 10,
      contracts:
        party === ALICE
          ? [
              {
                contractId: CONTRACT_ID,
                templateId: '#simple-token:SimpleToken.Holding:SimpleHolding',
                status: 'active',
                synchronizerId: GLOBAL,
                reassignmentCounter: 0,
                signatories: [ADMIN, ALICE],
                observers: [],
                createArgument: {},
                holding: {
                  owner: ALICE,
                  admin: ADMIN,
                  instrumentId: 'HSKD',
                  amount: '100.0000000000',
                  locked,
                },
              },
            ]
          : [
              {
                contractId: 'rules-1',
                templateId: '#simple-token:SimpleToken.Rules:SimpleTokenRules',
                status: 'active',
                synchronizerId: GLOBAL,
                reassignmentCounter: 0,
                signatories: [ADMIN],
                observers: [],
                createArgument: {},
              },
            ],
    })

    await expect(
      client.transfer({
        synchronizer: 'global-sync',
        actor: BOB,
        contractId: CONTRACT_ID,
        receiver: ALICE,
      }),
    ).rejects.toThrow('Only the Holding owner')

    await expect(
      client.transfer({
        synchronizer: 'global-sync',
        actor: ALICE,
        contractId: CONTRACT_ID,
        receiver: BOB,
      }),
    ).resolves.toMatchObject({ updateId: 'transfer-update' })

    expect(submitted.at(-1)).toMatchObject({
      actAs: ALICE,
      synchronizerId: GLOBAL,
      commands: [
        {
          ExerciseCommand: {
            templateId:
              '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory',
            contractId: 'rules-1',
            choice: 'TransferFactory_Transfer',
            choiceArgument: {
              transfer: {
                sender: ALICE,
                receiver: BOB,
                amount: '100.0000000000',
                inputHoldingCids: [CONTRACT_ID],
              },
            },
          },
        },
      ],
    })

    locked = true
    await expect(
      client.transfer({
        synchronizer: 'global-sync',
        actor: ALICE,
        contractId: CONTRACT_ID,
        receiver: BOB,
      }),
    ).rejects.toThrow('A locked Holding cannot be transferred again')
  })

  it('enforces receiver and sender permissions on pending transfer actions', async () => {
    const submitted: SinglePartyCommand[] = []
    const client = new CantonClient(fixtureTransport(() => ({})), {
      submitCommand: recordSubmit('instruction-update', submitted),
    })
    client.getPartyCatalog = async () => ({
      synchronizers: {
        'global-sync': {
          id: GLOBAL,
          parties: [
            { id: ADMIN, hint: 'RegistryAdmin' },
            { id: ALICE, hint: 'Alice' },
            { id: BOB, hint: 'Bob' },
          ],
        },
        'private-sync': { id: PRIVATE, parties: [] },
      },
    })
    client.getAcs = async ({ party }) => ({
      synchronizer: 'global-sync',
      synchronizerId: GLOBAL,
      party: { id: party, hint: party.split('::')[0] },
      offset: 10,
      contracts: [
        {
          contractId: 'instruction-1',
          templateId:
            '#simple-token:SimpleToken.TransferInstruction:SimpleTransferInstruction',
          status: 'active',
          synchronizerId: GLOBAL,
          reassignmentCounter: 0,
          signatories: [ADMIN, ALICE],
          observers: [BOB],
          createArgument: {},
          transferInstruction: {
            sender: ALICE,
            receiver: BOB,
            amount: '100.0000000000',
            instrumentId: { admin: ADMIN, id: 'HSKD' },
          },
        },
      ],
    })

    await expect(
      client.actOnTransferInstruction({
        synchronizer: 'global-sync',
        actor: ALICE,
        contractId: 'instruction-1',
        action: 'accept',
      }),
    ).rejects.toThrow('Only the receiver')

    await client.actOnTransferInstruction({
      synchronizer: 'global-sync',
      actor: BOB,
      contractId: 'instruction-1',
      action: 'accept',
    })
    await client.actOnTransferInstruction({
      synchronizer: 'global-sync',
      actor: ALICE,
      contractId: 'instruction-1',
      action: 'withdraw',
    })

    expect(submitted.map((command) => {
      const exercise = command.commands[0] as {
        ExerciseCommand: { choice: string }
      }
      return exercise.ExerciseCommand.choice
    })).toEqual([
      'TransferInstruction_Accept',
      'TransferInstruction_Withdraw',
    ])
  })

  it('atomically updates the whitelist and rules only for RegistryAdmin', async () => {
    const submitted: SinglePartyCommand[] = []
    const client = new CantonClient(fixtureTransport(() => ({})), {
      submitCommand: recordSubmit('visibility-update', submitted),
    })
    client.getPartyCatalog = async () => ({
      synchronizers: {
        'global-sync': {
          id: GLOBAL,
          parties: [
            { id: ADMIN, hint: 'RegistryAdmin' },
            { id: ALICE, hint: 'Alice' },
            { id: BOB, hint: 'Bob' },
            { id: CAROL, hint: 'Carol' },
          ],
        },
        'private-sync': { id: PRIVATE, parties: [] },
      },
    })
    client.getAcs = async ({ party }) => ({
      synchronizer: 'global-sync',
      synchronizerId: GLOBAL,
      party: { id: party, hint: party.split('::')[0] },
      offset: 10,
      contracts: [
        {
          contractId: 'policy-1',
          templateId: '#simple-token:SimpleToken.Visibility:VisibilityPolicy',
          status: 'active',
          synchronizerId: GLOBAL,
          reassignmentCounter: 0,
          signatories: [ADMIN],
          observers: [ALICE, BOB],
          createArgument: {
            admin: ADMIN,
            instrumentId: { admin: ADMIN, id: 'HSKD' },
            version: 1,
          },
        },
        {
          contractId: 'rules-1',
          templateId: '#simple-token:SimpleToken.Rules:SimpleTokenRules',
          status: 'active',
          synchronizerId: GLOBAL,
          reassignmentCounter: 0,
          signatories: [ADMIN],
          observers: [],
          createArgument: {},
        },
      ],
    })

    await expect(
      client.updateWhitelist({
        synchronizer: 'global-sync',
        actor: ALICE,
        observers: [BOB],
      }),
    ).rejects.toThrow('Only RegistryAdmin')

    await client.updateWhitelist({
      synchronizer: 'global-sync',
      actor: ADMIN,
      observers: [BOB],
    })

    expect(submitted).toHaveLength(1)
    expect(submitted.map((command) => {
      const exercise = command.commands[0] as {
        ExerciseCommand: { choice: string; choiceArgument: unknown }
      }
      return exercise.ExerciseCommand
    })).toMatchObject([
      {
        choice: 'SimpleTokenRules_UpdateVisibilityPolicy',
        choiceArgument: {
          policyCid: 'policy-1',
          observers: [BOB],
          readers: [ADMIN, ALICE, BOB, CAROL],
        },
      },
    ])
  })

  it('lets the Holding owner refresh visibility with admin coauthorization', async () => {
    const submitted: SinglePartyCommand[] = []
    let locked = false
    const client = new CantonClient(fixtureTransport(() => ({})), {
      submitCommand: recordSubmit('refresh-update', submitted),
    })
    client.getAcs = async ({ party }) => ({
      synchronizer: 'global-sync',
      synchronizerId: GLOBAL,
      party: { id: party, hint: party.split('::')[0] },
      offset: 10,
      contracts:
        party === ALICE
          ? [
              {
                contractId: CONTRACT_ID,
                templateId: '#simple-token:SimpleToken.Holding:SimpleHolding',
                status: 'active',
                synchronizerId: GLOBAL,
                reassignmentCounter: 0,
                signatories: [ADMIN, ALICE],
                observers: [],
                createArgument: {},
                holding: {
                  owner: ALICE,
                  admin: ADMIN,
                  instrumentId: 'HSKD',
                  amount: '100.0000000000',
                  locked,
                },
              },
            ]
          : [
              {
                contractId: 'policy-2',
                templateId:
                  '#simple-token:SimpleToken.Visibility:VisibilityPolicy',
                status: 'active',
                synchronizerId: GLOBAL,
                reassignmentCounter: 0,
                signatories: [ADMIN],
                observers: [ALICE, BOB],
                createArgument: {},
              },
            ],
    })

    await client.refreshVisibility({
      synchronizer: 'global-sync',
      actor: ALICE,
      contractId: CONTRACT_ID,
    })

    expect(submitted[0]).toMatchObject({
      actAs: ALICE,
      commands: [
        {
          ExerciseCommand: {
            contractId: CONTRACT_ID,
            choice: 'SimpleHolding_RefreshVisibility',
            choiceArgument: { policyCid: 'policy-2' },
          },
        },
      ],
    })

    locked = true
    await expect(
      client.refreshVisibility({
        synchronizer: 'global-sync',
        actor: ALICE,
        contractId: CONTRACT_ID,
      }),
    ).rejects.toThrow('A locked Holding cannot have its visibility refreshed')
  })
})
