# Service Level Agreements (SLA)

This document outlines the uptime commitments and Service Level Objectives (SLOs) for the Credence Backend. It is intended for **downstream integrators** who rely on our APIs to build client applications, user interfaces, or third-party backend integrations.

## Core Commitments

We measure and report on our service availability based on the following key Service Level Indicators (SLIs):
- **Availability (Uptime):** The percentage of time the API successfully serves valid requests.
- **Latency:** The time taken to process a request and return a response.

Our target Service Level Agreement (SLA) for downstream integrators is **99.9% uptime** during any calendar month.

## Per-Endpoint SLOs

Below are the SLO numbers for our most critical endpoints. These numbers represent our internal targets to ensure we meet the overarching 99.9% SLA.

### 1. Trust Score (`GET /api/trust/:address`)
- **SLI - Uptime:** 99.95% successful responses (HTTP 200).
- **SLI - Latency:** 95th percentile (P95) response time under **150ms**.
- **Example Usage:**
  ```bash
  curl https://api.credence.example.com/api/trust/GDJ...
  ```
- **Failing Scenario:** Responses taking >500ms or HTTP 5xx errors count against the error budget.

### 2. Bond Status (`GET /api/bond/:address`)
- **SLI - Uptime:** 99.9% successful responses (HTTP 200).
- **SLI - Latency:** P95 response time under **200ms**.
- **Example Usage:**
  ```bash
  curl https://api.credence.example.com/api/bond/GDJ...
  ```

### 3. Attestations (`GET /api/attestations/:address` & `POST /api/attestations`)
- **SLI - Uptime (Reads):** 99.9% successful responses.
- **SLI - Uptime (Writes):** 99.5% successful responses (due to heavier validation and downstream persistence).
- **SLI - Latency (Reads):** P95 response time under **150ms**.
- **SLI - Latency (Writes):** P95 response time under **400ms**.

### 4. Health Checks (`GET /api/health` & `GET /api/health/live`)
- **SLI - Uptime:** 99.99% availability.
- **SLI - Latency:** P99 response time under **50ms**.
- **Usage:** Integrators should rely on `/api/health/live` for simple liveness probes and `/api/health` to verify that our dependencies (database, Redis) are functioning properly.

## Monitoring and Exclusions

These SLAs apply to production environments. We actively monitor these SLIs via our Prometheus/Grafana stack (see [Observability](./OBSERVABILITY.md)). 

**Exclusions:** The following scenarios do not count against the SLA error budget:
- Scheduled maintenance windows (communicated at least 48 hours in advance).
- Rate limit rejections (HTTP 429).
- Client-side validation errors (HTTP 400).
- Outages caused by underlying blockchain network (e.g., Stellar Horizon) instability.

## Support and Escalation

If you observe performance degrading below these thresholds for a sustained period, please verify our [status page] and open an issue in the Credence Support portal.
