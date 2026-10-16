import { randomUUID } from 'node:crypto'
import { audienceAuthorization } from './auth/audienceJwt.js'
import {
  submitSignedCommand,
  type SinglePartyCommand,
} from './custody/submit.js'

const HOLDING_INTERFACE =
  '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding'
const TRANSFER_FACTORY_INTERFACE =
  '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory'
const TRANSFER_INSTRUCTION_INTERFACE =
  '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction'
const SIMPLE_HOLDING =
  '#simple-token:SimpleToken.Holding:SimpleHolding'
const USER_ID = 'CantonConsole'

export interface LedgerRequest {
  path: string
  method?: 'GET' | 'POST'
  query?: Record<string, string>
  body?: unknown
}

export interface CantonTransport {
  request(request: LedgerRequest): Promise<unknown> | unknown
}

export class HttpCantonTransport implements CantonTransport {
  constructor(private readonly baseUrl = 'http://127.0.0.1:5033') {}

  async request({ path, method = 'GET', query, body }: LedgerRequest) {
    const url = new URL(path, this.baseUrl)
    Object.entries(query ?? {}).forEach(([key, value]) =>
      url.searchParams.set(key, value),
    )
    const authorization = audienceAuthorization()
    const response = await fetch(url, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(authorization ? { authorization } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const cause =
        payload && typeof payload === 'object' && 'cause' in payload
          ? String(payload.cause)
          : ''
      // PACKAGE_NAMES_NOT_FOUND: the package name in the request is not in this participant's upgradeable package-name table.
      // A common cause is that upload-dars did not actually succeed, while parties were already created.
      const missingPackage =
        cause.includes('do not match upgradable packages uploaded')
          ? ' participant-shared does not have this upgradeable package. Re-run upload-dars.canton and confirm the output includes splice-api-token-holding-v1-1.0.0.dar @ global-sync, @ private-sync, and UPLOAD_DONE. Do not upload simple-token-0.1.0.dar'
          : ''
      const message = cause
        ? `${cause}${missingPackage}`
        : `Canton JSON API returned HTTP ${response.status}`
      throw new Error(message)
    }
    return payload
  }
}

interface Parties {
  alice: string
  admin: string
}

interface Synchronizers {
  global: string
  private: string
}

interface HoldingView {
  owner: string
  admin: string
  instrumentId: string
  amount: string
  locked?: boolean
}

export interface HoldingEntry extends HoldingView {
  contractId: string
  synchronizer: 'global-sync' | 'private-sync'
  reassignmentCounter: number
}

interface IssuanceView {
  admin: string
  owner: string
  amount: string
  instrumentId: {
    admin: string
    id: string
  }
}

interface TransferInstructionView {
  sender: string
  receiver: string
  amount: string
  instrumentId: {
    admin: string
    id: string
  }
}

interface StateBase {
  parties: Parties
  synchronizers: Synchronizers
  // Optional for existing callers; the real getState response always returns the full list.
  holdings?: HoldingEntry[]
}

export interface NotIssuedState extends StateBase {
  status: 'not-issued'
}

export interface ActiveState extends StateBase {
  status: 'active'
  contractId: string
  synchronizer: 'global-sync' | 'private-sync'
  synchronizerId: string
  reassignmentCounter: number
  holding: HoldingView
}

export interface ReassigningState extends StateBase {
  status: 'reassigning'
  contractId: string
  reassignmentId: string
  sourceSynchronizerId: string
  targetSynchronizerId: string
}

export type DemoState = NotIssuedState | ActiveState | ReassigningState

export type SyncAlias = 'global-sync' | 'private-sync'

export interface PartyRef {
  id: string
  hint: string
}

export interface PartyCatalog {
  synchronizers: Record<
    SyncAlias,
    {
      id: string
      parties: PartyRef[]
    }
  >
}

export interface AcsQuery {
  synchronizer: string
  party: string
}

export interface AcsContract {
  contractId: string
  templateId: string
  status: 'active' | 'reassigning'
  synchronizerId?: string
  reassignmentCounter: number
  signatories: string[]
  observers: string[]
  createArgument: unknown
  holding?: HoldingView
  transferInstruction?: TransferInstructionView
  issuance?: IssuanceView
  reassignmentId?: string
  sourceSynchronizerId?: string
  targetSynchronizerId?: string
}

export interface TransferRequest {
  synchronizer: string
  actor: string
  contractId: string
  receiver: string
}

export interface TransferInstructionRequest {
  synchronizer: string
  actor: string
  contractId: string
  action: 'accept' | 'reject' | 'withdraw'
}

export interface WhitelistRequest {
  synchronizer: string
  actor: string
  observers: string[]
}

export interface RefreshVisibilityRequest {
  synchronizer: string
  actor: string
  contractId: string
}

export interface IssueRequest {
  actor: string
  receiver: string
  amount: string
}

export interface IssuanceRequest {
  synchronizer: string
  actor: string
  contractId: string
  action: 'accept' | 'withdraw'
}

export interface ReassignRequest {
  synchronizer: string
  actor: string
  contractId: string
}

export interface AcsSnapshot {
  synchronizer: SyncAlias
  synchronizerId: string
  party: PartyRef
  offset: number
  contracts: AcsContract[]
}

export type CommandSubmitter = (
  transport: CantonTransport,
  command: SinglePartyCommand,
) => Promise<{ updateId: string }>

interface CantonClientOptions {
  autoAssignPolls?: number
  pollIntervalMs?: number
  submitCommand?: CommandSubmitter
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Canton returned data that could not be recognized')
  }
  return value as Record<string, unknown>
}

