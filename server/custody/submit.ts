import { randomUUID } from 'node:crypto'
import type { CantonTransport } from '../canton.js'
import { hashPreparedTransaction } from './hashTransaction.js'
import { signPartyHash } from './keys.js'

export interface SinglePartyCommand {
  commandId: string
  workflowId: string
  actAs: string
  /** Provides visibility only and does not add an authorizing party. Used to read the factory contract the caller cannot see. */
  readAs?: string[]
  synchronizerId: string
  commands: unknown[]
}

export type PartySigner = (
  partyId: string,
  hash: Buffer,
) => { fingerprint: string; signature: string }

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Canton returned data that could not be recognized')
  }
  return value as Record<string, unknown>
}

/** After prepare, sign only the locally computed hash and ignore preparedTransactionHash returned by the node. */
export async function submitSignedCommand(
  transport: CantonTransport,
  command: SinglePartyCommand,
  signHash: PartySigner = signPartyHash,
): Promise<{ updateId: string }> {
  if (!command.actAs) throw new Error('A submission must name one authorizing party')
  const prepared = asRecord(
    await transport.request({
      path: '/v2/interactive-submission/prepare',
      method: 'POST',
      body: {
        userId: 'CantonConsole',
        commandId: command.commandId,
        commands: command.commands,
        actAs: [command.actAs],
        readAs: command.readAs ?? [],
        disclosedContracts: [],
        synchronizerId: command.synchronizerId,
        packageIdSelectionPreference: [],
        verboseHashing: false,
        prefetchContractKeys: [],
      },
    }),
  )
  const preparedTransaction = String(prepared.preparedTransaction ?? '')
  if (!preparedTransaction) throw new Error('Prepare did not return transaction bytes')
  const localHash = hashPreparedTransaction(preparedTransaction)
  const signature = signHash(command.actAs, localHash)
  const executed = asRecord(
    await transport.request({
      path: '/v2/interactive-submission/executeAndWait',
      method: 'POST',
      body: {
        preparedTransaction,
        partySignatures: {
          signatures: [
            {
              party: command.actAs,
              signatures: [
                {
                  format: 'SIGNATURE_FORMAT_CONCAT',
                  signature: signature.signature,
                  signedBy: signature.fingerprint,
                  signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519',
                },
              ],
            },
          ],
        },
        deduplicationPeriod: { Empty: {} },
        submissionId: randomUUID(),
        userId: 'CantonConsole',
        hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
      },
    }),
  )
  const updateId = executed.updateId
  if (typeof updateId !== 'string' || !updateId) {
    throw new Error('Execute did not return an updateId')
  }
  return { updateId }
}
