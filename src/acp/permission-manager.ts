/**
 * Permission manager for ACP permission requests.
 *
 * Mirrors obsidian-agent-client `src/acp/permission-handler.ts` but adapted
 * for DSH: resolution surfaces through a DSH tool / session update instead of
 * an Obsidian modal. Queue semantics: only the first pending request is
 * "active"; responding to it activates the next one.
 *
 * @module dsh-plugin-zn-agent-client/acp/permission-manager
 */

import * as acp from '@agentclientprotocol/sdk'
import type { SessionUpdate } from '../types/index.ts'

/** Normalized option stored on a pending request. */
export interface NormalizedPermissionOption {
  optionId: string
  name: string
  kind: acp.PermissionOptionKind
}

/** Internal representation of a pending permission request. */
export interface PendingRequest {
  requestId: string
  toolCallId: string
  options: NormalizedPermissionOption[]
  sessionId: string
  resolve: (response: acp.RequestPermissionResponse) => void
  isActive: boolean
}

/** Normalize an agent-provided option, inferring a kind when absent. */
function normalizeOption(opt: acp.PermissionOption): NormalizedPermissionOption {
  const kind: acp.PermissionOptionKind = opt.kind ?? (
    opt.name.toLowerCase().includes('allow') ? 'allow_once' : 'reject_once'
  )
  return { optionId: opt.optionId, name: opt.name, kind }
}

/**
 * PermissionManager: manages ACP permission request queue with auto-allow support.
 */
export class PermissionManager {
  private pendingRequests = new Map<string, PendingRequest>()
  private requestQueue: string[] = []
  private autoAllow = false

  /** Set auto-allow mode (all permission requests auto-approved). */
  setAutoAllow(enabled: boolean): void {
    this.autoAllow = enabled
  }

  /**
   * Request permission from the user (or auto-allow).
   * @param params - ACP permission request parameters
   * @param onSessionUpdate - Callback to emit a session update for UI
   * @returns Promise resolving to the ACP permission response
   */
  request(
    params: acp.RequestPermissionRequest,
    onSessionUpdate: (update: SessionUpdate) => void,
  ): Promise<acp.RequestPermissionResponse> {
    // Auto-allow: pick the first allow-ish option, falling back to the first option.
    if (this.autoAllow) {
      const allowOption = params.options.find(opt =>
        opt.kind === 'allow_once' || opt.kind === 'allow_always' ||
        (!opt.kind && opt.name.toLowerCase().includes('allow'))
      ) ?? params.options[0]
      if (!allowOption) {
        return Promise.resolve({ outcome: { outcome: 'cancelled' } })
      }
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: allowOption.optionId } })
    }

    // Generate unique request ID
    const requestId = crypto.randomUUID()
    const toolCallId = params.toolCall?.toolCallId || crypto.randomUUID()

    // Normalize options (preserve agent-provided kind, infer when absent)
    const normalizedOptions = params.options.map(normalizeOption)

    // Check if this is the first request in queue
    const isFirstRequest = this.requestQueue.length === 0

    // Create pending request
    const pending: PendingRequest = {
      requestId,
      toolCallId,
      options: normalizedOptions,
      sessionId: params.sessionId,
      resolve: () => {}, // Will be set below
      isActive: isFirstRequest,
    }

    // Create promise
    const promise = new Promise<acp.RequestPermissionResponse>((resolve) => {
      pending.resolve = resolve
    })

    this.pendingRequests.set(requestId, pending)
    this.requestQueue.push(requestId)

    // Emit session update for UI
    onSessionUpdate({
      type: 'tool_call',
      sessionId: params.sessionId,
      toolCallId,
      title: params.toolCall?.title || 'Permission Request',
      status: 'pending',
      permissionRequest: {
        requestId,
        options: normalizedOptions,
        isActive: isFirstRequest,
      },
    })

    return promise
  }

  /**
   * Respond to a permission request.
   * @param requestId - The request ID
   * @param optionId - The selected option ID
   * @param onSessionUpdate - Callback to emit a session update for UI
   * @returns true if request was found and resolved
   */
  respond(requestId: string, optionId: string, onSessionUpdate: (update: SessionUpdate) => void): boolean {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return false

    // Find the selected option
    const selectedOption = pending.options.find(opt => opt.optionId === optionId)
    if (!selectedOption) return false

    // Resolve the promise
    pending.resolve({ outcome: { outcome: 'selected', optionId } })

    // Remove from queue
    this.pendingRequests.delete(requestId)
    const queueIndex = this.requestQueue.indexOf(requestId)
    if (queueIndex >= 0) {
      this.requestQueue.splice(queueIndex, 1)
    }

    // If there's a next request, activate it
    const nextRequestId = this.requestQueue[0]
    if (nextRequestId) {
      const nextPending = this.pendingRequests.get(nextRequestId)
      if (nextPending) {
        nextPending.isActive = true
        onSessionUpdate({
          type: 'tool_call',
          sessionId: nextPending.sessionId,
          toolCallId: nextPending.toolCallId,
          title: 'Permission Request',
          status: 'pending',
          permissionRequest: {
            requestId: nextRequestId,
            options: nextPending.options,
            isActive: true,
          },
        })
      }
    }

    return true
  }

  /** Cancel a specific permission request. */
  cancel(requestId: string): boolean {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return false

    // ACP cancel outcome is 'cancelled', not 'rejected'.
    pending.resolve({ outcome: { outcome: 'cancelled' } })

    // Remove from queue
    this.pendingRequests.delete(requestId)
    const queueIndex = this.requestQueue.indexOf(requestId)
    if (queueIndex >= 0) {
      this.requestQueue.splice(queueIndex, 1)
    }

    return true
  }

  /** Cancel all pending permission requests. */
  cancelAll(): void {
    for (const pending of this.pendingRequests.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    this.pendingRequests.clear()
    this.requestQueue = []
  }

  /** Get count of pending requests. */
  getPendingCount(): number {
    return this.pendingRequests.size
  }

  /** Get the active request (first in queue). */
  getActiveRequest(): PendingRequest | null {
    const first = this.requestQueue[0]
    if (!first) return null
    return this.pendingRequests.get(first) ?? null
  }
}
