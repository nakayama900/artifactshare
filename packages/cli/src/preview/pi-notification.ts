import { appendFileSync, readFileSync } from 'node:fs'
import type { PreviewAgentNotificationRegistration } from './contract.js'
import type {
  PreviewAgentAdapter,
  PreviewAgentAdapterResult,
  PreviewBatchReadyEvent,
} from './notification.js'

/**
 * pi (https://pi.dev/, @earendil-works/pi-coding-agent) injects its session
 * identity into every Bash tool invocation by default
 * (dist/core/tools/bash.js `resolveSpawnContext` sets `PI_SESSION_ID` and
 * `PI_SESSION_FILE` when `exposeSessionEnvironment` is on, which it is by
 * default). Detection can therefore read the environment directly, exactly
 * like the Claude adapter.
 *
 * pi has no background-task completion hook, so the Claude-style wait
 * transport cannot apply. The wake path is file-based: pi sessions are JSONL
 * trees, and a pending follow-up can be surfaced by appending a notification
 * record next to the live session file. The agent-side loop polls that file
 * through `preview next --wait`, which pi can run in the foreground of its
 * own turn.
 */

const PI_SESSION_PATTERN = /^[^\r\n]{1,512}$/
const PREVIEW_SESSION_PATTERN = /^[0-9a-f]{16}$/
const BATCH_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i

export function piNotificationRegistration(
  environment: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): PreviewAgentNotificationRegistration | null {
  const sessionId = environment.PI_SESSION_ID?.trim() ?? ''
  const sessionFile = environment.PI_SESSION_FILE?.trim() ?? ''
  if (sessionId === '' && sessionFile === '') return null
  const valid = PI_SESSION_PATTERN.test(sessionId) && PI_SESSION_PATTERN.test(sessionFile)
  if (!valid && sessionId === '' && sessionFile !== '') {
    return null
  }
  return {
    provider: 'pi',
    transport: valid ? 'session_file' : 'manual',
    capability: valid ? 'push' : 'manual',
    target: valid ? sessionFile : null,
    registered_at: now().toISOString(),
  }
}

/** The signal-only payload appended to `<session-file>.preview-wake`. */
export function piWakeRecord(event: PreviewBatchReadyEvent): string {
  return [
    `registered_at=${new Date().toISOString()}`,
    `event=${event.event}`,
    `preview_session_id=${event.preview_session_id}`,
    `batch_id=${event.batch_id}`,
    `next_command=npm exec --yes --package=@artifactshare/cli -- artifactshare preview next --session ${event.preview_session_id} --json`,
  ].join(' ')
}

export function piWakeFilePath(sessionFile: string): string {
  return `${sessionFile}.preview-wake`
}

export type PiWakeWriter = (
  path: string,
  record: string,
) => Promise<void>

async function defaultWakeWriter(path: string, record: string): Promise<void> {
  appendFileSync(path, `${record}\n`)
}

export function createPiSessionFileAdapter(
  target: string,
  write: PiWakeWriter = defaultWakeWriter,
): PreviewAgentAdapter {
  if (!PI_SESSION_PATTERN.test(target)) {
    throw new Error('pi wake target must be a session file path.')
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
      try {
        // Reading first proves the session file still exists; a stale
        // registration must not silently create wake files for a dead
        // session.
        readFileSync(target)
      } catch {
        return {
          status: 'failed',
          code: 'target_unavailable',
          retryable: false,
        } satisfies PreviewAgentAdapterResult
      }
      try {
        await write(piWakeFilePath(target), piWakeRecord(event))
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
