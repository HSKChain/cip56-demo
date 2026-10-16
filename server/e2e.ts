import {
  CantonClient,
  HttpCantonTransport,
  type AcsContract,
  type SyncAlias,
} from './canton.js'

function requireContract(
  contracts: AcsContract[],
  predicate: (contract: AcsContract) => boolean,
  message: string,
) {
  const contract = contracts.find(predicate)
  if (!contract) throw new Error(message)
  return contract
}

async function main() {
  const transport = new HttpCantonTransport()
  const client = new CantonClient(transport)
  const catalog = await client.getPartyCatalog()
  const parties = catalog.synchronizers['global-sync'].parties
  const party = (hint: string) => {
    const found = parties.find((entry) => entry.hint === hint)
    if (!found) throw new Error(`Party ${hint} was not found on global-sync`)
    return found.id
  }
  const admin = party('RegistryAdmin')
  const alice = party('Alice')
  const bob = party('Bob')

  const acs = (synchronizer: SyncAlias, actor: string) =>
    client.getAcs({ synchronizer, party: actor })
  const holding = async (synchronizer: SyncAlias, owner: string) =>
    requireContract(
      (await acs(synchronizer, owner)).contracts,
      (contract) =>
        contract.status === 'active' && contract.holding?.owner === owner,
      `No Holding for ${owner} on ${synchronizer}`,
    )
  const instruction = async (actor: string) =>
    requireContract(
      (await acs('global-sync', actor)).contracts,
      (contract) => Boolean(contract.transferInstruction),
      `No TransferInstruction visible to ${actor}`,
    )
  const transfer = async (sender: string, receiver: string) => {
    const source = await holding('global-sync', sender)
    await client.transfer({
      synchronizer: 'global-sync',
      actor: sender,
      contractId: source.contractId,
      receiver,
    })
  }

  console.log('[e2e] 1/9 RegistryAdmin issues; Alice accepts alone')
  await client.issue({
    actor: admin,
    receiver: alice,
    amount: '100.0000000000',
  })
  const issuance = requireContract(
    (await acs('global-sync', alice)).contracts,
    (contract) =>
      contract.templateId.endsWith(':SimpleToken.Issuance:IssuanceInstruction'),
    'Alice issuance instruction was not found',
  )
  await client.actOnIssuance({
    synchronizer: 'global-sync',
    actor: alice,
    contractId: issuance.contractId,
    action: 'accept',
  })

  console.log('[e2e] 2/9 Alice starts a transfer, then withdraws it')
  await transfer(alice, bob)
  await client.actOnTransferInstruction({
    synchronizer: 'global-sync',
    actor: alice,
    contractId: (await instruction(alice)).contractId,
    action: 'withdraw',
  })

  console.log('[e2e] 3/9 Alice starts a transfer and Bob rejects it')
  await transfer(alice, bob)
  await client.actOnTransferInstruction({
    synchronizer: 'global-sync',
    actor: bob,
    contractId: (await instruction(bob)).contractId,
    action: 'reject',
  })

  console.log('[e2e] 4/9 Alice starts a transfer and Bob accepts it')
  await transfer(alice, bob)
  await client.actOnTransferInstruction({
    synchronizer: 'global-sync',
    actor: bob,
    contractId: (await instruction(bob)).contractId,
    action: 'accept',
  })
  let bobHolding = await holding('global-sync', bob)

  console.log('[e2e] 5/9 RegistryAdmin syncs the allowlist and Rules on both synchronizers')
  await client.updateWhitelist({
    synchronizer: 'global-sync',
    actor: admin,
    observers: [alice, bob],
  })
  await client.updateWhitelist({
    synchronizer: 'private-sync',
    actor: admin,
    observers: [alice, bob],
  })

  console.log('[e2e] 6/9 Bob archives and recreates Holding visibility')
  await client.refreshVisibility({
    synchronizer: 'global-sync',
    actor: bob,
    contractId: bobHolding.contractId,
  })
  bobHolding = await holding('global-sync', bob)
  if (!bobHolding.observers.includes(alice)) {
    throw new Error('Alice did not become a Holding observer after refresh')
  }

  console.log('[e2e] 7/9 Bob reassigns the Holding to private-sync')
  await client.reassign({
    synchronizer: 'global-sync',
    actor: bob,
    contractId: bobHolding.contractId,
  })

  console.log('[e2e] 8/9 Bob refreshes visibility again using the private-sync policy')
  let privateHolding = await holding('private-sync', bob)
  await client.refreshVisibility({
    synchronizer: 'private-sync',
    actor: bob,
    contractId: privateHolding.contractId,
  })

  console.log('[e2e] 9/9 Verify the private-sync owner, observers, and counter')
  privateHolding = await holding('private-sync', bob)
  if (!privateHolding.observers.includes(alice)) {
    throw new Error('Holding observers were lost after reassignment')
  }
  console.log(
    JSON.stringify(
      {
        contractId: privateHolding.contractId,
        owner: privateHolding.holding?.owner,
        observers: privateHolding.observers,
        reassignmentCounter: privateHolding.reassignmentCounter,
      },
      null,
      2,
    ),
  )
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
