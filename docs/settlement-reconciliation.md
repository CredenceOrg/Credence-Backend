# Settlement Reconciliation

The Settlement Reconciliation system is an out-of-band monitoring process that detects status drift between internal database settlement records and the actual transaction states cleared on the Stellar network.

## Reconciliation Process

- **Frequency**: Runs hourly as a scheduled background job using `JobScheduler`.
- **Sliding Window**: Reconciles settlements that have been updated/mutated in the last 24 hours.
- **Grace Period**: Skip checking pending settlements created within the last 5 minutes to avoid race conditions with standard payout submission logic.
- **Horizon queries**: Queries Stellar Horizon read-only APIs for each transaction hash.
  - If a transaction is successfully registered on-chain, its state (`tx.successful ? 'settled' : 'failed'`) is compared against the internal database status.
  - If the states mismatch, a `state_mismatch` finding is recorded.
  - If Horizon returns a `404 Not Found` for the transaction hash, a `missing_on_chain` finding is recorded.

## Findings Table Purpose

Drifts and mismatches are persisted in the `settlement_reconciliation_findings` table:
- **Auditing**: Records historical traces of settlement drifts.
- **Diagnosis**: Stores detailed context of the mismatches (including internal state, chain state, transaction hash, and query error) inside the `details` JSONB column.
- **Reporting**: Provides visibility into the frequency of network disputes and processing discrepancies.
- **Workflow note**: The table is strictly an audit and logging log; it does not trigger automatic remediation or submit transactions.

## Metric

Reconciliation drift triggers the following Prometheus metric:
- **`settlement_drift_total{finding_type="..."}`**: A Prometheus counter incremented every time reconciliation detects a new or updated drift.
  - `finding_type="state_mismatch"`: State mismatch between DB and chain.
  - `finding_type="missing_on_chain"`: Transaction hash is not found on Stellar network.

## Alert

An alert is configured to notify operators when reconciliation drift occurs:
- **`SettlementDriftDetected`**: Triggers when any new settlement drift counter increase is detected over a 5-minute window (`sum(increase(settlement_drift_total[5m])) > 0` for `2m`).
- **Severity**: `critical`.

## Operational Limitations

- **Horizon Dependency**: The reconciler requires a stable connection to Stellar Horizon. Network outages or Horizon downtime will result in logging errors, but will not crash the job scheduler or stop future reconciliation runs.
- **Grace Period**: Transactions submitted in the last 5 minutes are skipped to prevent false-alarm `missing_on_chain` alerts while transactions are pending ledger consensus.
- **Read-Only**: The job is strictly read-only and will never submit transactions to Stellar or write updates to the main `settlements` table.
