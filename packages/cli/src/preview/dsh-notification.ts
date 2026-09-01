import { accessSync, appendFileSync, constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { PreviewAgentNotificationRegistration } from './contract.js'
import type {
  PreviewAgentAdapter,
  PreviewAgentAdapterResult,
  PreviewBatchReadyEvent,
} from './notification.js'

/**
 * DeepSeek Harness (dsh, https://deepseek.com/harness/) records every run in
 * an append-only session log; resume, fork, and replay all operate on that
 * event stream (developer preview docs). As of 2026-09 there is no public
 * API for queuing an external follow-up into a live dsh session: the
 * Schedule overlay only delivers reminders the agent itself created, and the
 * GitHub review overlay spawns its own webhook-driven sessions rather than
 * nudging an existing one.
 *
 * Until dsh grows a queue-style API (the natural home would be a Cordis
 * plugin), this adapter mirrors the pi session-file wake: the user points
 * `ARTIFACTSHARE_PREVIEW_DSH_SESSION` at the session log of the session that
 * should receive preview batches, and dispatch appends a signal-only record
 * to `<session-log>.preview-wake`. A watcher (shell loop, tmux pane, or a
 * future dsh plugin) consumes the file and resumes the session. The path is
 * explicit opt-in because dsh's Bash-environment injection is not verified.
 */

const PREVIEW_SESSION_PATTERN = /^[0-9a-f]{16}$/
const BATCH_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i

function isSessionLogPath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && isAbsolute(value)
}

export function dshNotificationRegistration(
  environment: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): PreviewAgentNotificationRegistration | null {
  const sessionLog = environment.ARTIFACTSHARE_PREVIEW_DSH_SESSION?.trim() ?? ''
  if (sessionLog === '') return null
  if (!isSessionLogPath(sessionLog)) {
    return {
      provider: 'deepseek_harness',
      transport: 'session_file',
      capability: 'manual',
      target: null,
      registered_at: now().toISOString(),
    }
  }
  return {
    provider: 'deepseek_harness',
    transport: 'session_file',
    capability: 'push',
    target: sessionLog,
    registered_at: now().toISOString(),
  }
}

export function dshWakeFilePath(sessionLog: string): string {
  return `${sessionLog}.preview-wake`
}

/** The signal-only payload appended to the wake file. */
export function dshWakeRecord(event: PreviewBatchReadyEvent): string {
  return [
    `registered_at=${new Date().toISOString()}`,
    `event=${event.event}`,
    `preview_session_id=${event.preview_session_id}`,
    `batch_id=${event.batch_id}`,
    `next_command=npm exec --yes --package=@artifactshare/cli -- artifactshare preview next --session ${event.preview_session_id} --json`,
  ].join(' ')
}

export type DshWakeWriter = (path: string, record: string) => Promise<void>

async function defaultWakeWriter(path: string, record: string): Promise<void> {
  appendFileSync(path, `${record}\n`)
}

export function createDshSessionFileAdapter(
  target: string,
  write: DshWakeWriter = defaultWakeWriter,
): PreviewAgentAdapter {
  if (!isSessionLogPath(target)) {
    throw new Error('dsh wake target must be an absolute session log path.')
  }
  return {
    async dispatch(event) {
      if (
        !PREVIEW_SESSION_PATTERN.test(event.preview_session_id) ||
        !BATCH_ID_PATTERN.test(event.batch_id)
      ) {
        return {
          status: 'failed',
          code: 'invalid_response',
          retryable: false,
        } satisfies PreviewAgentAdapterResult
      }
      // Unlike pi, the dsh session log is owned by the dsh process; a missing
      // file at dispatch time means the registration is stale, and the wake
      // file must not be created for a dead session either.
      try {
        accessSync(target, constants.F_OK)
      } catch {
        return {
          status: 'failed',
          code: 'target_unavailable',
          retryable: false,
        } satisfies PreviewAgentAdapterResult
      }
      try {
        await write(dshWakeFilePath(target), dshWakeRecord(event))
        return { status: 'accepted' }
      } catch {
        return {
          status: 'failed',
          code: 'adapter_error',
          retryable: true,
        } satisfies PreviewAgentAdapterResult
      }
    },
  }
}
