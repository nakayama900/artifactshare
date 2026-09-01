import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  piNotificationRegistration,
  piWakeFilePath,
  piWakeRecord,
  createPiSessionFileAdapter,
} from './pi-notification.js'

const EVENT = {
  event: 'preview.batch_ready' as const,
  preview_session_id: '0123456789abcdef',
  batch_id: 'batch-001',
}

test('registers push when pi session env is present', () => {
  assert.deepEqual(
    piNotificationRegistration(
      {
        PI_SESSION_ID: '20260901_120000_ab12cd34',
        PI_SESSION_FILE: '/home/u/.pi/agent/sessions/2026-09-01/20260901_120000_ab12cd34.jsonl',
      },
      () => new Date('2026-09-01T00:00:00.000Z'),
    ),
    {
      provider: 'pi',
      transport: 'session_file',
      capability: 'push',
      target: '/home/u/.pi/agent/sessions/2026-09-01/20260901_120000_ab12cd34.jsonl',
      registered_at: '2026-09-01T00:00:00.000Z',
    },
  )
})

test('returns null without pi session env', () => {
  assert.equal(piNotificationRegistration({}), null)
})

test('wake record is signal-only and one line', () => {
  const record = piWakeRecord(EVENT)
  assert.ok(record.includes('preview_session_id=0123456789abcdef'))
  assert.ok(record.includes('batch_id=batch-001'))
  assert.ok(record.includes('preview next --session 0123456789abcdef'))
  assert.ok(!record.includes('\n'))
})

test('adapter appends a wake line beside a live session file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-wake-'))
  const sessionFile = join(dir, 'session.jsonl')
  writeFileSync(sessionFile, '{"type":"message"}\n')
  try {
    const adapter = createPiSessionFileAdapter(sessionFile)
    assert.deepEqual(await adapter.dispatch(EVENT), { status: 'accepted' })
    const wake = readFileSync(piWakeFilePath(sessionFile), 'utf8')
    assert.ok(wake.includes('batch_id=batch-001'))
    assert.ok(wake.endsWith('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('adapter reports target_unavailable when the session file is gone', async () => {
  const adapter = createPiSessionFileAdapter('/nonexistent/session.jsonl')
  assert.deepEqual(await adapter.dispatch(EVENT), {
    status: 'failed',
    code: 'target_unavailable',
    retryable: false,
  })
})