function findParty(payload: unknown, hint: string): string {
  const details = asRecord(payload).partyDetails
  if (!Array.isArray(details)) throw new Error('Canton did not return partyDetails')
  const party = details
    .map(asRecord)
    .map((entry) => entry.party)
    .find((value) => typeof value === 'string' && value.startsWith(`${hint}::`))
  if (typeof party !== 'string') throw new Error(`Local party not found: ${hint}`)
  return party
}

function holdingFromCreatedEvent(event: Record<string, unknown>): HoldingView {
  const views = event.interfaceViews
  if (!Array.isArray(views) || views.length === 0) {
    throw new Error('CIP-56 Holding interface view is missing')
  }
  const records = views.map(asRecord)
  const view = records.find((candidate) =>
      String(candidate.interfaceId ?? '').endsWith(
        ':Splice.Api.Token.HoldingV1:Holding',
      ),
    ) ?? records.find((candidate) => candidate.viewValue !== undefined)
  if (!view) throw new Error('CIP-56 Holding interface view is missing')
  const status = asRecord(view.viewStatus)
  if (status.code !== 0) throw new Error('Failed to compute the CIP-56 Holding interface view')
  const value = asRecord(view.viewValue)
  const instrument = asRecord(value.instrumentId)
  return {
    owner: String(value.owner),
    admin: String(instrument.admin),
    instrumentId: String(instrument.id),
    amount: String(value.amount),
    locked: value.lock !== null && value.lock !== undefined,
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function partyHint(party: string) {
  return party.split('::')[0] ?? party
}

function asPartyRef(party: string): PartyRef {
  return { id: party, hint: partyHint(party) }
}

function isSyncAlias(value: string): value is SyncAlias {
  return value === 'global-sync' || value === 'private-sync'
}

// Submit Daml Decimal values as strings. Do not use floats, scientific notation, or more precision than Numeric 10.
export function isValidIssueAmount(value: string) {
  return /^(?:0|[1-9]\d{0,27})(?:\.\d{1,10})?$/.test(value) &&
    /[1-9]/.test(value)
}

function listLocalParties(payload: unknown): string[] {
  const details = asRecord(payload).partyDetails
  if (!Array.isArray(details)) throw new Error('Canton did not return partyDetails')
  return details
    .map(asRecord)
    .filter((entry) => entry.isLocal !== false)
    .map((entry) => entry.party)
    .filter((party): party is string => typeof party === 'string')
}

function sortPartyRefs(parties: PartyRef[]) {
  return [...parties].sort((left, right) => {
    const rank = (hint: string) => (hint === 'RegistryAdmin' ? 0 : 1)
    const byRole = rank(left.hint) - rank(right.hint)
    return byRole !== 0 ? byRole : left.hint.localeCompare(right.hint)
  })
}

function connectedByAlias(payload: unknown) {
  const connected = asRecord(payload).connectedSynchronizers
  if (!Array.isArray(connected)) {
    throw new Error('Canton did not return connectedSynchronizers')
  }
  return new Map(
    connected.map((entry) => {
      const sync = asRecord(entry)
      return [String(sync.synchronizerAlias), String(sync.synchronizerId)]
    }),
  )
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function contractFromCreatedEvent(
  event: Record<string, unknown>,
): Omit<
  AcsContract,
  'status' | 'reassignmentCounter' | 'synchronizerId' | 'reassignmentId'
> {
  let holding: HoldingView | undefined
  try {
    holding = holdingFromCreatedEvent(event)
  } catch {
    holding = undefined
  }
  const issuance = issuanceFromCreatedEvent(event)
  let transferInstruction: TransferInstructionView | undefined
  try {
    const createArgument = asRecord(
      event.createArgument ?? event.createArguments,
    )
    const transfer = asRecord(createArgument.transfer)
    const instrumentId = asRecord(transfer.instrumentId)
    if (
      typeof transfer.sender === 'string' &&
      typeof transfer.receiver === 'string'
    ) {
      transferInstruction = {
        sender: transfer.sender,
        receiver: transfer.receiver,
        amount: String(transfer.amount),
        instrumentId: {
          admin: String(instrumentId.admin),
          id: String(instrumentId.id),
        },
      }
    }
  } catch {
    transferInstruction = undefined
  }
  return {
    contractId: String(event.contractId),
    templateId: String(event.templateId ?? 'unknown'),
    signatories: stringList(event.signatories),
    observers: stringList(event.observers),
    createArgument: event.createArgument ?? event.createArguments ?? null,
    holding,
    transferInstruction,
    issuance,
  }
}

function issuanceFromCreatedEvent(
  event: Record<string, unknown>,
): IssuanceView | undefined {
  const templateId = String(event.templateId ?? '')
  if (!templateId.endsWith(':SimpleToken.Issuance:IssuanceInstruction')) {
    return undefined
  }
  const argument = asRecord(event.createArgument ?? event.createArguments)
  const instrumentId = asRecord(argument.instrumentId)
  if (typeof argument.owner !== 'string' || typeof argument.admin !== 'string') {
    return undefined
  }
  return {
    admin: argument.admin,
    owner: argument.owner,
    amount: String(argument.amount),
    instrumentId: {
      admin: String(instrumentId.admin),
      id: String(instrumentId.id),
    },
  }
}

function acsEventFormat(party: string) {
  return {
    filtersByParty: {
      [party]: {
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
                  interfaceId: HOLDING_INTERFACE,
                  includeInterfaceView: true,
                  includeCreatedEventBlob: false,
                },
              },
            },
          },
        ],
      },
    },
    verbose: true,
  }
}

