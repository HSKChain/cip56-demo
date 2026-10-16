import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CantonTransport } from '../canton.js'
import { hashPreparedTransaction } from './hashTransaction.js'
import { submitSignedCommand } from './submit.js'

const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures/visibility-update.json'),
    'utf8',
  ),
) as { preparedTransaction: string; preparedTransactionHash: string }

describe('prepared transaction hash', () => {
  it('matches the hash recomputed from preparedTransaction bytes', () => {
    const local = hashPreparedTransaction(fixture.preparedTransaction)
    expect(local.toString('base64')).toBe(fixture.preparedTransactionHash)
  })

  it('signs the local hash instead of the hash returned by the participant', async () => {
    const requests: Array<{ path: string; body?: unknown }> = []
    let signed: Buffer | undefined
    const transport: CantonTransport = {
      request: async (request) => {
        requests.push(request)
        if (request.path === '/v2/interactive-submission/prepare') {
          return {
            preparedTransaction: fixture.preparedTransaction,
            preparedTransactionHash: Buffer.from('different-hash').toString('base64'),
            hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
          }
        }
        return { updateId: 'signed-update' }
      },
    }

    const result = await submitSignedCommand(
      transport,
      {
        commandId: 'cmd-1',
        workflowId: 'cip56-demo-test',
        actAs: 'Alice::example',
        synchronizerId: 'global-sync::example',
        commands: [{ CreateCommand: { templateId: '#simple-token:SimpleToken.Visibility:VisibilityPolicy' } }],
      },
      (_party, hash) => {
        signed = Buffer.from(hash)
        return { fingerprint: 'fingerprint', signature: 'c2ln' }
      },
    )

    expect(result.updateId).toBe('signed-update')
    expect(signed?.equals(hashPreparedTransaction(fixture.preparedTransaction))).toBe(true)
    expect(signed?.toString('base64')).not.toBe(
      Buffer.from('different-hash').toString('base64'),
    )
    const execute = requests.find(
      (request) => request.path === '/v2/interactive-submission/executeAndWait',
    )
    expect(execute?.body).toMatchObject({
      hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
      partySignatures: {
        signatures: [{ party: 'Alice::example', signatures: [{ signedBy: 'fingerprint' }] }],
      },
    })
  })
})
