interface WorkerHealthState {
  configured: boolean
  running: boolean
  lastHeartbeatAt: number | null
  lastCursor: string | null
}

export interface WorkerHealthSnapshot {
  configured: boolean
  running: boolean
  lastHeartbeatAt: number | null
  lastCursor: string | null
}

const horizonState: WorkerHealthState = {
  configured: false,
  running: false,
  lastHeartbeatAt: null,
  lastCursor: null,
}

const outboxState: WorkerHealthState = {
  configured: false,
  running: false,
  lastHeartbeatAt: null,
  lastCursor: null,
}

export function setHorizonListenerConfigured(configured: boolean): void {
  horizonState.configured = configured
}

export function setHorizonListenerRunning(running: boolean): void {
  horizonState.running = running
  if (!running) {
    horizonState.lastHeartbeatAt = null
  }
}

export function recordHorizonListenerHeartbeat(cursor?: string): void {
  horizonState.lastHeartbeatAt = Date.now()
  if (cursor !== undefined) {
    horizonState.lastCursor = cursor
  }
}

export function getHorizonListenerState(): WorkerHealthSnapshot {
  return { ...horizonState }
}

export function setOutboxPublisherConfigured(configured: boolean): void {
  outboxState.configured = configured
}

export function setOutboxPublisherRunning(running: boolean): void {
  outboxState.running = running
  if (!running) {
    outboxState.lastHeartbeatAt = null
  }
}

export function recordOutboxPublisherHeartbeat(): void {
  outboxState.lastHeartbeatAt = Date.now()
}

export function getOutboxPublisherState(): WorkerHealthSnapshot {
  return { ...outboxState }
}

export function resetWorkerHealthState(): void {
  horizonState.configured = false
  horizonState.running = false
  horizonState.lastHeartbeatAt = null
  horizonState.lastCursor = null

  outboxState.configured = false
  outboxState.running = false
  outboxState.lastHeartbeatAt = null
  outboxState.lastCursor = null
}