export class CantonClient {
  private readonly autoAssignPolls: number
  private readonly pollIntervalMs: number
  private readonly submitCommand: CommandSubmitter
  private mutationInFlight = false

  constructor(
    private readonly transport: CantonTransport,
    options: CantonClientOptions = {},
  ) {
    this.autoAssignPolls = options.autoAssignPolls ?? 8
    this.pollIntervalMs = options.pollIntervalMs ?? 500
    this.submitCommand = options.submitCommand ?? submitSignedCommand
  }

  private submitSingle(
    workflowId: string,
    actAs: string,
    synchronizerId: string,
    commands: unknown[],
    readAs: string[] = [],
  ) {
    return this.submitCommand(this.transport, {
      commandId: `${workflowId}-${randomUUID()}`,
      workflowId,
      actAs,
      readAs,
      synchronizerId,
      commands,
    })
  }

  private async context(): Promise<StateBase> {
    const partyPayload = await this.transport.request({ path: '/v2/parties' })
    const parties = {
      alice: findParty(partyPayload, 'Alice'),
      admin: findParty(partyPayload, 'RegistryAdmin'),
    }
    const syncPayload = asRecord(
      await this.transport.request({
        path: '/v2/state/connected-synchronizers',
        query: { party: parties.alice },
      }),
    )
    const connected = syncPayload.connectedSynchronizers
    if (!Array.isArray(connected)) {
      throw new Error('Canton did not return connectedSynchronizers')
    }
    const byAlias = new Map(
      connected.map((entry) => {
        const sync = asRecord(entry)
        return [sync.synchronizerAlias, sync.synchronizerId]
      }),
    )
    const global = byAlias.get('global-sync')
    const privateSync = byAlias.get('private-sync')
    if (typeof global !== 'string' || typeof privateSync !== 'string') {
      throw new Error('participant-shared is not connected to both global-sync and private-sync')
    }
    return { parties, synchronizers: { global, private: privateSync } }
  }

