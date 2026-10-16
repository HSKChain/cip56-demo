import { createPrivateKey, sign } from 'node:crypto'
import type { CantonTransport } from '../canton.js'
import { loadOrCreateKey, rememberParty, type PartyKey } from './keys.js'

export const BUSINESS_PARTY_HINTS = [
  'RegistryAdmin',
  'Alice',
  'Bob',
  'Carol',
  'Dave',
] as const

interface TopologyResponse {
  partyId: string
  publicKeyFingerprint: string
  topologyTransactions: string[]
  multiHash: string
}

/** Register external parties on both synchronizers. Keys stay local and are not given to the participant. */
export async function ensureExternalParties(transport: CantonTransport) {
  const connected = (await transport.request({
    path: '/v2/state/connected-synchronizers',
  })) as { connectedSynchronizers?: Array<{ synchronizerId?: string }> }
  const synchronizers = (connected.connectedSynchronizers ?? [])
    .map((item) => item.synchronizerId)
    .filter((id): id is string => Boolean(id))
  if (synchronizers.length === 0) throw new Error('The participant is not connected to a synchronizer yet')
  for (const hint of BUSINESS_PARTY_HINTS) {
    const key = loadOrCreateKey(hint)
    for (const synchronizer of synchronizers) {
      if (key.synchronizers?.includes(synchronizer)) continue
      const topology = (await transport.request({
        path: '/v2/parties/external/generate-topology',
        method: 'POST',
        body: {
          synchronizer,
          partyHint: hint,
          publicKey: {
            format: 'CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO',
            keyData: key.publicKeyDer,
            keySpec: 'SIGNING_KEY_SPEC_EC_CURVE25519',
          },
          localParticipantObservationOnly: false,
          confirmationThreshold: 1,
          otherConfirmingParticipantUids: [],
          observingParticipantUids: [],
        },
      })) as TopologyResponse
      const allocated = (await transport.request({
        path: '/v2/parties/external/allocate',
        method: 'POST',
        body: {
          synchronizer,
          identityProviderId: '',
          onboardingTransactions: topology.topologyTransactions.map(
            (transaction) => ({ transaction, signatures: [] }),
          ),
          multiHashSignatures: [signMultiHash(key, topology)],
        },
      })) as { partyId?: string }
      const partyId = allocated.partyId || topology.partyId
      rememberParty(hint, partyId, topology.publicKeyFingerprint, synchronizer)
      key.partyId = partyId
      key.fingerprint = topology.publicKeyFingerprint
    }
  }
}

function signMultiHash(key: PartyKey, topology: TopologyResponse) {
  const privateKey = createPrivateKey({
    key: Buffer.from(key.privateKeyPkcs8, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  return {
    format: 'SIGNATURE_FORMAT_CONCAT',
    signature: sign(null, Buffer.from(topology.multiHash, 'base64'), privateKey).toString(
      'base64',
    ),
    signedBy: topology.publicKeyFingerprint,
    signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519',
  }
}
