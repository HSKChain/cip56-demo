// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

const privateState = {
  status: 'active',
  contractId: '006f098f3ca67eaaa8d7',
  synchronizer: 'private-sync',
  synchronizerId: 'private-sync::id',
  reassignmentCounter: 3,
  holding: {
    owner: 'Alice::namespace',
    admin: 'RegistryAdmin::namespace',
    instrumentId: 'HSKD',
    amount: '100.0000000000',
  },
}

const multiHoldingState = {
  ...privateState,
  holdings: [
    {
      contractId: privateState.contractId,
      ...privateState.holding,
      locked: false,
      synchronizer: 'private-sync',
      reassignmentCounter: 3,
    },
    {
      contractId: '00abcdef1234567890fedcba',
      owner: 'Bob::namespace',
      admin: 'RegistryAdmin::namespace',
      instrumentId: 'HSKD',
      amount: '150.0000000000',
      locked: true,
      synchronizer: 'global-sync',
      reassignmentCounter: 0,
    },
  ],
}

const catalog = {
  synchronizers: {
    'global-sync': {
      id: 'global-sync::id',
      parties: [
        { id: 'RegistryAdmin::namespace', hint: 'RegistryAdmin' },
        { id: 'Alice::namespace', hint: 'Alice' },
        { id: 'Bob::namespace', hint: 'Bob' },
      ],
    },
    'private-sync': {
      id: 'private-sync::id',
      parties: [
        { id: 'RegistryAdmin::namespace', hint: 'RegistryAdmin' },
        { id: 'Alice::namespace', hint: 'Alice' },
        { id: 'Bob::namespace', hint: 'Bob' },
      ],
    },
  },
}

const aliceGlobalAcs = {
  synchronizer: 'global-sync',
  synchronizerId: 'global-sync::id',
  party: { id: 'Alice::namespace', hint: 'Alice' },
  offset: 42,
  contracts: [
    {
      contractId: '006f-holding',
      templateId: '#simple-token:SimpleToken.Holding:SimpleHolding',
      status: 'active',
      reassignmentCounter: 2,
      signatories: ['RegistryAdmin::namespace', 'Alice::namespace'],
      observers: [],
      createArgument: { amount: '100.0000000000' },
      holding: {
        owner: 'Alice::namespace',
        admin: 'RegistryAdmin::namespace',
        instrumentId: 'HSKD',
        amount: '100.0000000000',
      },
    },
    {
      contractId: '00-factory',
      templateId: '#simple-token:SimpleToken.Factory:SimpleHoldingFactory',
      status: 'active',
      reassignmentCounter: 0,
      signatories: ['RegistryAdmin::namespace'],
      observers: [],
      createArgument: { admin: 'RegistryAdmin::namespace' },
    },
  ],
}

const bobPrivateAcs = {
  synchronizer: 'private-sync',
  synchronizerId: 'private-sync::id',
  party: { id: 'Bob::namespace', hint: 'Bob' },
  offset: 42,
  contracts: [],
}

const transferInstruction = {
  contractId: '00-transfer-instruction',
  templateId: '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction',
  status: 'active',
  reassignmentCounter: 0,
  signatories: ['RegistryAdmin::namespace', 'Alice::namespace', 'Bob::namespace'],
  observers: [],
  createArgument: {},
  transferInstruction: {
    sender: 'Alice::namespace',
    receiver: 'Bob::namespace',
    amount: '100.0000000000',
    instrumentId: {
      admin: 'RegistryAdmin::namespace',
      id: 'HSKD',
    },
  },
}