  async getState(): Promise<DemoState> {
    const context = await this.context()
    const ledgerEnd = asRecord(
      await this.transport.request({ path: '/v2/state/ledger-end' }),
    )
    if (typeof ledgerEnd.offset !== 'number') {
      throw new Error('Canton did not return a valid ledger offset')
    }
    const filter = {
      identifierFilter: {
        InterfaceFilter: {
          value: {
            interfaceId: HOLDING_INTERFACE,
            includeInterfaceView: true,
            includeCreatedEventBlob: false,
          },
        },
      },
    }
    const payload = await this.transport.request({
      path: '/v2/state/active-contracts',
      method: 'POST',
      body: {
        activeAtOffset: ledgerEnd.offset,
        eventFormat: {
          filtersByParty: {
            [context.parties.admin]: { cumulative: [filter] },
          },
          verbose: true,
        },
      },
    })
    if (!Array.isArray(payload) || payload.length === 0) {
      return { status: 'not-issued', holdings: [], ...context }
    }

    const holdings: HoldingEntry[] = []
    let primary: DemoState | undefined
    for (const response of payload) {
      const entry = asRecord(asRecord(response).contractEntry)
      if (entry.JsActiveContract) {
        const active = asRecord(entry.JsActiveContract)
        const event = asRecord(active.createdEvent)
        const synchronizerId = String(active.synchronizerId)
        const alias = synchronizerId.startsWith('global-sync::')
          ? 'global-sync'
          : 'private-sync'
        const holding = holdingFromCreatedEvent(event)
        const contractId = String(event.contractId)
        const reassignmentCounter = Number(active.reassignmentCounter)
        holdings.push({
          contractId,
          synchronizer: alias,
          reassignmentCounter,
          ...holding,
        })
        if (!primary) {
          primary = {
            status: 'active',
            contractId,
            synchronizer: alias,
            synchronizerId,
            reassignmentCounter,
            holding,
            ...context,
          }
        }
        continue
      }
      if (entry.JsIncompleteAssigned) {
        const incomplete = asRecord(entry.JsIncompleteAssigned)
        const assigned = asRecord(incomplete.assignedEvent)
        const event = asRecord(assigned.createdEvent)
        const synchronizerId = String(assigned.target)
        const synchronizer = synchronizerId.startsWith('global-sync::')
          ? 'global-sync'
          : 'private-sync'
        const holding = holdingFromCreatedEvent(event)
        const contractId = String(event.contractId)
        const reassignmentCounter = Number(assigned.reassignmentCounter)
        holdings.push({
          contractId,
          synchronizer,
          reassignmentCounter,
          ...holding,
        })
        if (!primary) {
          primary = {
            status: 'active',
            contractId,
            synchronizer,
            synchronizerId,
            reassignmentCounter,
            holding,
            ...context,
          }
        }
        continue
      }
      if (entry.JsIncompleteUnassigned) {
        const incomplete = asRecord(entry.JsIncompleteUnassigned)
        const event = asRecord(incomplete.createdEvent)
        const unassigned = asRecord(incomplete.unassignedEvent)
        if (!primary) {
          primary = {
            status: 'reassigning',
            contractId: String(event.contractId),
            reassignmentId: String(unassigned.reassignmentId),
            sourceSynchronizerId: String(unassigned.source),
            targetSynchronizerId: String(unassigned.target),
            ...context,
          }
        }
      }
    }
    return primary
      ? { ...primary, holdings }
      : { status: 'not-issued', holdings, ...context }
  }

  async getPartyCatalog(): Promise<PartyCatalog> {
    const partyPayload = await this.transport.request({ path: '/v2/parties' })
    const parties = listLocalParties(partyPayload)
    const grouped: PartyCatalog = {
      synchronizers: {
        'global-sync': { id: '', parties: [] },
        'private-sync': { id: '', parties: [] },
      },
    }
    for (const party of parties) {
      const byAlias = connectedByAlias(
        await this.transport.request({
          path: '/v2/state/connected-synchronizers',
          query: { party },
        }),
      )
      for (const alias of ['global-sync', 'private-sync'] as const) {
        const id = byAlias.get(alias)
        if (!id) continue
        grouped.synchronizers[alias].id = id
        grouped.synchronizers[alias].parties.push(asPartyRef(party))
      }
    }
    grouped.synchronizers['global-sync'].parties = sortPartyRefs(
      grouped.synchronizers['global-sync'].parties,
    )
    grouped.synchronizers['private-sync'].parties = sortPartyRefs(
      grouped.synchronizers['private-sync'].parties,
    )
    return grouped
  }

