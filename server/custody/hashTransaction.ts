import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import protobuf from 'protobufjs'

const PURPOSE = Buffer.from([0x00, 0x00, 0x00, 0x30])
const SCHEME_V2 = Buffer.from([0x02])
const NODE_VERSION = Buffer.from([0x01])

const protoPath = join(dirname(fileURLToPath(import.meta.url)), 'prepared.proto')
const root = protobuf.parse(readFileSync(protoPath, 'utf8'), {
  keepCase: true,
}).root
const PreparedTransaction = root.lookupType('PreparedTransaction')

type Proto = protobuf.Message & Record<string, unknown>

/** Compute the V2 hash from the preparedTransaction returned by prepare. Do not use the hash supplied by the node. */
export function hashPreparedTransaction(preparedTransaction: string): Buffer {
  const bytes = Buffer.from(preparedTransaction, 'base64')
  const decoded = PreparedTransaction.decode(bytes) as Proto
  const nodes = indexNodes(list(tx(decoded).nodes))
  const transactionHash = sha256(
    Buffer.concat([PURPOSE, encodeTransaction(tx(decoded), nodes)]),
  )
  const metadataHash = sha256(
    Buffer.concat([PURPOSE, encodeMetadata(meta(decoded))]),
  )
  return sha256(Buffer.concat([PURPOSE, SCHEME_V2, transactionHash, metadataHash]))
}

function tx(message: Proto): Proto {
  return message.transaction as Proto
}

function meta(message: Proto): Proto {
  return message.metadata as Proto
}

function indexNodes(nodes: Proto[]) {
  const dict = new Map<string, Proto>()
  for (const node of nodes) dict.set(String(node.node_id), node)
  return dict
}

function encodeTransaction(transaction: Proto, nodes: Map<string, Proto>) {
  const seeds = list(transaction.node_seeds)
  return Buffer.concat([
    encodeString(String(transaction.version ?? '')),
    encodeRepeated(list(transaction.roots), (nodeId) =>
      sha256(encodeNode(nodes.get(String(nodeId))!, nodes, seeds)),
    ),
  ])
}

function encodeNode(node: Proto, nodes: Map<string, Proto>, seeds: Proto[]): Buffer {
  const versioned = node.v1 as Proto | null | undefined
  if (!versioned) throw new Error('Unsupported transaction node version')
  const nodeId = String(node.node_id)
  if (versioned.create) return encodeCreate(versioned.create as Proto, nodeId, seeds)
  if (versioned.exercise) {
    return encodeExercise(versioned.exercise as Proto, nodeId, nodes, seeds)
  }
  if (versioned.fetch) return encodeFetch(versioned.fetch as Proto)
  if (versioned.rollback) {
    return encodeRollback(versioned.rollback as Proto, nodes, seeds)
  }
  throw new Error('Unsupported transaction node type')
}

function encodeCreate(create: Proto, nodeId: string, seeds: Proto[]) {
  return Buffer.concat([
    NODE_VERSION,
    encodeString(String(create.lf_version ?? '')),
    Buffer.from([0x00]),
    encodeOptional(findSeed(nodeId, seeds), encodeHash),
    encodeHex(String(create.contract_id ?? '')),
    encodeString(String(create.package_name ?? '')),
    encodeIdentifier(create.template_id as Proto),
    encodeValue(create.argument as Proto),
    encodeRepeated(strings(create.signatories), encodeString),
    encodeRepeated(strings(create.stakeholders), encodeString),
  ])
}

function encodeExercise(
  exercise: Proto,
  nodeId: string,
  nodes: Map<string, Proto>,
  seeds: Proto[],
) {
  const seed = findSeed(nodeId, seeds)
  if (!seed) throw new Error(`Exercise node ${nodeId} is missing a seed`)
  return Buffer.concat([
    NODE_VERSION,
    encodeString(String(exercise.lf_version ?? '')),
    Buffer.from([0x01]),
    encodeHash(seed),
    encodeHex(String(exercise.contract_id ?? '')),
    encodeString(String(exercise.package_name ?? '')),
    encodeIdentifier(exercise.template_id as Proto),
    encodeRepeated(strings(exercise.signatories), encodeString),
    encodeRepeated(strings(exercise.stakeholders), encodeString),
    encodeRepeated(strings(exercise.acting_parties), encodeString),
    encodeField(exercise, 'interface_id', encodeIdentifier),
    encodeString(String(exercise.choice_id ?? '')),
    encodeValue(exercise.chosen_value as Proto),
    encodeBool(Boolean(exercise.consuming)),
    encodeField(exercise, 'exercise_result', encodeValue),
    encodeRepeated(strings(exercise.choice_observers), encodeString),
    encodeRepeated(strings(exercise.children), (childId) =>
      sha256(encodeNode(nodes.get(childId)!, nodes, seeds)),
    ),
  ])
}

