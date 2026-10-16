import express, { type Request, type Response } from 'express'
import { z } from 'zod'
import { isValidIssueAmount } from './canton.js'
import type {
  AcsQuery,
  AcsSnapshot,
  DemoState,
  IssueRequest,
  IssuanceRequest,
  PartyCatalog,
  RefreshVisibilityRequest,
  ReassignRequest,
  TransferInstructionRequest,
  TransferRequest,
  WhitelistRequest,
} from './canton.js'

export interface DemoService {
  getState(): Promise<DemoState>
  getPartyCatalog(): Promise<PartyCatalog>
  getAcs(query: AcsQuery): Promise<AcsSnapshot>
  transfer(input: TransferRequest): Promise<unknown>
  actOnTransferInstruction(input: TransferInstructionRequest): Promise<unknown>
  updateWhitelist(input: WhitelistRequest): Promise<unknown>
  refreshVisibility(input: RefreshVisibilityRequest): Promise<unknown>
  issue(input: IssueRequest): Promise<unknown>
  actOnIssuance(input: IssuanceRequest): Promise<unknown>
  reassign(input: ReassignRequest): Promise<unknown>
}

type AsyncHandler = (request: Request, response: Response) => Promise<void>

const id = z.string().trim().min(1).max(512)
const sync = z.enum(['global-sync', 'private-sync'])
const transferRequest = z.object({
  synchronizer: sync,
  actor: id,
  contractId: id,
  receiver: id,
}).strict()
const instructionRequest = z.object({
  synchronizer: sync,
  actor: id,
  contractId: id,
  action: z.enum(['accept', 'reject', 'withdraw']),
}).strict()
const whitelistRequest = z.object({
  synchronizer: sync,
  actor: id,
  observers: z.array(id).max(32),
}).strict()
const refreshVisibilityRequest = z.object({
  synchronizer: sync,
  actor: id,
  contractId: id,
}).strict()
const issueRequest = z.object({
  actor: id,
  receiver: id,
  amount: z.string().max(39).refine(isValidIssueAmount),
}).strict()
const issuanceRequest = z.object({
  synchronizer: sync,
  actor: id,
  contractId: id,
  action: z.enum(['accept', 'withdraw']),
}).strict()
const reassignRequest = z.object({
  synchronizer: sync,
  actor: id,
  contractId: id,
}).strict()

function parseBody<T>(
  schema: z.ZodType<T>,
  request: Request,
  response: Response,
): T | undefined {
  const result = schema.safeParse(request.body)
  if (result.success) return result.data
  response.status(400).json({ error: 'Invalid request parameters' })
  return undefined
}

function route(handler: AsyncHandler) {
  return (request: Request, response: Response) => {
    handler(request, response).catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'The operation failed. Retry shortly.'
      const conflict = [
        'already exists',
        'Issue an HSKD Holding first',
        'already in progress',
        'change is already running',
      ].some((text) => message.includes(text))
      const badRequest = [
        'Unknown party',
        'Unknown synchronizer',
        'Provide a valid',
      ].some((text) => message.includes(text))
      const forbidden =
        message.startsWith('Only ') || message.includes('not authorized to perform')
      response
        .status(badRequest ? 400 : forbidden ? 403 : conflict ? 409 : 502)
        .json({ error: message })
    })
  }
}

export function createApp(service: DemoService) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '16kb', strict: true }))
  app.use('/api', (request, response, next) => {
    if (request.method === 'GET') return next()
    if (!request.is('application/json')) {
      response.status(415).json({ error: 'Mutating requests must use application/json' })
      return
    }
    const origin = request.get('origin')
    const allowedOrigins = new Set([
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ])
    if (origin && !allowedOrigins.has(origin)) {
      response.status(403).json({ error: 'Rejected a mutating request from a non-local origin' })
      return
    }
    next()
  })

  app.get(
    '/api/state',
    route(async (_request, response) => {
      response.json(await service.getState())
    }),
  )
  app.get(
    '/api/party-catalog',
    route(async (_request, response) => {
      response.json(await service.getPartyCatalog())
    }),
  )
  app.get(
    '/api/acs',
    route(async (request, response) => {
      const synchronizer = String(request.query.sync ?? '')
      const party = String(request.query.party ?? '')
      if (!synchronizer || !party) {
        response.status(400).json({
          error: 'Provide a valid synchronizer and party',
        })
        return
      }
      response.json(await service.getAcs({ synchronizer, party }))
    }),
  )
  app.post(
    '/api/transfer',
    route(async (request, response) => {
      const input = parseBody(transferRequest, request, response)
      if (!input) return
      response.json(await service.transfer(input))
    }),
  )
  app.post(
    '/api/transfer-instruction',
    route(async (request, response) => {
      const input = parseBody(instructionRequest, request, response)
      if (!input) return
      response.json(await service.actOnTransferInstruction(input))
    }),
  )
  app.post(
    '/api/whitelist',
    route(async (request, response) => {
      const input = parseBody(whitelistRequest, request, response)
      if (!input) return
      response.json(await service.updateWhitelist(input))
    }),
  )
  app.post(
    '/api/refresh-visibility',
    route(async (request, response) => {
      const input = parseBody(refreshVisibilityRequest, request, response)
      if (!input) return
      response.json(await service.refreshVisibility(input))
    }),
  )
  app.post(
    '/api/issue',
    route(async (request, response) => {
      const input = parseBody(issueRequest, request, response)
      if (!input) return
      response.json(await service.issue(input))
    }),
  )
  app.post(
    '/api/issuance',
    route(async (request, response) => {
      const input = parseBody(issuanceRequest, request, response)
      if (!input) return
      response.json(await service.actOnIssuance(input))
    }),
  )
  app.post(
    '/api/reassign',
    route(async (request, response) => {
      const input = parseBody(reassignRequest, request, response)
      if (!input) return
      response.json(await service.reassign(input))
    }),
  )

  return app
}