  async getAcs(query: AcsQuery): Promise<AcsSnapshot> {
    if (!isSyncAlias(query.synchronizer)) {
      throw new Error('Unknown synchronizer')
    }
    const partyPayload = await this.transport.request({ path: '/v2/parties' })
    const parties = listLocalParties(partyPayload)
    if (!parties.includes(query.party)) {
      throw new Error('Unknown party')
    }
    const byAlias = connectedByAlias(
      await this.transport.request({
        path: '/v2/state/connected-synchronizers',
        query: { party: query.party },
      }),
    )
    const synchronizerId = byAlias.get(query.synchronizer)
    if (!synchronizerId) {
      throw new Error('Unknown synchronizer')
    }
    const ledgerEnd = asRecord(
      await this.transport.request({ path: '/v2/state/ledger-end' }),
    )
    if (typeof ledgerEnd.offset !== 'number') {
      throw new Error('Canton did not return a valid ledger offset')
    }
    const payload = await this.transport.request({
      path: '/v2/state/active-contracts',
      method: 'POST',
      body: {
        activeAtOffset: ledgerEnd.offset,
        eventFormat: acsEventFormat(query.party),
      },
    })
    const contracts: AcsContract[] = []
    if (Array.isArray(payload)) {
      for (const response of payload) {
        const entry = asRecord(asRecord(response).contractEntry)
        if (entry.JsActiveContract) {
          const active = asRecord(entry.JsActiveContract)
          if (String(active.synchronizerId) !== synchronizerId) continue
          const event = asRecord(active.createdEvent)
          contracts.push({
            ...contractFromCreatedEvent(event),
            status: 'active',
            synchronizerId: String(active.synchronizerId),
            reassignmentCounter: Number(active.reassignmentCounter),
          })
        }
        if (entry.JsIncompleteAssigned) {
          const incomplete = asRecord(entry.JsIncompleteAssigned)
          const assigned = asRecord(incomplete.assignedEvent)
          if (String(assigned.target) !== synchronizerId) continue
          const event = asRecord(assigned.createdEvent)
          contracts.push({
            ...contractFromCreatedEvent(event),
            status: 'active',
            synchronizerId: String(assigned.target),
            reassignmentCounter: Number(assigned.reassignmentCounter),
          })
        }
        if (entry.JsIncompleteUnassigned) {
          const incomplete = asRecord(entry.JsIncompleteUnassigned)
          const unassigned = asRecord(incomplete.unassignedEvent)
          if (String(unassigned.source) !== synchronizerId) continue
          const event = asRecord(incomplete.createdEvent)
          contracts.push({
            ...contractFromCreatedEvent(event),
            status: 'reassigning',
            reassignmentCounter: Number(unassigned.reassignmentCounter),
            reassignmentId: String(unassigned.reassignmentId),
            sourceSynchronizerId: String(unassigned.source),
            targetSynchronizerId: String(unassigned.target),
          })
        }
      }
    }
    return {
      synchronizer: query.synchronizer,
      synchronizerId,
      party: asPartyRef(query.party),
      offset: ledgerEnd.offset,
      contracts,
    }
  }

  async transfer(request: TransferRequest) {
    return this.mutate(async () => {
      if (!isSyncAlias(request.synchronizer)) {
        throw new Error('Unknown synchronizer')
      }
      const catalog = await this.getPartyCatalog()
      const sync = catalog.synchronizers[request.synchronizer]
      if (!sync.parties.some((party) => party.id === request.receiver)) {
        throw new Error('The receiver is not registered on the selected synchronizer')
      }
      if (request.actor === request.receiver) {
        throw new Error('A two-step transfer receiver cannot be the sender')
      }
      const actorAcs = await this.getAcs({
        synchronizer: request.synchronizer,
        party: request.actor,
      })
      const holding = actorAcs.contracts.find(
        (contract) => contract.contractId === request.contractId,
      )
      if (
        !holding?.holding ||
        holding.status !== 'active' ||
        holding.holding.owner !== request.actor
      ) {
        throw new Error('Only the Holding owner can start a transfer')
      }
      if (holding.holding.locked) {
        throw new Error('A locked Holding cannot be transferred again')
      }
      const admin = holding.holding.admin
      const adminAcs = await this.getAcs({
        synchronizer: request.synchronizer,
        party: admin,
      })
      const rules = adminAcs.contracts.find((contract) =>
        contract.templateId.endsWith(
          ':SimpleToken.Rules:SimpleTokenRules',
        ),
      )
      if (!rules) throw new Error('TransferFactory was not found on the current synchronizer')

      const now = new Date()
      const deadline = new Date(now.getTime() + 60 * 60 * 1000)
      const submitted = await this.submitSingle(
        'cip56-demo-transfer',
        request.actor,
        actorAcs.synchronizerId,
        [
          {
            ExerciseCommand: {
              templateId: TRANSFER_FACTORY_INTERFACE,
              contractId: rules.contractId,
              choice: 'TransferFactory_Transfer',
              choiceArgument: {
                expectedAdmin: admin,
                transfer: {
                  sender: request.actor,
                  receiver: request.receiver,
                  amount: holding.holding.amount,
                  instrumentId: {
                    admin,
                    id: holding.holding.instrumentId,
                  },
                  requestedAt: now.toISOString(),
                  executeBefore: deadline.toISOString(),
                  inputHoldingCids: [holding.contractId],
                  meta: { values: {} },
                },
                extraArgs: {
                  context: { values: {} },
                  meta: { values: {} },
                },
              },
            },
          },
        ],
        [admin],
      )
      return { updateId: submitted.updateId }
    })
  }

