import { describe, expect, it } from 'vitest'
import { initializeVisibility } from './initialize.js'
import type { CantonTransport } from './canton.js'

const ADMIN = 'RegistryAdmin::namespace'
const ALICE = 'Alice::namespace'
const BOB = 'Bob::namespace'

describe('visibility initializer', () => {
  it('creates one policy and rules contract on each synchronizer', async () => {
    const transport: CantonTransport = {
      request: async () => {
        throw new Error('Initialization must no longer submit ledger commands directly')
      },
    }
    const client = {
      getPartyCatalog: async () => ({
        synchronizers: {
          'global-sync': {
            id: 'global::id',
            parties: [
              { id: ADMIN, hint: 'RegistryAdmin' },
              { id: ALICE, hint: 'Alice' },
              { id: BOB, hint: 'Bob' },
            ],
          },
          'private-sync': {
            id: 'private::id',
            parties: [
              { id: ADMIN, hint: 'RegistryAdmin' },
              { id: ALICE, hint: 'Alice' },
              { id: BOB, hint: 'Bob' },
            ],
          },
        },
      }),
      getAcs: async () => ({
        synchronizer: 'global-sync' as const,
        synchronizerId: 'global::id',
        party: { id: ADMIN, hint: 'RegistryAdmin' },
        offset: 1,
        contracts: [],
      }),
    }

    const commands: Array<{ actAs: string; commands: unknown[]; synchronizerId: string }> = []
    const result = await initializeVisibility(client, transport, async (_transport, command) => {
      commands.push(command)
      return { updateId: `update-${commands.length}` }
    })

    expect(result).toEqual([
      { synchronizer: 'global-sync', status: 'created', updateId: 'update-2' },
      { synchronizer: 'private-sync', status: 'created', updateId: 'update-4' },
    ])
    expect(commands).toHaveLength(4)
    expect(commands.map((command) => ({
      actAs: command.actAs,
      commandCount: command.commands.length,
    }))).toEqual([
      { actAs: ADMIN, commandCount: 1 },
      { actAs: ADMIN, commandCount: 1 },
      { actAs: ADMIN, commandCount: 1 },
      { actAs: ADMIN, commandCount: 1 },
    ])
    expect(commands[0]).toMatchObject({
      actAs: ADMIN,
      synchronizerId: 'global::id',
      commands: [
        {
          CreateCommand: {
            templateId: '#simple-token:SimpleToken.Visibility:VisibilityPolicy',
            createArguments: {
              admin: ADMIN,
              observers: [],
              readers: [ADMIN, ALICE, BOB],
              version: 1,
            },
          },
        },
      ],
    })
    expect(commands[1]).toMatchObject({
      commands: [
        {
          CreateCommand: {
            templateId: '#simple-token:SimpleToken.Rules:SimpleTokenRules',
          },
        },
      ],
    })
  })
})
