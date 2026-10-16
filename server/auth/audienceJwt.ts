import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const USER_ID = 'CantonConsole'

function loadLocalnetEnv() {
  if (process.env.LEDGER_API_JWT_SECRET && process.env.LEDGER_API_JWT_AUDIENCE) {
    return
  }
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../localnet/.env',
  )
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const separator = trimmed.indexOf('=')
      if (separator < 1) continue
      const key = trimmed.slice(0, separator)
      const value = trimmed.slice(separator + 1)
      if (!process.env[key]) process.env[key] = value
    }
  } catch {
    // A missing .env is allowed when ledger authentication is not enabled.
  }
}

export function audienceAuthorization(): string | undefined {
  loadLocalnetEnv()
  const secret = process.env.LEDGER_API_JWT_SECRET
  const audience = process.env.LEDGER_API_JWT_AUDIENCE
  if (!secret || !audience) return undefined
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = base64Url(
    JSON.stringify({
      aud: audience,
      sub: USER_ID,
      iat: now,
      exp: now + 60,
    }),
  )
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url')
  return `Bearer ${header}.${payload}.${signature}`
}

function base64Url(value: string) {
  return Buffer.from(value).toString('base64url')
}