  async actOnTransferInstruction(request: TransferInstructionRequest) {
    return this.mutate(async () => {
      if (!isSyncAlias(request.synchronizer)) {
        throw new Error('Unknown synchronizer')
      }
      const actorAcs = await this.getAcs({
        synchronizer: request.synchronizer,
        party: request.actor,
      })
      const instruction = actorAcs.contracts.find(
        (contract) => contract.contractId === request.contractId,
      )
      const transfer = instruction?.transferInstruction
      if (!instruction || !transfer || instruction.status !== 'active') {
        throw new Error('No actionable TransferInstruction was found')
      }
      if (
        (request.action === 'accept' || request.action === 'reject') &&
        transfer.receiver !== request.actor
      ) {
        throw new Error('Only the receiver can accept or reject a transfer')
      }
      if (
        request.action === 'withdraw' &&
        transfer.sender !== request.actor
      ) {
        throw new Error('Only the sender can withdraw a transfer')
      }
      const choice = {
        accept: 'TransferInstruction_Accept',
        reject: 'TransferInstruction_Reject',
        withdraw: 'TransferInstruction_Withdraw',
      }[request.action]
      const submitted = await this.submitSingle(
        'cip56-demo-transfer-instruction',
        request.actor,
        actorAcs.synchronizerId,
        [
          {
            ExerciseCommand: {
              templateId: TRANSFER_INSTRUCTION_INTERFACE,
              contractId: instruction.contractId,
              choice,
              choiceArgument: {
                extraArgs: {
                  context: { values: {} },
                  meta: { values: {} },
                },
              },
            },
          },
        ],
      )
      return { updateId: submitted.updateId, action: request.action }
    })
  }

  async updateWhitelist(request: WhitelistRequest) {
    return this.mutate(async () => {
      if (!isSyncAlias(request.synchronizer)) {
        throw new Error('Unknown synchronizer')
      }
      const catalog = await this.getPartyCatalog()
      const allowedParties = catalog.synchronizers[
        request.synchronizer
      ].parties.filter((party) => !party.hint.startsWith('participant-'))
      const allowedIds = new Set(allowedParties.map((party) => party.id))
      if (
        request.observers.length > 32 ||
        request.observers.some((party) => !allowedIds.has(party))
      ) {
        throw new Error('The allowlist contains an unregistered business party')
      }
      const acs = await this.getAcs({
        synchronizer: request.synchronizer,
        party: request.actor,
      })
      const policy = acs.contracts.find((contract) =>
        contract.templateId.endsWith(
          ':SimpleToken.Visibility:VisibilityPolicy',
        ),
      )
      const rules = acs.contracts.find((contract) =>
        contract.templateId.endsWith(
          ':SimpleToken.Rules:SimpleTokenRules',
        ),
      )
      if (!policy || !rules || !policy.signatories.includes(request.actor)) {
        throw new Error('Only RegistryAdmin can update the allowlist')
      }
      const readers = Array.from(
        new Set([
          ...allowedParties.map((party) => party.id),
          ...policy.signatories,
          ...policy.observers,
          ...request.observers,
        ]),
      )
      const submitted = await this.submitSingle(
        'cip56-demo-visibility-policy-rules',
        request.actor,
        acs.synchronizerId,
        [
          {
            ExerciseCommand: {
              templateId: rules.templateId,
              contractId: rules.contractId,
              choice: 'SimpleTokenRules_UpdateVisibilityPolicy',
              choiceArgument: {
                policyCid: policy.contractId,
                observers: request.observers,
                readers,
              },
            },
          },
        ],
      )
      return { policyUpdateId: submitted.updateId }
    })
  }