const registryAdminGlobalAcs = {
  synchronizer: 'global-sync',
  synchronizerId: 'global-sync::id',
  party: { id: 'RegistryAdmin::namespace', hint: 'RegistryAdmin' },
  offset: 43,
  contracts: [
    {
      contractId: '00-policy',
      templateId: '#simple-token:SimpleToken.Visibility:VisibilityPolicy',
      status: 'active',
      reassignmentCounter: 0,
      signatories: ['RegistryAdmin::namespace'],
      observers: ['Alice::namespace', 'Bob::namespace'],
      createArgument: {
        admin: 'RegistryAdmin::namespace',
        observers: ['Bob::namespace'],
        version: 2,
      },
    },
  ],
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function mockApi(overrides: {
  state?: unknown
  acs?: (sync: string, party: string) => unknown
  mutation?: (path: string) => Response
} = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url === '/api/state' && method === 'GET') {
      return jsonResponse(overrides.state ?? privateState)
    }
    if (url === '/api/party-catalog' && method === 'GET') {
      return jsonResponse(catalog)
    }
    if (url.startsWith('/api/acs') && method === 'GET') {
      const parsed = new URL(url, 'http://127.0.0.1')
      const snapshot = overrides.acs
        ? overrides.acs(
            parsed.searchParams.get('sync') ?? '',
            parsed.searchParams.get('party') ?? '',
          )
        : parsed.searchParams.get('sync') === 'private-sync' &&
            parsed.searchParams.get('party') === 'Bob::namespace'
          ? bobPrivateAcs
          : aliceGlobalAcs
      return jsonResponse(snapshot)
    }
    if (overrides.mutation) return overrides.mutation(url)
    return jsonResponse({ error: `unexpected ${method} ${url}` }, 500)
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CIP-56 dashboard', () => {
  it('renders Holding data and highlights its active synchronizer', async () => {
    mockApi()

    render(<App />)

    expect(await screen.findByTestId('total-amount')).toHaveTextContent('100 HSKD')
    expect(screen.getAllByText('Alice')[0]).toBeInTheDocument()
    expect(screen.getByTestId('private-sync')).toHaveAttribute(
      'data-active',
      'true',
    )
    expect(screen.getByTestId('global-sync')).toHaveAttribute(
      'data-active',
      'false',
    )
  })

  it('summarizes Holding count and amount for each synchronizer', async () => {
    mockApi({ state: multiHoldingState })

    render(<App />)

    const globalCard = await screen.findByTestId('global-sync')
    const privateCard = screen.getByTestId('private-sync')

    expect(globalCard).toHaveAttribute('data-active', 'true')
    expect(privateCard).toHaveAttribute('data-active', 'true')
    expect(within(globalCard).getByTestId('sync-count')).toHaveTextContent(
      '1 HOLDING',
    )
    expect(within(globalCard).getByTestId('sync-amount')).toHaveTextContent(
      '150 HSKD',
    )
    expect(within(privateCard).getByTestId('sync-count')).toHaveTextContent(
      '1 HOLDING',
    )
    expect(within(privateCard).getByTestId('sync-amount')).toHaveTextContent(
      '100 HSKD',
    )
    expect(screen.getByTestId('route-line')).toHaveTextContent('⇄')
  })

  it('marks a synchronizer without Holdings as inactive', async () => {
    mockApi()

    render(<App />)

    const globalCard = await screen.findByTestId('global-sync')
    expect(globalCard).toHaveAttribute('data-active', 'false')
    expect(within(globalCard).getByTestId('sync-count')).toHaveTextContent(
      '0 HOLDINGS',
    )
    expect(within(globalCard).getByTestId('sync-amount')).toHaveTextContent(
      '0 HSKD',
    )
  })

  it('labels which synchronizer holds the asset', async () => {
    mockApi()

    render(<App />)

    await screen.findByTestId('total-amount')
    expect(screen.getByTestId('holding-location')).toHaveTextContent(
      'private-sync',
    )
  })

  it('renders every Holding with total amount, contract ID and owner', async () => {
    mockApi({ state: multiHoldingState })

    render(<App />)

    expect(await screen.findByTestId('total-amount')).toHaveTextContent('250 HSKD')
    expect(screen.getByText('2 HOLDINGS')).toBeInTheDocument()
    const overview = screen.getByTestId('holding-overview')
    expect(within(overview).getByText('006f098f3ca67e…aaa8d7')).toBeInTheDocument()
    expect(within(overview).getByText('00abcdef123456…fedcba')).toBeInTheDocument()
    expect(
      within(screen.getByTestId(`holding-summary-${privateState.contractId}`))
        .getByText('Alice'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('holding-summary-00abcdef1234567890fedcba'))
        .getByText('Bob'),
    ).toBeInTheDocument()
    expect(within(overview).getByText('Locked')).toBeInTheDocument()
    expect(screen.getByTestId('holding-location')).toHaveTextContent(
      'private-sync',
    )
  })

  it('keeps the top Holding list informational only', async () => {
    const fetchMock = mockApi({
      state: multiHoldingState,
      mutation: () => jsonResponse({ updateId: 'holding-action-update' }),
    })

    render(<App />)

    const aliceHolding = await screen.findByTestId(
      `holding-summary-${privateState.contractId}`,
    )
    expect(within(aliceHolding).queryByRole('button')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/reassign',
      expect.anything(),
    )
  })

  it('reassigns the selected ACS Holding contract only for its owner', async () => {
    const fetchMock = mockApi({
      mutation: () => jsonResponse({
        source: 'global-sync',
        target: 'private-sync',
        reassignmentId: 'reassignment-acs',
        updateId: 'reassignment-update',
      }),
    })

    render(<App />)

    const holding = await screen.findByTestId('contract-006f-holding')
    const reassign = within(holding).getByRole('button', {
      name: /Reassign to private-sync/,
    })
    expect(reassign).toBeEnabled()
    fireEvent.click(reassign)
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/reassign',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            synchronizer: 'global-sync',
            actor: 'Alice::namespace',
            contractId: '006f-holding',
          }),
        }),
      ),
    )

    fireEvent.change(screen.getByLabelText('Party'), {
      target: { value: 'RegistryAdmin::namespace' },
    })
    const observerHolding = await screen.findByTestId('contract-006f-holding')
    const observerReassign = within(observerHolding).getByRole('button', {
      name: /Reassign to private-sync/,
    })
    expect(observerReassign).toBeDisabled()
    expect(observerReassign).toHaveAttribute(
      'title',
      'Only the Holding owner can reassign',
    )
  })

  it('shows a connection error instead of an empty holding on initial failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('participant unavailable'),
    )

    render(<App />)

    expect(await screen.findByText('Connection failed')).toBeInTheDocument()
    expect(screen.getByTestId('total-amount')).toHaveTextContent('— HSKD')
    expect(screen.queryByText('NOT ISSUED')).not.toBeInTheDocument()
  })

  it('loads ACS for the default global-sync party view', async () => {
    mockApi()

    render(<App />)

    expect(await screen.findByLabelText('Synchronizer')).toHaveValue(
      'global-sync',
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Party')).toHaveValue('Alice::namespace'),
    )
    expect(await screen.findByText('SimpleHolding')).toBeInTheDocument()
    expect(screen.getByText('SimpleHoldingFactory')).toBeInTheDocument()
    expect(screen.getByText('100.0000000000 HSKD')).toBeInTheDocument()
    expect(screen.getByLabelText('Party')).toHaveValue('Alice::namespace')
  })

  it('switches synchronizer then party and shows that ACS', async () => {
    const fetchMock = mockApi()

    render(<App />)
    await screen.findByText('SimpleHolding')

    fireEvent.change(screen.getByLabelText('Synchronizer'), {
      target: { value: 'private-sync' },
    })
    await waitFor(() =>
      expect(
        within(screen.getByLabelText('Party')).getByRole('option', {
          name: 'Bob',
        }),
      ).toBeInTheDocument(),
    )
    fireEvent.change(screen.getByLabelText('Party'), {
      target: { value: 'Bob::namespace' },
    })

    expect(
      await screen.findByText('No active contracts in this view'),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/acs?sync=private-sync&party=Bob%3A%3Anamespace',
        expect.objectContaining({ method: 'GET' }),
      ),
    )
    expect(
      screen.queryByRole('button', { name: /Reassign to global-sync/ }),
    ).not.toBeInTheDocument()
  })

  it('enables issuance for RegistryAdmin even when a Holding is active', async () => {
    const fetchMock = mockApi({
      mutation: () => jsonResponse({ updateId: 'issue-update' }),
    })

    render(<App />)
    await screen.findByTestId('total-amount')
    const disabledIssue = screen.getByRole('button', { name: 'Issue Holding' })
    expect(disabledIssue).toBeDisabled()
    expect(disabledIssue).toHaveAttribute(
      'title',
      'Only RegistryAdmin can issue a Holding',
    )

    fireEvent.change(screen.getByLabelText('Party'), {
      target: { value: 'RegistryAdmin::namespace' },
    })
    fireEvent.change(screen.getByLabelText('Issuance amount'), {
      target: { value: '25.5' },
    })
    fireEvent.change(screen.getByLabelText('Issuance receiver'), {
      target: { value: 'Bob::namespace' },
    })
    const issue = screen.getByRole('button', { name: 'Issue Holding' })
    expect(issue).toBeEnabled()
    fireEvent.click(issue)

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/issue',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            actor: 'RegistryAdmin::namespace',
            receiver: 'Bob::namespace',
            amount: '25.5',
          }),
        }),
      ),
    )
  })

  it('only enables Holding owner actions for the selected Party', async () => {
    mockApi({
      acs: (_sync, party) => ({
        ...aliceGlobalAcs,
        party: { id: party, hint: party.startsWith('Alice') ? 'Alice' : 'RegistryAdmin' },
      }),
    })

    render(<App />)
    const holding = await screen.findByTestId('contract-006f-holding')

    expect(within(holding).getByRole('button', { name: 'Start transfer' })).toBeEnabled()
    expect(within(holding).getByRole('button', { name: 'Refresh visibility' })).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Party'), {
      target: { value: 'RegistryAdmin::namespace' },
    })

    const adminHolding = await screen.findByTestId('contract-006f-holding')
    expect(within(adminHolding).getByRole('button', { name: 'Start transfer' })).toBeDisabled()
    expect(within(adminHolding).getByRole('button', { name: 'Start transfer' })).toHaveAttribute(
      'title',
      'Only the Holding owner can start a transfer',
    )
    expect(within(adminHolding).getByRole('button', { name: 'Refresh visibility' })).toBeDisabled()
  })

  it('disables Holding actions and reassignment while a Transfer is pending', async () => {
    mockApi({
      state: {
        ...privateState,
        holding: { ...privateState.holding, locked: true },
      },
      acs: () => ({
        ...aliceGlobalAcs,
        contracts: [
          {
            ...aliceGlobalAcs.contracts[0],
            holding: {
              ...aliceGlobalAcs.contracts[0].holding,
              locked: true,
            },
          },
        ],
      }),
    })

    render(<App />)
    const holding = await screen.findByTestId('contract-006f-holding')
    expect(within(holding).getByRole('button', { name: 'Start transfer' })).toBeDisabled()
    expect(within(holding).getByRole('button', { name: 'Refresh visibility' })).toBeDisabled()
    expect(
      within(holding).getByRole('button', { name: /Reassign to private-sync/ }),
    ).toBeDisabled()
  })

  it('enables accept and reject for receiver but withdraw for sender', async () => {
    mockApi({
      acs: (_sync, party) => ({
        ...aliceGlobalAcs,
        party: {
          id: party,
          hint: party.startsWith('Bob') ? 'Bob' : 'Alice',
        },
        contracts: [transferInstruction],
      }),
    })

    render(<App />)
    const aliceInstruction = await screen.findByTestId(
      'contract-00-transfer-instruction',
    )
    expect(within(aliceInstruction).getByRole('button', { name: 'Withdraw' })).toBeEnabled()
    expect(within(aliceInstruction).getByRole('button', { name: 'Accept' })).toBeDisabled()
    expect(within(aliceInstruction).getByRole('button', { name: 'Reject' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Party'), {
      target: { value: 'Bob::namespace' },
    })
    const bobInstruction = await screen.findByTestId(
      'contract-00-transfer-instruction',
    )
    expect(within(bobInstruction).getByRole('button', { name: 'Accept' })).toBeEnabled()
    expect(within(bobInstruction).getByRole('button', { name: 'Reject' })).toBeEnabled()
    expect(within(bobInstruction).getByRole('button', { name: 'Withdraw' })).toBeDisabled()
  })

  it('submits Party-scoped Holding and TransferInstruction actions then refreshes ACS', async () => {
    const fetchMock = mockApi({
      acs: () => ({
        ...aliceGlobalAcs,
        contracts: [aliceGlobalAcs.contracts[0], transferInstruction],
      }),
      mutation: () => jsonResponse({ updateId: 'update-1' }),
    })

    render(<App />)
    const holding = await screen.findByTestId('contract-006f-holding')
    fireEvent.change(within(holding).getByLabelText('Receiver'), {
      target: { value: 'Bob::namespace' },
    })
    fireEvent.click(within(holding).getByRole('button', { name: 'Start transfer' }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/transfer',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            synchronizer: 'global-sync',
            actor: 'Alice::namespace',
            contractId: '006f-holding',
            receiver: 'Bob::namespace',
          }),
        }),
      ),
    )

    const instruction = await screen.findByTestId('contract-00-transfer-instruction')
    fireEvent.click(within(instruction).getByRole('button', { name: 'Withdraw' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/transfer-instruction',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            synchronizer: 'global-sync',
            actor: 'Alice::namespace',
            contractId: '00-transfer-instruction',
            action: 'withdraw',
          }),
        }),
      ),
    )
  })

  it('only enables whitelist management for the policy signatory', async () => {
    const fetchMock = mockApi({
      acs: (_sync, party) =>
        party === 'RegistryAdmin::namespace'
          ? registryAdminGlobalAcs
          : {
              ...registryAdminGlobalAcs,
              party: { id: party, hint: 'Alice' },
            },
      mutation: () => jsonResponse({ policyUpdateId: 'policy-update' }),
    })

    render(<App />)
    fireEvent.change(await screen.findByLabelText('Party'), {
      target: { value: 'RegistryAdmin::namespace' },
    })
    const policy = await screen.findByTestId('contract-00-policy')
    expect(within(policy).getByRole('button', { name: 'Update allowlist' })).toBeEnabled()
    fireEvent.click(within(policy).getByLabelText('Alice'))
    fireEvent.click(within(policy).getByRole('button', { name: 'Update allowlist' }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/whitelist',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            synchronizer: 'global-sync',
            actor: 'RegistryAdmin::namespace',
            observers: ['Alice::namespace', 'Bob::namespace'],
          }),
        }),
      ),
    )

    fireEvent.change(screen.getByLabelText('Party'), {
      target: { value: 'Alice::namespace' },
    })
    const alicePolicy = await screen.findByTestId('contract-00-policy')
    expect(within(alicePolicy).getByRole('button', { name: 'Update allowlist' })).toBeDisabled()
  })
})
