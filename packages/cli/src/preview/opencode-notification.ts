import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PreviewAgentNotificationRegistration } from './contract.js'
import type {
  PreviewAgentAdapter,
  PreviewAgentAdapterResult,
  PreviewBatchReadyEvent,
} from './notification.js'

/**
 * OpenCode (https://opencode.ai/docs/server/) exposes a local HTTP server
 * (`opencode serve`, also started alongside the TUI). The async prompt
 * endpoint queues a message into a live session without waiting for the
 * reply (`POST /session/:id/prompt_async` -> 204 No Content), which is the
 * same shape as the Codex queue transport: a signal-only nudge that the
 * agent answers by pulling `preview next` itself.
 *
 * Unlike Codex, OpenCode does not currently inject session identifiers into
 * the Bash tool environment (core/src/tool/bash.ts spawns with the inherited
 * `process.env` plus plugin `shell.env` extras only), so the session id must
 * be passed explicitly: set `ARTIFACTSHARE_PREVIEW_OPENCODE_SESSION` to the
 * OpenCode session id shown by the TUI.
 */

const OPENCODE_SESSION_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
const PREVIEW_SESSION_PATTERN = /^[0-9a-f]{16}$/
const DEFAULT_OPENCODE_PORT = 4096

export interface OpenCodeTarget {
  port: number
  sessionId: string
  token: string | null
}

/** `opencode:<port>:<session-id>[:<token>]` — the stored registration target. */
export function parseOpenCodeTarget(target: string): OpenCodeTarget | null {
  const match = /^opencode:(\d+):([a-zA-Z0-9_-]{1,128})(?::(\S+))?$/.exec(
    target,
  )
  if (!match) return null
  const port = Number(match[1])
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { port, sessionId: match[2] ?? '', token: match[3] ?? null }
}

export function opencodeNotificationRegistration(
  environment: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): PreviewAgentNotificationRegistration | null {
  const sessionId =
    environment.ARTIFACTSHARE_PREVIEW_OPENCODE_SESSION?.trim() ?? ''
  if (sessionId === '') return null
  if (!OPENCODE_SESSION_PATTERN.test(sessionId)) {
    return {
      provider: 'opencode',
      transport: 'prompt_async',
      capability: 'manual',
      target: null,
      registered_at: now().toISOString(),
    }
  }
  const portEnv = Number(environment.OPENCODE_SERVER_PORT ?? DEFAULT_OPENCODE_PORT)
  const port =
    Number.isInteger(portEnv) && portEnv > 0 && portEnv <= 65535
      ? portEnv
      : DEFAULT_OPENCODE_PORT
  const token = environment.OPENCODE_SERVER_PASSWORD?.trim() ?? ''
  const target = `opencode:${port}:${sessionId}${token ? `:${token}` : ''}`
  return {
    provider: 'opencode',
    transport: 'prompt_async',
    capability: 'push',
    target,
    registered_at: now().toISOString(),
  }
}

/** The signal-only message queued into the OpenCode session. */
export function opencodeSignalMessage(event: PreviewBatchReadyEvent): string {
  return [
    'Artifact Share preview batch ready.',
    `event=${event.event}`,
    `preview_session_id=${event.preview_session_id}`,
    `batch_id=${event.batch_id}`,
    `Run: npm exec --yes --package=@artifactshare/cli -- artifactshare preview next --session ${event.preview_session_id} --json`,
  ].join(' ')
}

export type OpenCodePoster = (
  url: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
) => Promise<{ status: number }>

async function defaultPoster(
  url: string,
  init: Parameters<OpenCodePoster>[1],
): Promise<{ status: number }> {
  const response = await fetch(url, init)
  return { status: response.status }
}

export function createOpenCodeSessionAdapter(
  target: string,
  post: OpenCodePoster = defaultPoster,
  timeoutMs = 10_000,
): PreviewAgentAdapter {
  const parsed = parseOpenCodeTarget(target)
  if (!parsed) {
    throw new Error('OpenCode target must be opencode:<port>:<session-id>[:<token>].')
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (parsed.token !== null) {
    headers.authorization = `Basic ${Buffer.from(`opencode:${parsed.token}`).toString('base64')}`
  }
  return {
    async dispatch(event) {
      if (
        !PREVIEW_SESSION_PATTERN.test(event.preview_session_id) ||
        !OPENCODE_SESSION_PATTERN.test(parsed.sessionId)
      ) {
        return {
          status: 'failed',
          code: 'invalid_response',
          retryable: false,
        } satisfies PreviewAgentAdapterResult
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const result = await post(
          `http://127.0.0.1:${parsed.port}/session/${parsed.sessionId}/prompt_async`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              parts: [{ type: 'text', text: opencodeSignalMessage(event) }],
            }),
            signal: controller.signal,
          },
        )
        if (result.status === 204 || result.status === 200) {
          return { status: 'accepted' }
        }
        if (result.status === 404 || result.status === 401 || result.status === 403) {
          return {
            status: 'failed',
            code: 'target_unavailable',
            retryable: false,
          } satisfies PreviewAgentAdapterResult
        }
        return {
          status: 'failed',
          code: 'rejected',
          retryable: false,
        } satisfies PreviewAgentAdapterResult
      } catch (error) {
        const code = String(
          (error as { code?: unknown }).code ?? '',
        )
        if (
          code === 'ECONNREFUSED' ||
          code === 'ENOTFOUND' ||
          code === 'ECONNRESET' ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
          return {
            status: 'failed',
            code: 'target_unavailable',
            retryable: true,
          } satisfies PreviewAgentAdapterResult
        }
        return {
          status: 'failed',
          code: 'adapter_error',
          retryable: true,
        } satisfies PreviewAgentAdapterResult
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