function encodeFetch(fetch: Proto) {
  return Buffer.concat([
    NODE_VERSION,
    encodeString(String(fetch.lf_version ?? '')),
    Buffer.from([0x02]),
    encodeHex(String(fetch.contract_id ?? '')),
    encodeString(String(fetch.package_name ?? '')),
    encodeIdentifier(fetch.template_id as Proto),
    encodeRepeated(strings(fetch.signatories), encodeString),
    encodeRepeated(strings(fetch.stakeholders), encodeString),
    encodeField(fetch, 'interface_id', encodeIdentifier),
    encodeRepeated(strings(fetch.acting_parties), encodeString),
  ])
}

function encodeRollback(rollback: Proto, nodes: Map<string, Proto>, seeds: Proto[]) {
  return Buffer.concat([
    NODE_VERSION,
    Buffer.from([0x03]),
    encodeRepeated(strings(rollback.children), (childId) =>
      sha256(encodeNode(nodes.get(childId)!, nodes, seeds)),
    ),
  ])
}

function encodeMetadata(metadata: Proto) {
  const submitter = metadata.submitter_info as Proto
  return Buffer.concat([
    Buffer.from([0x01]),
    encodeRepeated(strings(submitter.act_as), encodeString),
    encodeString(String(submitter.command_id ?? '')),
    encodeString(String(metadata.transaction_uuid ?? '')),
    encodeInt32(Number(metadata.mediator_group ?? 0)),
    encodeString(String(metadata.synchronizer_id ?? '')),
    encodeField(metadata, 'min_ledger_effective_time', encodeLong),
    encodeField(metadata, 'max_ledger_effective_time', encodeLong),
    encodeLong(metadata.preparation_time),
    encodeRepeated(list(metadata.input_contracts), encodeInputContract),
  ])
}

function encodeInputContract(contract: Proto) {
  return Buffer.concat([
    encodeLong(contract.created_at),
    sha256(encodeCreate(contract.v1 as Proto, 'unused_node_id', [])),
  ])
}

function encodeValue(value: Proto | null | undefined): Buffer {
  if (!value) throw new Error('Missing Daml value')
  if (has(value, 'unit')) return Buffer.from([0x00])
  if (has(value, 'bool')) {
    return Buffer.concat([Buffer.from([0x01]), encodeBool(Boolean(value.bool))])
  }
  if (has(value, 'int64')) return Buffer.concat([Buffer.from([0x02]), encodeLong(value.int64)])
  if (has(value, 'numeric')) {
    return Buffer.concat([Buffer.from([0x03]), encodeString(String(value.numeric))])
  }
  if (has(value, 'timestamp')) {
    return Buffer.concat([Buffer.from([0x04]), encodeLong(value.timestamp)])
  }
  if (has(value, 'date')) {
    return Buffer.concat([Buffer.from([0x05]), encodeInt32(Number(value.date))])
  }
  if (has(value, 'party')) {
    return Buffer.concat([Buffer.from([0x06]), encodeString(String(value.party))])
  }
  if (has(value, 'text')) {
    return Buffer.concat([Buffer.from([0x07]), encodeString(String(value.text))])
  }
  if (has(value, 'contract_id')) {
    return Buffer.concat([Buffer.from([0x08]), encodeHex(String(value.contract_id))])
  }
  if (has(value, 'optional')) {
    const optional = value.optional as Proto
    return Buffer.concat([
      Buffer.from([0x09]),
      encodeField(optional, 'value', encodeValue),
    ])
  }
  if (has(value, 'list')) {
    return Buffer.concat([
      Buffer.from([0x0a]),
      encodeRepeated(list((value.list as Proto).elements), encodeValue),
    ])
  }
  if (has(value, 'text_map')) {
    return Buffer.concat([
      Buffer.from([0x0b]),
      encodeRepeated(list((value.text_map as Proto).entries), (entry) =>
        Buffer.concat([
          encodeString(String(entry.key ?? '')),
          encodeValue(entry.value as Proto),
        ]),
      ),
    ])
  }
  if (has(value, 'record')) {
    const record = value.record as Proto
    return Buffer.concat([
      Buffer.from([0x0c]),
      encodeField(record, 'record_id', encodeIdentifier),
      encodeRepeated(list(record.fields), (field) =>
        Buffer.concat([
          encodeField(field, 'label', (label: unknown) => encodeString(String(label))),
          encodeValue(field.value as Proto),
        ]),
      ),
    ])
  }
  if (has(value, 'variant')) {
    const variant = value.variant as Proto
    return Buffer.concat([
      Buffer.from([0x0d]),
      encodeField(variant, 'variant_id', encodeIdentifier),
      encodeString(String(variant.constructor ?? '')),
      encodeValue(variant.value as Proto),
    ])
  }
  if (has(value, 'enum')) {
    const enumValue = value.enum as Proto
    return Buffer.concat([
      Buffer.from([0x0e]),
      encodeField(enumValue, 'enum_id', encodeIdentifier),
      encodeString(String(enumValue.constructor ?? '')),
    ])
  }
  if (has(value, 'gen_map')) {
    return Buffer.concat([
      Buffer.from([0x0f]),
      encodeRepeated(list((value.gen_map as Proto).entries), (entry) =>
        Buffer.concat([
          encodeValue(entry.key as Proto),
          encodeValue(entry.value as Proto),
        ]),
      ),
    ])
  }
  throw new Error('Unsupported Daml value')
}

