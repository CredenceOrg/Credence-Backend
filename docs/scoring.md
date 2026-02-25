# Trust Score Calculation

This document describes the trust score calculation formula for the Credence protocol.

## Formula

The trust score is calculated as follows:

```
TrustScore = (BaseScore * TimeWeight * AttestationMultiplier) - SlashingPenalty
```

The final score is clamped between `0` and `100`.

## Components

### 1. Base Score (`BaseScore`)
The base score is derived from the bonded amount.
- **Formula**: `min(bondedAmount * 0.01, 100)`
- **Max Points**: 100 (reached at 10,000 units bonded)

### 2. Time Weight (`TimeWeight`)
A multiplier based on the duration the bond has been active.
- **Formula**: `min(duration / 365 days, 1.0)`
- **Growth**: Linear from 0 to 1 over one year.

### 3. Attestation Multiplier (`AttestationMultiplier`)
A boost multiplier based on the number of valid attestations.
- **Formula**: `1 + min(validAttestationCount * 0.05, 1.0)`
- **Max Multiplier**: 2.0 (reached at 20 valid attestations)

### 4. Slashing Penalty (`SlashingPenalty`)
A deduction based on the user's slashing history.
- **Formula**: `slashingCount * 50`
- **Penalty**: 50 points per slashing event.

## Examples

| Bond Amount | Duration | Attestations | Slashes | Resulting Score |
|-------------|----------|--------------|---------|-----------------|
| 10,000      | 1 year   | 20           | 0       | 100             |
| 5,000       | 6 months | 10           | 0       | 37.5            |
| 10,000      | 1 year   | 0            | 1       | 50              |
| 1,000       | 1 month  | 5            | 0       | ~1.04           |

## Configuration

Weights and limits are defined in `src/services/reputation/constants.ts`.
