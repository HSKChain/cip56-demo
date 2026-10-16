import { useCallback, useEffect, useState } from 'react'
import './App.css'

interface ActiveState {
  status: 'active'
  contractId: string
  synchronizer: 'global-sync' | 'private-sync'
  synchronizerId: string
  reassignmentCounter: number
  holding: {
    owner: string
    admin: string
    instrumentId: string
    amount: string
    locked?: boolean
  }
  holdings?: HoldingEntry[]
}

type DemoState =
  | ActiveState
  | { status: 'not-issued'; holdings?: HoldingEntry[] }
  | {
      status: 'reassigning'
      contractId: string
      reassignmentId: string
      holdings?: HoldingEntry[]
    }
type Action = 'refresh' | 'issue'
type InstructionAction = 'accept' | 'reject' | 'withdraw'
type SyncAlias = 'global-sync' | 'private-sync'

interface HoldingEntry {
  contractId: string
  owner: string
  admin: string
  instrumentId: string
  amount: string
  locked?: boolean
  synchronizer: SyncAlias
  reassignmentCounter: number
}

interface PartyRef {
  id: string
  hint: string
}

interface PartyCatalog {
  synchronizers: Record<
    SyncAlias,
    {
      id: string
      parties: PartyRef[]
    }
  >
}

interface AcsContract {
  contractId: string
  templateId: string
  status: 'active' | 'reassigning'
  reassignmentCounter: number
  signatories: string[]
  observers: string[]
  createArgument: unknown
  holding?: {
    owner: string
    admin: string
    instrumentId: string
    amount: string
    locked?: boolean
  }
  transferInstruction?: {
    sender: string
    receiver: string
    amount: string
    instrumentId: {
      admin: string
      id: string
    }
  }
  issuance?: {
    admin: string
    owner: string
    amount: string
    instrumentId: {
      admin: string
      id: string
    }
  }
}

interface AcsSnapshot {
  synchronizer: SyncAlias
  party: PartyRef
  offset: number
  contracts: AcsContract[]
}

interface LogEntry {
  at: string
  message: string
  detail?: string
  kind: 'success' | 'error' | 'info'
}

function shortId(value?: string) {
  return value ? value.split('::')[0] : '—'
}

function shortContractId(value: string) {
  return `${value.slice(0, 14)}…${value.slice(-6)}`
}

function isValidIssueAmount(value: string) {
  return /^(?:0|[1-9]\d{0,27})(?:\.\d{1,10})?$/.test(value) &&
    /[1-9]/.test(value)
}

function templateName(templateId: string) {
  return templateId.split(':').at(-1) || templateId
}

function preferredParty(parties: PartyRef[], current: string) {
  if (parties.some((party) => party.id === current)) return current
  return parties.find((party) => party.hint === 'Alice')?.id ?? parties[0]?.id ?? ''
}

function policyObservers(contract: AcsContract) {
  if (!contract.createArgument || typeof contract.createArgument !== 'object') return []
  const observers = (contract.createArgument as { observers?: unknown }).observers
  return Array.isArray(observers)
    ? observers.filter((party): party is string => typeof party === 'string')
    : []
}

