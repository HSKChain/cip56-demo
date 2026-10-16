import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  CantonClient,
  HttpCantonTransport,
  type AcsSnapshot,
  type CantonTransport,
  type CommandSubmitter,
  type PartyCatalog,
  type SyncAlias,
} from './canton.js'
import { ensureExternalParties } from './custody/parties.js'
import { submitSignedCommand } from './custody/submit.js'

interface InitializerClient {
  getPartyCatalog(): Promise<PartyCatalog>
  getAcs(query: { synchronizer: string; party: string }): Promise<AcsSnapshot>
}

interface InitializationResult {
  synchronizer: SyncAlias
  status: 'created' | 'existing'
  updateId?: string
}

const SYNCHRONIZERS: SyncAlias[] = ['global-sync', 'private-sync']

export async function initializeVisibility(
  client: InitializerClient,
  transport: CantonTransport,
  submitCommand: CommandSubmitter = submitSignedCommand,
): Promise<InitializationResult[]> {
  const catalog = await client.getPartyCatalog()
  const results: InitializationResult[] = []

  for (const synchronizer of SYNCHRONIZERS) {
    const sync = catalog.synchronizers[synchronizer]
    const admin = sync.parties.find((party) => party.hint === 'RegistryAdmin')
    if (!admin) throw new Error(`${synchronizer} RegistryAdmin was not found`)

    const acs = await client.getAcs({ synchronizer, party: admin.id })
    const hasPolicy = acs.contracts.some((contract) =>
      contract.templateId.endsWith(
        ':SimpleToken.Visibility:VisibilityPolicy',
      ),
    )
    const hasRules = acs.contracts.some((contract) =>
      contract.templateId.endsWith(':SimpleToken.Rules:SimpleTokenRules'),
    )
    if (hasPolicy && hasRules) {
      results.push({ synchronizer, status: 'existing' })
      continue
    }
    if (hasPolicy !== hasRules) {
      throw new Error(`${synchronizer} has an incomplete Policy/Rules state. Reset the local network first`)
    }

    const readers = sync.parties
      .filter((party) => !party.hint.startsWith('participant-'))
      .map((party) => party.id)
    const submitCreate = async (
      templateId: string,
      createArguments: Record<string, unknown>,
    ) => {
      const submitted = await submitCommand(transport, {
        commandId: `initialize-visibility-${synchronizer}-${randomUUID()}`,
        workflowId: 'cip56-demo-initialize-visibility',
        actAs: admin.id,
        synchronizerId: sync.id,
        commands: [
          {
            CreateCommand: {
              templateId,
              createArguments,
            },
          },
        ],
      })
      return submitted.updateId
    }
    await submitCreate(
      '#simple-token:SimpleToken.Visibility:VisibilityPolicy',
      {
        admin: admin.id,
        instrumentId: { admin: admin.id, id: 'HSKD' },
        observers: [],
        readers,
        version: 1,
      },
    )
    const updateId = await submitCreate(
      '#simple-token:SimpleToken.Rules:SimpleTokenRules',
      {
        admin: admin.id,
        supportedInstruments: ['HSKD'],
        visibility: { observers: [], policyVersion: 1 },
      },
    )
    results.push({ synchronizer, status: 'created', updateId })
  }

  return results
}

async function main() {
  const transport = new HttpCantonTransport()
  await ensureExternalParties(transport)
  const results = await initializeVisibility(
    new CantonClient(transport),
    transport,
  )
  for (const result of results) {
    console.log(
      `[visibility] ${result.synchronizer}: ${result.status}` +
        (result.updateId ? ` (${result.updateId})` : ''),
    )
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
