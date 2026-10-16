import {
  createPrivateKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PartyKey {
  hint: string
  partyId?: string
  fingerprint?: string
  synchronizers?: string[]
  publicKeyDer: string
  privateKeyPkcs8: string
}

const keyPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../.custody/keys.json',
)

function readKeys(): PartyKey[] {
  try {
    const parsed = JSON.parse(readFileSync(keyPath, 'utf8')) as PartyKey[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeKeys(keys: PartyKey[]) {
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, JSON.stringify(keys, null, 2))
  chmodSync(keyPath, 0o600)
}

export function loadOrCreateKey(hint: string): PartyKey {
  const keys = readKeys()
  const existing = keys.find((key) => key.hint === hint)
  if (existing) return existing
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const created: PartyKey = {
    hint,
    publicKeyDer: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).toString('base64'),
    privateKeyPkcs8: Buffer.from(
      privateKey.export({ type: 'pkcs8', format: 'der' }),
    ).toString('base64'),
  }
  keys.push(created)
  writeKeys(keys)
  return created
}

export function rememberParty(
  hint: string,
  partyId: string,
  fingerprint: string,
  synchronizer: string,
) {
  const keys = readKeys()
  const key = keys.find((item) => item.hint === hint)
  if (!key) throw new Error(`Missing local key for ${hint}`)
  key.partyId = partyId
  key.fingerprint = fingerprint
  key.synchronizers = Array.from(new Set([...(key.synchronizers ?? []), synchronizer]))
  writeKeys(keys)
}

export function signPartyHash(partyId: string, hash: Buffer) {
  const key = readKeys().find((item) => item.partyId === partyId)
  if (!key?.fingerprint) throw new Error(`Party ${partyId} has no local custody key`)
  return {
    fingerprint: key.fingerprint,
    signature: sign(null, hash, privateKeyOf(key)).toString('base64'),
  }
}

function privateKeyOf(key: PartyKey): KeyObject {
  return createPrivateKey({
    key: Buffer.from(key.privateKeyPkcs8, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
}