async function api<T>(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
) {
  const response = await fetch(path, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  })
  const payload = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}）`)
  return payload
}

export default function App() {
  const [state, setState] = useState<DemoState | null>(null)
  const [lastActive, setLastActive] = useState<ActiveState | null>(null)
  const [connectionError, setConnectionError] = useState(false)
  const [busy, setBusy] = useState<Action | null>('refresh')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [catalog, setCatalog] = useState<PartyCatalog | null>(null)
  const [viewSync, setViewSync] = useState<SyncAlias>('global-sync')
  const [viewParty, setViewParty] = useState('')
  const [acs, setAcs] = useState<AcsSnapshot | null>(null)
  const [acsBusy, setAcsBusy] = useState(false)
  const [acsError, setAcsError] = useState<string | null>(null)
  const [contractBusy, setContractBusy] = useState<string | null>(null)
  const [receivers, setReceivers] = useState<Record<string, string>>({})
  const [whitelists, setWhitelists] = useState<Record<string, string[]>>({})
  const [issueAmount, setIssueAmount] = useState('100')
  const [selectedIssueReceiver, setSelectedIssueReceiver] = useState('')

  const addLog = useCallback((entry: Omit<LogEntry, 'at'>) => {
    const at = new Date().toLocaleTimeString('en-US', { hour12: false })
    setLogs((current) => [{ ...entry, at }, ...current].slice(0, 6))
  }, [])

  const loadCatalog = useCallback(async () => {
    const next = await api<PartyCatalog>('/api/party-catalog')
    setCatalog(next)
  }, [])

  const loadAcs = useCallback(async (synchronizer: SyncAlias, party: string) => {
    if (!party) return
    setAcsBusy(true)
    try {
      const snapshot = await api<AcsSnapshot>(
        `/api/acs?sync=${synchronizer}&party=${encodeURIComponent(party)}`,
      )
      setAcs(snapshot)
      setAcsError(null)
    } catch (error) {
      setAcs(null)
      setAcsError(error instanceof Error ? error.message : String(error))
    } finally {
      setAcsBusy(false)
    }
  }, [])

  const refresh = useCallback(async (quiet = false) => {
    setBusy('refresh')
    try {
      const next = await api<DemoState>('/api/state')
      setState(next)
      if (next.status === 'active') setLastActive(next)
      setConnectionError(false)
      if (!quiet) addLog({ kind: 'info', message: 'Ledger state refreshed' })
    } catch (error) {
      setConnectionError(true)
      addLog({
        kind: 'error',
        message: 'Unable to read ledger state',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      await loadCatalog()
    } catch (error) {
      setCatalog(null)
      if (!quiet) {
        addLog({
          kind: 'error',
          message: 'Unable to read the party catalog',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      setBusy(null)
    }
  }, [addLog, loadCatalog])

  // participant-* parties belong to the node and are excluded from business ACS queries.
  const viewParties = (catalog?.synchronizers[viewSync]?.parties ?? []).filter(
    (party) => !party.hint.startsWith('participant-'),
  )
  const resolvedParty = preferredParty(viewParties, viewParty)

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the first mount must sync external ledger state
    void refresh(true)
  }, [refresh])

  useEffect(() => {
    if (!resolvedParty) return
    // oxlint-disable-next-line react/set-state-in-effect -- sync the matching ACS when the party or synchronizer changes
    void loadAcs(viewSync, resolvedParty)
  }, [loadAcs, resolvedParty, viewSync])

  const runIssue = async () => {
    setBusy('issue')
    try {
      const result = await api<{ updateId: string }>('/api/issue', 'POST', {
        actor: resolvedParty,
        receiver: resolvedIssueReceiver,
        amount: issueAmount,
      })
      addLog({
        kind: 'success',
        message: `Issuance instruction created. Waiting for ${shortId(resolvedIssueReceiver)} to accept`,
        detail: `update ${result.updateId}`,
      })
      setState(null)
    } catch (error) {
      addLog({
        kind: 'error',
        message: 'Issuance failed',
        detail: error instanceof Error ? error.message : String(error),
      })
      setState(null)
    }
    try {
      const next = await api<DemoState>('/api/state')
      setState(next)
      if (next.status === 'active') setLastActive(next)
      setConnectionError(false)
      if (resolvedParty) await loadAcs(viewSync, resolvedParty)
    } catch (error) {
      setConnectionError(true)
      addLog({
        kind: 'error',
        message: 'State refresh failed. Click refresh, then continue.',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    setBusy(null)
  }

  const runContractAction = async (
    key: string,
    path: string,
    body: unknown,
    successMessage: string,
  ) => {
    setContractBusy(key)
    try {
      const result = await api<{ updateId?: string; policyUpdateId?: string }>(
        path,
        'POST',
        body,
      )
      addLog({
        kind: 'success',
        message: successMessage,
        detail: result.updateId ?? result.policyUpdateId,
      })
      await loadAcs(viewSync, resolvedParty)
      const next = await api<DemoState>('/api/state')
      setState(next)
      if (next.status === 'active') setLastActive(next)
    } catch (error) {
      addLog({
        kind: 'error',
        message: `Failed: ${successMessage}`,
        detail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setContractBusy(null)
    }
  }

  const active = state?.status === 'active' ? state : null
  const moving = state?.status === 'reassigning'
  const displayHolding = active ?? (moving ? lastActive : null)
  // The header always shows the RegistryAdmin-visible overview and does not follow the party view below.
  const overviewHoldings =
    state?.holdings && state.holdings.length > 0
      ? state.holdings
      : displayHolding
        ? [
            {
              contractId: displayHolding.contractId,
              synchronizer: displayHolding.synchronizer,
              reassignmentCounter: displayHolding.reassignmentCounter,
              ...displayHolding.holding,
            },
          ]
        : []
  const totalAmount = overviewHoldings.reduce(
    (total, holding) => total + Number(holding.amount),
    0,
  )
  const selectedParty = viewParties.find((party) => party.id === resolvedParty)
  const canIssue = selectedParty?.hint === 'RegistryAdmin'
  const issueParties =
    catalog?.synchronizers['global-sync'].parties.filter(
      (party) => !party.hint.startsWith('participant-'),
    ) ?? []
  const resolvedIssueReceiver =
    issueParties.some((party) => party.id === selectedIssueReceiver)
      ? selectedIssueReceiver
      : issueParties.find((party) => party.hint === 'Alice')?.id ??
        issueParties[0]?.id ??
        ''
  const canSubmitIssue =
    canIssue && Boolean(resolvedIssueReceiver) && isValidIssueAmount(issueAmount)

  const changeSync = (next: SyncAlias) => {
    setViewSync(next)
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">C</div>
          <div><strong>CIP-56 Localnet</strong><span>Token Standard Demo</span></div>
        </div>
        <div className="network-pill"><span className="pulse" />participant-shared</div>
      </header>

      <section className="hero-copy">
        <div>
          <p className="eyebrow">CANTON TOKEN STANDARD</p>
          <h1>One asset, two synchronizers</h1>
          <p className="intro">
            Issue a CIP-56 Holding on global-sync, then reassign it to private-sync. There is no wrapped asset, and the contract ID stays the same.
          </p>
        </div>
        <div className="standard-badge"><span>CIP</span><strong>56</strong><small>Holding V1</small></div>
      </section>

      <section className="asset-card">
        <div className="asset-main">
          <div className="coin">H</div>
          <div><span className="muted">INSTRUMENT</span><h2>{displayHolding?.holding.instrumentId ?? 'HSKD'}</h2><p>SimpleHolding · HoldingV1</p></div>
        </div>
        <div className="amount">
          <strong data-testid="total-amount">{state === null ? '—' : totalAmount.toLocaleString('en-US')} HSKD</strong>
          <span>{overviewHoldings.length} HOLDINGS</span>
          <span>{moving ? 'REASSIGNING' : connectionError ? 'UNAVAILABLE' : active ? 'ACTIVE HOLDING' : state === null ? 'LOADING' : 'NOT ISSUED'}</span>
        </div>
        <div className="asset-fields">
          <div><span>Registry Admin</span><strong>{shortId(displayHolding?.holding.admin)}</strong></div>
          <div><span>Primary Holding synchronizer</span><strong data-testid="holding-location">{displayHolding?.synchronizer ?? '—'}</strong></div>
        </div>
        <div className="holding-overview" data-testid="holding-overview">
          <div className="holding-overview-head">
            <span>Contract ID</span><span>Owner</span><span>Amount</span>
            <span>Synchronizer</span><span>Reassignment</span><span>Status</span>
          </div>
          {overviewHoldings.length === 0 ? (
            <p className="holding-empty">No active Holdings</p>
          ) : (
            overviewHoldings.map((holding) => (
              <div
                className="holding-overview-item"
                data-testid={`holding-summary-${holding.contractId}`}
                key={holding.contractId}
              >
                <div className="holding-overview-row">
                  <strong className="mono" title={holding.contractId}>
                    {shortContractId(holding.contractId)}
                  </strong>
                  <span>{shortId(holding.owner)}</span>
                  <span>{holding.amount}</span>
                  <span>{holding.synchronizer}</span>
                  <span>#{holding.reassignmentCounter}</span>
                  <span className={holding.locked ? 'holding-locked' : 'holding-active'}>
                    {holding.locked ? 'Locked' : 'Available'}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <div className="section-title">
        <div><span className="eyebrow">DOMAIN ROUTING</span><h2>Synchronizer status</h2></div>
        <span className={`status-chip ${moving ? 'moving' : ''}`}>
          {connectionError ? 'Connection failed' : moving ? 'Reassigning' : active ? 'Contracts active' : state === null ? 'Loading' : 'Waiting to issue'}
        </span>
      </div>

      <section className="sync-grid">
        {(['global-sync', 'private-sync'] as const).map((sync) => {
          // Each card reflects the Holdings that synchronizer actually hosts, not one primary Holding.
          const syncHoldings = overviewHoldings.filter(
            (holding) => holding.synchronizer === sync,
          )
          const syncAmount = syncHoldings.reduce(
            (total, holding) => total + Number(holding.amount),
            0,
          )
          const isActive = syncHoldings.length > 0
          return (
            <article className={`sync-card ${isActive ? 'active' : ''}`} data-testid={sync} data-active={String(isActive)} key={sync}>
              <div className="sync-head">
                <div className={`sync-icon ${sync === 'private-sync' ? 'private' : ''}`}>{sync === 'global-sync' ? '◎' : '◇'}</div>
                <div><h3>{sync}</h3><p>{sync === 'global-sync' ? 'Global Synchronizer' : 'Private Synchronizer'}</p></div>
                <span className={`state-dot ${isActive ? 'on' : ''}`} />
              </div>
              <div className="sync-state">
                <span>{isActive ? 'ACTIVE' : 'INACTIVE'}</span>
                <strong data-testid="sync-amount">
                  {syncAmount.toLocaleString('en-US')} HSKD
                </strong>
                <em data-testid="sync-count">
                  {syncHoldings.length} {syncHoldings.length === 1 ? 'HOLDING' : 'HOLDINGS'}
                </em>
              </div>
              <div className="sync-id">{sync === 'global-sync' ? 'Public settlement domain' : 'Private institutional domain'}</div>
            </article>
          )
        })}
        {/* A Holding can be reassigned in either direction, so this line is not highlighted one way. */}
        <div className="route-line" data-testid="route-line"><span>REASSIGNMENT</span><i>⇄</i></div>
      </section>

      <div className="section-title">
        <div><span className="eyebrow">PARTY VIEW</span><h2>Active Contract Set</h2></div>
        <span className="status-chip">{acsBusy ? 'Loading' : acsError ? 'Read failed' : `${acs?.contracts.length ?? 0} CONTRACTS`}</span>
      </div>
      <section className="acs-panel">
        <div className="acs-filters">
          <label htmlFor="sync-select">
            Synchronizer
            <select
              id="sync-select"
              value={viewSync}
              onChange={(event) => changeSync(event.target.value as SyncAlias)}
            >
              <option value="global-sync">global-sync</option>
              <option value="private-sync">private-sync</option>
            </select>
          </label>
          <label htmlFor="party-select">
            Party
            <select
              id="party-select"
              value={resolvedParty}
              disabled={viewParties.length === 0}
              onChange={(event) => setViewParty(event.target.value)}
            >
              <option value="" disabled>
                Select a party
              </option>
              {viewParties.map((party) => (
                <option key={party.id} value={party.id}>
                  {party.hint}
                </option>
              ))}
            </select>
          </label>
          <p>
            Acting as: {shortId(resolvedParty)}. Buttons follow this party's permissions. Each action is authorized only by the current party. Issuance must be accepted by the receiver.
          </p>
        </div>
        {acsError ? (
          <p className="empty-log">{acsError}</p>
        ) : !acs || acs.contracts.length === 0 ? (
          <p className="empty-log">
            {acsBusy ? 'Reading the ACS…' : 'No active contracts in this view'}
          </p>
        ) : (
          <div className="acs-list">
            {acs.contracts.map((contract) => {
              const holdingLocked = Boolean(contract.holding?.locked)
              const isHoldingOwner =
                contract.status === 'active' &&
                contract.holding?.owner === resolvedParty &&
                !holdingLocked
              const transfer = contract.transferInstruction
              const issuance = contract.issuance
              const isReceiver = transfer?.receiver === resolvedParty
              const isSender = transfer?.sender === resolvedParty
              const isPolicy = contract.templateId.endsWith(
                ':SimpleToken.Visibility:VisibilityPolicy',
              )
              const canManagePolicy =
                isPolicy && contract.signatories.includes(resolvedParty)
              const businessParties = viewParties.filter(
                (party) =>
                  !party.hint.startsWith('participant-') &&
                  party.id !== resolvedParty,
              )
              const receiver =
                receivers[contract.contractId] ?? businessParties[0]?.id ?? ''
              const targetSynchronizer =
                viewSync === 'global-sync' ? 'private-sync' : 'global-sync'
              const initialWhitelist = policyObservers(contract)
              const selectedWhitelist =
                whitelists[contract.contractId] ?? initialWhitelist
              const actionDisabled = contractBusy !== null

              return (
                <article
                  className="acs-card"
                  data-testid={`contract-${contract.contractId}`}
                  key={contract.contractId}
                >
                  <div className="acs-card-head">
                    <strong>{templateName(contract.templateId)}</strong>
                    <span>{contract.status === 'active' ? 'ACTIVE' : 'REASSIGNING'}</span>
                  </div>
                  <p className="mono">{contract.contractId}</p>
                  {contract.holding ? (
                    <>
                      <p>{contract.holding.amount} {contract.holding.instrumentId}</p>
                      <div className="contract-actions">
                        <label>
                          Receiver
                          <select
                            aria-label="Receiver"
                            value={receiver}
                            disabled={!isHoldingOwner || actionDisabled}
                            onChange={(event) =>
                              setReceivers((current) => ({
                                ...current,
                                [contract.contractId]: event.target.value,
                              }))
                            }
                          >
                            {businessParties.map((party) => (
                              <option key={party.id} value={party.id}>
                                {party.hint}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="primary compact"
                          disabled={!isHoldingOwner || !receiver || actionDisabled}
                          title={
                            isHoldingOwner
                              ? 'Authorized only by the current Holding owner'
                              : holdingLocked
                                ? 'Cannot start another transfer until the current one completes'
                                : 'Only the Holding owner can start a transfer'
                          }
                          onClick={() =>
                            void runContractAction(
                              `${contract.contractId}:transfer`,
                              '/api/transfer',
                              {
                                synchronizer: viewSync,
                                actor: resolvedParty,
                                contractId: contract.contractId,
                                receiver,
                              },
                              'Transfer started',
                            )
                          }
                        >
                          {contractBusy === `${contract.contractId}:transfer`
                            ? 'Submitting…'
                            : 'Start transfer'}
                        </button>
                        <button
                          className="secondary compact"
                          disabled={!isHoldingOwner || actionDisabled}
                          title={
                            isHoldingOwner
                              ? 'Archive and recreate the Holding using the latest allowlist'
                              : holdingLocked
                                ? 'Cannot refresh visibility until the transfer completes'
                                : 'Only the Holding owner can refresh visibility'
                          }
                          onClick={() =>
                            void runContractAction(
                              `${contract.contractId}:visibility`,
                              '/api/refresh-visibility',
                              {
                                synchronizer: viewSync,
                                actor: resolvedParty,
                                contractId: contract.contractId,
                              },
                              'Holding visibility refreshed',
                            )
                          }
                        >
                          {contractBusy === `${contract.contractId}:visibility`
                            ? 'Refreshing…'
                            : 'Refresh visibility'}
                        </button>
                        <button
                          className="secondary compact"
                          disabled={!isHoldingOwner || actionDisabled}
                          title={
                            isHoldingOwner
                              ? 'A pure reassignment keeps the contract ID unchanged'
                              : holdingLocked
                                ? 'A locked Holding cannot be reassigned until the transfer completes'
                                : contract.status !== 'active'
                                  ? 'The Holding is being reassigned'
                                  : 'Only the Holding owner can reassign'
                          }
                          onClick={() =>
                            void runContractAction(
                              `${contract.contractId}:reassign`,
                              '/api/reassign',
                              {
                                synchronizer: viewSync,
                                actor: resolvedParty,
                                contractId: contract.contractId,
                              },
                              `Holding reassigned to ${targetSynchronizer}. The contract ID is unchanged`,
                            )
                          }
                        >
                          {contractBusy === `${contract.contractId}:reassign`
                            ? 'Reassigning…'
                            : `Reassign to ${targetSynchronizer}`}
                        </button>
                      </div>
                    </>
                  ) : null}
                  {transfer ? (
                    <>
                      <p>
                        {transfer.amount} {transfer.instrumentId.id} ·{' '}
                        {shortId(transfer.sender)} → {shortId(transfer.receiver)}
                      </p>
                      <div className="instruction-actions">
                        {(
                          [
                            ['accept', 'Accept', 'Transfer accepted'],
                            ['reject', 'Reject', 'Transfer rejected'],
                            ['withdraw', 'Withdraw', 'Transfer withdrawn'],
                          ] as const
                        ).map(([action, label, successMessage]) => {
                          const allowed =
                            action === 'withdraw' ? isSender : isReceiver
                          const reason =
                            action === 'withdraw'
                              ? 'Only the sender can withdraw a transfer'
                              : 'Only the receiver can accept or reject a transfer'
                          return (
                            <button
                              className={action === 'accept' ? 'primary compact' : 'secondary compact'}
                              disabled={!allowed || actionDisabled}
                              key={action}
                              title={allowed ? 'Authorized only by the current party' : reason}
                              onClick={() =>
                                void runContractAction(
                                  `${contract.contractId}:${action}`,
                                  '/api/transfer-instruction',
                                  {
                                    synchronizer: viewSync,
                                    actor: resolvedParty,
                                    contractId: contract.contractId,
                                    action: action as InstructionAction,
                                  },
                                  successMessage,
                                )
                              }
                            >
                              {contractBusy === `${contract.contractId}:${action}`
                                ? 'Submitting…'
                                : label}
                            </button>
                          )
                        })}
                      </div>
                    </>
                  ) : null}
                  {issuance ? (
                    <>
                      <p>
                        {issuance.amount} {issuance.instrumentId.id} · to{' '}
                        {shortId(issuance.owner)}
                      </p>
                      <div className="instruction-actions">
                        <button
                          className="primary compact"
                          disabled={issuance.owner !== resolvedParty || actionDisabled}
                          title={
                            issuance.owner === resolvedParty
                              ? 'Authorized only by the receiver. Accepting creates the Holding.'
                              : 'Only the receiver can accept issuance'
                          }
                          onClick={() =>
                            void runContractAction(
                              `${contract.contractId}:accept-issuance`,
                              '/api/issuance',
                              {
                                synchronizer: viewSync,
                                actor: resolvedParty,
                                contractId: contract.contractId,
                                action: 'accept',
                              },
                              'Issuance accepted',
                            )
                          }
                        >
                          {contractBusy === `${contract.contractId}:accept-issuance`
                            ? 'Submitting…'
                            : 'Accept issuance'}
                        </button>
                        <button
                          className="secondary compact"
                          disabled={issuance.admin !== resolvedParty || actionDisabled}
                          title={
                            issuance.admin === resolvedParty
                              ? 'Authorized only by RegistryAdmin'
                              : 'Only RegistryAdmin can withdraw issuance'
                          }
                          onClick={() =>
                            void runContractAction(
                              `${contract.contractId}:withdraw-issuance`,
                              '/api/issuance',
                              {
                                synchronizer: viewSync,
                                actor: resolvedParty,
                                contractId: contract.contractId,
                                action: 'withdraw',
                              },
                              'Issuance withdrawn',
                            )
                          }
                        >
                          {contractBusy === `${contract.contractId}:withdraw-issuance`
                            ? 'Submitting…'
                            : 'Withdraw issuance'}
                        </button>
                      </div>
                    </>
                  ) : null}
                  {isPolicy ? (
                    <div className="policy-editor">
                      <p>
                        Holding observer allowlist for the current synchronizer
                        （archive + recreate Policy/Rules）
                      </p>
                      <div className="party-checks">
                        {viewParties
                          .filter((party) => !party.hint.startsWith('participant-'))
                          .map((party) => (
                            <label key={party.id}>
                              <input
                                type="checkbox"
                                aria-label={party.hint}
                                checked={selectedWhitelist.includes(party.id)}
                                disabled={!canManagePolicy || actionDisabled}
                                onChange={(event) => {
                                  const next = event.target.checked
                                    ? [...selectedWhitelist, party.id]
                                    : selectedWhitelist.filter((id) => id !== party.id)
                                  setWhitelists((current) => ({
                                    ...current,
                                    [contract.contractId]: next,
                                  }))
                                }}
                              />
                              {party.hint}
                            </label>
                          ))}
                      </div>
                      <button
                        className="primary compact"
                        disabled={!canManagePolicy || actionDisabled}
                        title={
                          canManagePolicy
                            ? 'Updates Policy and Rules. Existing Holdings must be refreshed by their owners.'
                            : 'Only a VisibilityPolicy signatory can update the allowlist'
                        }
                        onClick={() =>
                          void runContractAction(
                            `${contract.contractId}:whitelist`,
                            '/api/whitelist',
                            {
                              synchronizer: viewSync,
                              actor: resolvedParty,
                              observers: viewParties
                                .map((party) => party.id)
                                .filter((party) => selectedWhitelist.includes(party)),
                            },
                            'Allowlist updated',
                          )
                        }
                      >
                        {contractBusy === `${contract.contractId}:whitelist`
                          ? 'Updating…'
                          : 'Update allowlist'}
                      </button>
                    </div>
                  ) : null}
                  <p>signatories: {contract.signatories.map(shortId).join(', ') || '—'}</p>
                  <p>observers: {contract.observers.map(shortId).join(', ') || '—'}</p>
                  <pre>{JSON.stringify(contract.createArgument, null, 2)}</pre>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section className="control-panel">
        <div className="actions">
          <div className="issue-form">
            <label>
              Issuance amount
              <input
                aria-label="Issuance amount"
                inputMode="decimal"
                maxLength={39}
                value={issueAmount}
                onChange={(event) => setIssueAmount(event.target.value)}
              />
            </label>
            <label>
              Issuance receiver
              <select
                aria-label="Issuance receiver"
                value={resolvedIssueReceiver}
                onChange={(event) => setSelectedIssueReceiver(event.target.value)}
              >
                {issueParties.map((party) => (
                  <option key={party.id} value={party.id}>
                    {party.hint}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            className="secondary"
            disabled={busy !== null || !canSubmitIssue}
            title={
              !canIssue
                ? 'Only RegistryAdmin can issue a Holding'
                : !isValidIssueAmount(issueAmount)
                  ? 'Enter a decimal greater than 0 with at most 10 decimal places'
                  : 'Issue as RegistryAdmin'
            }
            onClick={() => void runIssue()}
          >
            {busy === 'issue' ? 'Issuing…' : 'Issue Holding'}
          </button>
          <button className="icon-button" aria-label="Refresh state" disabled={busy !== null} onClick={() => void refresh()}>↻</button>
        </div>
        <div className="activity">
          <div className="activity-head"><span>Activity</span><small>LIVE</small></div>
          {logs.length === 0 ? <p className="empty-log">Results appear here</p> : logs.map((log, index) => (
            <div className={`log ${log.kind}`} key={`${log.at}-${index}`}>
              <time>{log.at}</time><div><strong>{log.message}</strong>{log.detail && <code>{log.detail}</code>}</div>
            </div>
          ))}
        </div>
      </section>

      <footer><span>Ledger API · 127.0.0.1:5033</span><span>global-sync ⇄ private-sync</span></footer>
    </main>
  )
}
