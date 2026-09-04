import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpClient } from '../src/http.js'
import { MediaJob, mapJobState } from '../src/media-job.js'
import { MediaError, redactSecrets } from '../src/errors.js'

test('HttpClient retries idempotent 429 and honors Retry-After', async () => {
  let calls = 0
  const http = new HttpClient(async () => {
    calls += 1
    return calls === 1
      ? new Response('busy', { status: 429, headers: { 'Retry-After': '0' } })
      : Response.json({ ok: true })
  })
  const value = await http.json<{ ok: boolean }>('https://example.test/resource', { retries: 1 })
  assert.deepEqual(value, { ok: true })
  assert.equal(calls, 2)
})

test('HttpClient timeout interrupts network-error backoff', async () => {
  const http = new HttpClient(async () => { throw new Error('offline') })
  const started = Date.now()
  await assert.rejects(http.request('https://example.test/retry', { retries: 3, timeoutMs: 10 }), { code: 'TIMEOUT' })
  assert.equal(Date.now() - started < 200, true)
})

test('HttpClient timeout interrupts a long Retry-After delay', async () => {
  const http = new HttpClient(async () => new Response('busy', { status: 429, headers: { 'Retry-After': '3600' } }))
  await assert.rejects(http.request('https://example.test/retry', { retries: 1, timeoutMs: 10 }), { code: 'TIMEOUT' })
})

test('HttpClient enforces timeout while consuming a JSON body', async () => {
  const http = new HttpClient(async () => new Response(new ReadableStream({ start() {} }), {
    headers: { 'Content-Type': 'application/json' },
  }))
  await assert.rejects(http.json('https://example.test/stalled', { timeoutMs: 10 }), { code: 'TIMEOUT' })
})

test('HttpClient does not retry paid POST submissions by default', async () => {
  let calls = 0
  const http = new HttpClient(async () => {
    calls += 1
    return new Response('busy', { status: 429, headers: { 'Retry-After': '2' } })
  })
  await assert.rejects(
    http.request('https://example.test/jobs', { method: 'POST', body: '{}', retries: 3 }),
    (error: unknown) => error instanceof MediaError && error.code === 'RATE_LIMITED' && error.retryAfterMs === 2_000,
  )
  assert.equal(calls, 1)
})

test('MediaJob polls with backoff state mapping and returns normalized result', async () => {
  const statuses = ['PENDING', 'RUNNING', 'SUCCEEDED']
  const job = new MediaJob<string>({
    id: 'job-1', provider: 'mock', minDelayMs: 1, maxDelayMs: 1, timeoutMs: 1_000,
    poll: async () => {
      const raw = statuses.shift()
      const state = mapJobState(raw)
      return state === 'succeeded' ? { state, result: 'done' } : { state }
    },
  })
  assert.equal(await job.wait(), 'done')
})

test('MediaJob times out even when a poll promise never settles', async () => {
  let cancelled = false
  const job = new MediaJob<string>({
    id: 'job-stalled', provider: 'mock', timeoutMs: 10,
    poll: () => new Promise(() => undefined),
    cancel: async () => { cancelled = true },
  })
  await assert.rejects(job.wait(), (error: unknown) => error instanceof MediaError && error.code === 'TIMEOUT')
  assert.equal(cancelled, true)
})

test('MediaJob abort invokes provider cancellation when available', async () => {
  const controller = new AbortController()
  let cancelled = false
  const job = new MediaJob<string>({
    id: 'job-2', provider: 'mock', signal: controller.signal, minDelayMs: 20, timeoutMs: 1_000,
    poll: async () => ({ state: 'running' }),
    cancel: async () => { cancelled = true },
  })
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(job.wait(), (error: unknown) => error instanceof MediaError && error.code === 'ABORTED')
  assert.equal(cancelled, true)
})

test('secret redaction masks bearer tokens and explicit keys', () => {
  const key = 'sk-secret-value-123456'
  const redacted = redactSecrets(`Authorization: Bearer ${key}; api_key=${key}`, [key])
  assert.equal(redacted.includes(key), false)
  assert.match(redacted, /REDACTED/)
})
