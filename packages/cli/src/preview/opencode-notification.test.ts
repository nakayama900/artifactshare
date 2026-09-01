import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  opencodeNotificationRegistration,
  opencodeSignalMessage,
  parseOpenCodeTarget,
  createOpenCodeSessionAdapter,
} from './opencode-notification.js'

const EVENT = {
  event: 'preview.batch_ready' as const,
  preview_session_id: '0123456789abcdef',
  batch_id: 'batch-001',
}

test('registers push when an OpenCode session id is provided', () => {
  assert.deepEqual(
    opencodeNotificationRegistration(
      { ARTIFACTSHARE_PREVIEW_OPENCODE_SESSION: 'ses_abc123' },
      () => new Date('2026-09-01T00:00:00.000Z'),
    ),
    {
      provider: 'opencode',
      transport: 'prompt_async',
      capability: 'push',
      target: 'opencode:4096:ses_abc123',
      registered_at: '2026-09-01T00:00:00.000Z',
    },
  )
})

test('uses OPENCODE_SERVER_PORT and token when set', () => {
  const registration = opencodeNotificationRegistration({
    ARTIFACTSHARE_PREVIEW_OPENCODE_SESSION: 'ses_abc123',
    OPENCODE_SERVER_PORT: '4100',
    OPENCODE_SERVER_PASSWORD: 'sekret',
  })
  assert.equal(registration?.target, 'opencode:4100:ses_abc123:sekret')
})

test('falls back to manual for malformed session ids', () => {
  assert.equal(
    opencodeNotificationRegistration({
      ARTIFACTSHARE_PREVIEW_OPENCODE_SESSION: 'bad session id',
    })?.capability,
    'manual',
  )
})

test('returns null when no session id is configured', () => {
  assert.equal(opencodeNotificationRegistration({}), null)
})

test('parses and validates stored targets', () => {
  assert.deepEqual(parseOpenCodeTarget('opencode:4096:ses_abc123'), {
    port: 4096,
    sessionId: 'ses_abc123',
    token: null,
  })
  assert.deepEqual(parseOpenCodeTarget('opencode:4096:ses_abc123:tok'), {
    port: 4096,
    sessionId: 'ses_abc123',
    token: 'tok',
  })
  assert.equal(parseOpenCodeTarget('opencode:0:ses_abc123'), null)
  assert.equal(parseOpenCodeTarget('codex:4096:ses_abc123'), null)
})

test('signal message carries ids and the next command without batch content', () => {
  const message = opencodeSignalMessage(EVENT)
  assert.ok(message.includes('preview_session_id=0123456789abcdef'))
  assert.ok(message.includes('batch_id=batch-001'))
  assert.ok(message.includes('preview next --session 0123456789abcdef'))
  assert.ok(!message.includes('quotedText'))
})

test('adapter posts to prompt_async and maps status codes', async () => {
  const calls: Array<{ url: string; body: string }> = []
  const post = async (url: string, init: { body: string }) => {
    calls.push({ url, init_body_placeholder: '' } as never)
    calls[calls.length - 1] = { url, body: init.body }
    return { status: 204 }
  }
  const adapter = createOpenCodeSessionAdapter(
    'opencode:4096:ses_abc123',
    post as never,
  )
  assert.deepEqual(await adapter.dispatch(EVENT), { status: 'accepted' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4096/session/ses_abc123/prompt_async')
  assert.ok(calls[0]?.body.includes('preview next'))

  const rejected = createOpenCodeSessionAdapter(
    'opencode:4096:ses_abc123',
    (async () => ({ status: 500 })) as never,
  )
  assert.deepEqual(await rejected.dispatch(EVENT), {
    status: 'failed',
    code: 'rejected',
    retryable: false,
  })

  const unavailable = createOpenCodeSessionAdapter(
    'opencode:4096:ses_abc123',
    (async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      })
    }) as never,
  )
  assert.deepEqual(await unavailable.dispatch(EVENT), {
    status: 'failed',
    code: 'target_unavailable',
    retryable: true,
  })
})
