import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  dshNotificationRegistration,
  dshWakeFilePath,
  dshWakeRecord,
  createDshSessionFileAdapter,
} from './dsh-notification.js'

const EVENT = {
  event: 'preview.batch_ready' as const,
  preview_session_id: '0123456789abcdef',
  batch_id: 'batch-001',
}

test('registers push for an absolute session log path', () => {
  assert.deepEqual(
    dshNotificationRegistration(
      { ARTIFACTSHARE_PREVIEW_DSH_SESSION: '/home/u/dsh/sessions/run-42.jsonl' },
      () => new Date('2026-09-01T00:00:00.000Z'),
    ),
    {
      provider: 'deepseek_harness',
      transport: 'session_file',
      capability: 'push',
      target: '/home/u/dsh/sessions/run-42.jsonl',
      registered_at: '2026-09-01T00:00:00.000Z',
    },
  )
})

test('returns null without the env var and manual for a relative path', () => {
  assert.equal(dshNotificationRegistration({}), null)
  assert.equal(
    dshNotificationRegistration({
      ARTIFACTSHARE_PREVIEW_DSH_SESSION: 'sessions/run-42.jsonl',
    })?.capability,
    'manual',
  )
})

test('wake record is signal-only and one line', () => {
  const record = dshWakeRecord(EVENT)
  assert.ok(record.includes('preview_session_id=0123456789abcdef'))
  assert.ok(record.includes('batch_id=batch-001'))
  assert.ok(record.includes('preview next --session 0123456789abcdef'))
  assert.ok(!record.includes('\n'))
})

test('adapter appends a wake line for a live session log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wake-'))
  const sessionLog = join(dir, 'run-42.jsonl')
  writeFileSync(sessionLog, '{"type":"session.start"}\n')
  try {
    const adapter = createDshSessionFileAdapter(sessionLog)
    assert.deepEqual(await adapter.dispatch(EVENT), { status: 'accepted' })
    const wake = readFileSync(dshWakeFilePath(sessionLog), 'utf8')
    assert.ok(wake.includes('batch_id=batch-001'))
    assert.ok(wake.endsWith('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('adapter reports target_unavailable when the session log is gone', async () => {
  const adapter = createDshSessionFileAdapter('/nonexistent/run-42.jsonl')
  assert.deepEqual(await adapter.dispatch(EVENT), {
    status: 'failed',
    code: 'target_unavailable',
    retryable: false,
  })
})