  async refreshVisibility(request: RefreshVisibilityRequest) {
    return this.mutate(async () => {
      if (!isSyncAlias(request.synchronizer)) {
        throw new Error('Unknown synchronizer')
      }
      const actorAcs = await this.getAcs({
        synchronizer: request.synchronizer,
        party: request.actor,
      })
      const holding = actorAcs.contracts.find(
        (contract) => contract.contractId === request.contractId,
      )
      if (!holding?.holding || holding.holding.owner !== request.actor) {
        throw new Error('Only the Holding owner can refresh visibility')
      }
      if (holding.holding.locked) {
        throw new Error('A locked Holding cannot have its visibility refreshed')
      }
      const admin = holding.holding.admin
      const adminAcs = await this.getAcs({
        synchronizer: request.synchronizer,
        party: admin,
      })
      const policy = adminAcs.contracts.find((contract) =>
        contract.templateId.endsWith(
          ':SimpleToken.Visibility:VisibilityPolicy',
        ),
      )
      if (!policy) throw new Error('No visibility policy was found on the current synchronizer')
      const submitted = await this.submitSingle(
        'cip56-demo-refresh-visibility',
        request.actor,
        actorAcs.synchronizerId,
        [
          {
            ExerciseCommand: {
              templateId: holding.templateId,
              contractId: holding.contractId,
              choice: 'SimpleHolding_RefreshVisibility',
              choiceArgument: { policyCid: policy.contractId },
            },
          },
        ],
      )
      return { updateId: submitted.updateId, policyCid: policy.contractId }
    })
  }

  async issue(request: IssueRequest) {
    return this.mutate(() => this.issueInternal(request))
  }

  private async issueInternal(request: IssueRequest) {
    const state = await this.getState()
    if (request.actor !== state.parties.admin) {
      throw new Error('Only RegistryAdmin can issue a Holding')
    }
    if (!isValidIssueAmount(request.amount)) {
      throw new Error('Provide a valid issuance amount')
    }
    const catalog = await this.getPartyCatalog()
    const allowedReceivers = catalog.synchronizers[
      'global-sync'
    ].parties.filter((party) => !party.hint.startsWith('participant-'))
    if (!allowedReceivers.some((party) => party.id === request.receiver)) {
      throw new Error('Unknown party: the issuance receiver is not registered on global-sync')
    }
    const adminAcs = await this.getAcs({
      synchronizer: 'global-sync',
      party: state.parties.admin,
    })
    const policy = adminAcs.contracts.find((contract) =>
      contract.templateId.endsWith(
        ':SimpleToken.Visibility:VisibilityPolicy',
      ),
    )
    const rules = adminAcs.contracts.find((contract) =>
      contract.templateId.endsWith(':SimpleToken.Rules:SimpleTokenRules'),
    )
    if (!policy || !rules) throw new Error('The visibility policy on global-sync has not been initialized')
    const submitted = await this.submitSingle(
      'cip56-demo-issue',
      state.parties.admin,
      state.synchronizers.global,
      [
        {
          ExerciseCommand: {
            templateId: rules.templateId,
            contractId: rules.contractId,
            choice: 'SimpleTokenRules_Issue',
            choiceArgument: {
              owner: request.receiver,
              instrumentId: {
                admin: state.parties.admin,
                id: 'HSKD',
              },
              amount: request.amount,
            },
          },
        },
      ],
    )
    return {
      updateId: submitted.updateId,
      synchronizer: 'global-sync' as const,
    }
  }

  async actOnIssuance(request: IssuanceRequest) {
    return this.mutate(async () => {
      if (!isSyncAlias(request.synchronizer)) {
        throw new Error('Unknown synchronizer')
      }
      const actorAcs = await this.getAcs({
        synchronizer: request.synchronizer,
        party: request.actor,
      })
      const instruction = actorAcs.contracts.find(
        (contract) => contract.contractId === request.contractId,
      )
      if (!instruction?.issuance || instruction.status !== 'active') {
        throw new Error('No actionable issuance instruction was found')
      }
      if (
        request.action === 'accept' &&
        instruction.issuance.owner !== request.actor
      ) {
        throw new Error('Only the receiver can accept issuance')
      }
      if (
        request.action === 'withdraw' &&
        instruction.issuance.admin !== request.actor
      ) {
        throw new Error('Only RegistryAdmin can withdraw issuance')
      }
      const choice =
        request.action === 'accept'
          ? 'IssuanceInstruction_Accept'
          : 'IssuanceInstruction_Withdraw'
      const submitted = await this.submitSingle(
        'cip56-demo-issuance',
        request.actor,
        actorAcs.synchronizerId,
        [
          {
            ExerciseCommand: {
              templateId: instruction.templateId,
              contractId: instruction.contractId,
              choice,
              choiceArgument: {},
            },
          },
        ],
      )
      return { updateId: submitted.updateId, action: request.action }
    })
  }

  async reassign(request: ReassignRequest) {
    return this.mutate(() => this.reassignInternal(request))
  }

