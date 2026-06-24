import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)

let _promClient: any | null | undefined = undefined
function tryLoadPromClient() {
    if (_promClient !== undefined) return _promClient
    try {
        _promClient = _require('prom-client')
    } catch {
        _promClient = null
    }
    return _promClient
}

let _deadLetterCounter: any | undefined = undefined
let _publishedCounter: any | undefined = undefined
let _failedCounter: any | undefined = undefined
let _pendingGauge: any | undefined = undefined
let _leaseRenewCounter: any | undefined = undefined
let _quarantineCounter: any | undefined = undefined

function getMetric(name: string, type: 'Counter' | 'Gauge', help: string, labelNames: string[] = []) {
    const prom = tryLoadPromClient()
    if (!prom) return null
    try {
        const existing = prom.register.getSingleMetric(name)
        if (existing) return existing
        return new prom[type]({
            name,
            help,
            labelNames,
            registers: [prom.register],
        })
    } catch {
        return null
    }
}

export function incrementOutboxDeadLetter(errorCode: string = 'UNKNOWN') {
    if (!_deadLetterCounter) {
        _deadLetterCounter = getMetric('outbox_dead_letter_total', 'Counter', 'Total number of outbox events moved to dead-letter', ['error_code'])
    }
    if (_deadLetterCounter) {
        try { _deadLetterCounter.inc({ error_code: errorCode }, 1) } catch {}
    }
}

export function incrementOutboxPublished(aggregateType: string = 'UNKNOWN') {
    if (!_publishedCounter) {
        _publishedCounter = getMetric('outbox_published_total', 'Counter', 'Total number of successfully published outbox events', ['aggregate_type'])
    }
    if (_publishedCounter) {
        try { _publishedCounter.inc({ aggregate_type: aggregateType }, 1) } catch {}
    }
}

export function incrementOutboxFailed(aggregateType: string = 'UNKNOWN') {
    if (!_failedCounter) {
        _failedCounter = getMetric('outbox_failed_total', 'Counter', 'Total number of failed outbox event publish attempts', ['aggregate_type'])
    }
    if (_failedCounter) {
        try { _failedCounter.inc({ aggregate_type: aggregateType }, 1) } catch {}
    }
}

export function setOutboxPendingGauge(count: number) {
    if (!_pendingGauge) {
        _pendingGauge = getMetric('outbox_pending_gauge', 'Gauge', 'Current number of pending outbox events')
    }
    if (_pendingGauge) {
        try { _pendingGauge.set(count) } catch {}
    }
}

export function incrementOutboxLeaseRenew(count: number = 1) {
    if (!_leaseRenewCounter) {
        _leaseRenewCounter = getMetric('outbox_lease_renew_total', 'Counter', 'Total number of outbox events whose lease was renewed')
    }
    if (_leaseRenewCounter) {
        try { _leaseRenewCounter.inc(count) } catch {}
    }
}

export function incrementOutboxQuarantine(reason: string = 'unknown') {
    if (!_quarantineCounter) {
        _quarantineCounter = getMetric('outbox_quarantine_total', 'Counter', 'Total number of outbox events moved to quarantine', ['reason'])
    }
    if (_quarantineCounter) {
        try { _quarantineCounter.inc({ reason }, 1) } catch {}
    }
}

export function _resetOutboxMetricsCacheForTests(): void {
    const prom = tryLoadPromClient()
    if (prom) {
        prom.register.clear()
    }
    _promClient = undefined
    _deadLetterCounter = undefined
    _publishedCounter = undefined
    _failedCounter = undefined
    _pendingGauge = undefined
    _leaseRenewCounter = undefined
    _quarantineCounter = undefined
}