function encodeIdentifier(identifier: Proto) {
  return Buffer.concat([
    encodeString(String(identifier.package_id ?? '')),
    encodeRepeated(String(identifier.module_name ?? '').split('.'), encodeString),
    encodeRepeated(String(identifier.entity_name ?? '').split('.'), encodeString),
  ])
}

function findSeed(nodeId: string, seeds: Proto[]) {
  const found = seeds.find((seed) => String(seed.node_id) === nodeId)
  if (!found?.seed) return null
  return Buffer.from(found.seed as Uint8Array)
}

function encodeField<T>(parent: object, field: string, encode: (value: T) => Buffer) {
  if (!has(parent, field)) return Buffer.from([0x00])
  return Buffer.concat([
    Buffer.from([0x01]),
    encode((parent as Record<string, T>)[field]),
  ])
}

function encodeOptional<T>(value: T | null, encode: (value: T) => Buffer) {
  if (value === null) return Buffer.from([0x00])
  return Buffer.concat([Buffer.from([0x01]), encode(value)])
}

function encodeRepeated<T>(values: T[], encode: (value: T) => Buffer) {
  return Buffer.concat([encodeInt32(values.length), ...values.map(encode)])
}

function encodeBool(value: boolean) {
  return Buffer.from([value ? 0x01 : 0x00])
}

function encodeInt32(value: number) {
  const buf = Buffer.alloc(4)
  buf.writeInt32BE(value)
  return buf
}

function encodeLong(value: unknown) {
  const buf = Buffer.alloc(8)
  buf.writeBigInt64BE(toBigInt(value))
  return buf
}

function encodeHash(value: Buffer) {
  return value
}

function encodeHex(value: string) {
  return encodeBytes(Buffer.from(value, 'hex'))
}

function encodeString(value: string) {
  return encodeBytes(Buffer.from(value, 'utf8'))
}

function encodeBytes(value: Buffer) {
  return Buffer.concat([encodeInt32(value.length), value])
}

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest()
}

function list(value: unknown): Proto[] {
  return Array.isArray(value) ? (value as Proto[]) : []
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.map(String) : []
}

function has(value: object, field: string) {
  return Object.hasOwn(value, field)
}

function toBigInt(value: unknown) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string') return BigInt(value)
  if (value && typeof value === 'object' && 'low' in value && 'high' in value) {
    const long = value as { low: number; high: number; unsigned?: boolean }
    const low = BigInt(long.low >>> 0)
    const high = BigInt(long.high >>> 0)
    const combined = (high << 32n) | low
    if (long.unsigned) return combined
    return long.high < 0 ? combined - (1n << 64n) : combined
  }
  throw new Error('Unable to encode integer')
}