  private async reassignInternal(request: ReassignRequest) {
    const state = await this.getState()
    if (state.status === 'not-issued') {
      throw new Error('Issue an HSKD Holding first')
    }
    const selected =
      state.holdings?.find(
        (holding) =>
          holding.contractId === request.contractId &&
          holding.synchronizer === request.synchronizer,
      ) ??
      (state.status === 'active' &&
      state.contractId === request.contractId &&
      state.synchronizer === request.synchronizer
        ? {
            contractId: state.contractId,
            synchronizer: state.synchronizer,
            reassignmentCounter: state.reassignmentCounter,
            ...state.holding,
          }
        : undefined)
    if (
      !selected ||
      request.actor !== selected.owner
    ) {
      throw new Error('Only the Holding owner can reassign a Holding')
    }
    if (selected.locked) {
      throw new Error('A locked Holding cannot be reassigned until the transfer completes')
    }
    const actor = request.actor
    const isGlobal = request.synchronizer === 'global-sync'
    const source = isGlobal
      ? state.synchronizers.global
      : state.synchronizers.private
    const target = isGlobal
      ? state.synchronizers.private
      : state.synchronizers.global
    const targetAlias = isGlobal ? 'private-sync' : 'global-sync'
    const commandBase = {
      workflowId: 'cip56-demo-reassign',
      userId: USER_ID,
      submitter: actor,
    }
    const eventFormat = {
      filtersByParty: {
        [actor]: {
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
      verbose: false,
    }
    const unassignId = randomUUID()
    const unassignPayload = asRecord(
      await this.transport.request({
        path: '/v2/commands/submit-and-wait-for-reassignment',
        method: 'POST',
        body: {
          eventFormat,
          reassignmentCommands: {
            ...commandBase,
            commandId: `unassign-${unassignId}`,
            submissionId: unassignId,
            commands: [
              {
                command: {
                  UnassignCommand: {
                    value: {
                      contractId: request.contractId,
                      source,
                      target,
                    },
                  },
                },
              },
            ],
          },
        },
      }),
    )
    const unassign = asRecord(unassignPayload.reassignment)
    const events = unassign.events
    if (!Array.isArray(events)) throw new Error('Unassign did not return events')
    const unassignedEvent = events
      .map(asRecord)
      .find((event) => event.JsUnassignedEvent)
    if (!unassignedEvent) throw new Error('Unassign did not return a reassignmentId')
    const reassignmentId = String(
      asRecord(asRecord(unassignedEvent.JsUnassignedEvent).value).reassignmentId,
    )

    for (let attempt = 0; attempt < this.autoAssignPolls; attempt += 1) {
      if (attempt > 0) await delay(this.pollIntervalMs)
      try {
        const latest = await this.getState()
        const assignedAtTarget =
          latest.holdings?.some(
            (holding) =>
              holding.contractId === request.contractId &&
              holding.synchronizer === targetAlias,
          ) ??
          (latest.status === 'active' &&
            latest.contractId === request.contractId &&
            latest.synchronizerId === target)
        if (assignedAtTarget) {
          return {
            source: request.synchronizer,
            target: targetAlias,
            reassignmentId,
            updateId: String(unassign.updateId),
            automatic: true,
          }
        }
      } catch {
        // If the ACS is briefly unavailable, continue with a manual assign so the contract does not stay incomplete.
      }
    }

    const assignId = randomUUID()
    try {
      const assignPayload = asRecord(await this.transport.request({
        path: '/v2/commands/submit-and-wait-for-reassignment',
        method: 'POST',
        body: {
          eventFormat,
          reassignmentCommands: {
            ...commandBase,
            commandId: `assign-${assignId}`,
            submissionId: assignId,
            commands: [
              {
                command: {
                  AssignCommand: {
                    value: { reassignmentId, source, target },
                  },
                },
              },
            ],
          },
        },
      }))
      const assign = asRecord(assignPayload.reassignment)
      return {
        source: request.synchronizer,
        target: targetAlias,
        reassignmentId,
        updateId: String(assign.updateId),
        automatic: false,
      }
    } catch (error) {
      let latest: DemoState
      try {
        latest = await this.getState()
      } catch {
        throw error
      }
      const assignedAtTarget =
        latest.holdings?.some(
          (holding) =>
            holding.contractId === request.contractId &&
            holding.synchronizer === targetAlias,
        ) ??
        (latest.status === 'active' &&
          latest.contractId === request.contractId &&
          latest.synchronizerId === target)
      if (!assignedAtTarget) {
        throw error
      }
      return {
        source: request.synchronizer,
        target: targetAlias,
        reassignmentId,
        updateId: String(unassign.updateId),
        automatic: true,
      }
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.mutationInFlight) {
      throw new Error('Another change is already running. Retry shortly.')
    }
    this.mutationInFlight = true
    try {
      return await operation()
    } finally {
      this.mutationInFlight = false
    }
  }
}
