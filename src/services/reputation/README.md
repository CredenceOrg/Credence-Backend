# Reputation Score Calculation Module

## Overview

This module provides a comprehensive reputation scoring system based on bonded amounts, attestations, and time-weighted factors.

## Formula

```
totalScore = (bondScore + attestationScore) × timeWeight
```

### Components

1. **Bond Score**: `min(bondedAmount × 0.01, 1000)`
   - Based on the amount bonded by the user
   - Capped at maximum of 1000
   - Returns 0 if bond is slashed

2. **Attestation Score**: `min(Σ(validAttestationWeights) × 0.1, 100)`
   - Sum of all valid attestation weights
   - Multiplied by 0.1
   - Capped at maximum of 100

3. **Time Weight**: `1 - e^(-0.5 × (duration/maxDuration) × 10)`
   - Exponential growth from 0 to 1
   - Based on bond duration
   - Reaches 1.0 at 1 year (default max duration)

## Usage

### Basic Usage

```typescript
import { calculateReputationScore } from './services/reputation'

const input = {
  bond: {
    bondedAmount: 10000,
    bondStart: Date.now() - 365 * 24 * 60 * 60 * 1000, // 1 year ago
    bondDuration: 365 * 24 * 60 * 60 * 1000,
    isSlashed: false,
  },
  attestations: [
    { weight: 100, timestamp: Date.now(), isValid: true },
    { weight: 200, timestamp: Date.now(), isValid: true },
  ],
  currentTime: Date.now(),
}

const result = calculateReputationScore(input)

console.log(result)
// {
//   totalScore: 130,
//   bondScore: 100,
//   attestationScore: 30,
//   timeWeight: 1
// }
```

### Custom Max Duration

```typescript
import { calculateReputationScoreWithCustomDuration } from './services/reputation'

const ONE_MONTH = 30 * 24 * 60 * 60 * 1000

const result = calculateReputationScoreWithCustomDuration(input, ONE_MONTH)
```

### Individual Component Calculations

```typescript
import {
  calculateBondScore,
  calculateAttestationScore,
  calculateTimeWeight,
} from './services/reputation'

// Calculate bond score only
const bondScore = calculateBondScore({
  bondedAmount: 5000,
  bondStart: Date.now(),
  bondDuration: 0,
  isSlashed: false,
})
// Returns: 50

// Calculate attestation score only
const attestationScore = calculateAttestationScore([
  { weight: 300, timestamp: Date.now(), isValid: true },
])
// Returns: 30

// Calculate time weight only
const timeWeight = calculateTimeWeight(
  Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
  Date.now()
)
// Returns: ~0.13 (13% of max weight)
```

## Types

```typescript
interface BondData {
  bondedAmount: number
  bondStart: number // timestamp in ms
  bondDuration: number // duration in ms
  isSlashed: boolean
}

interface Attestation {
  weight: number
  timestamp: number
  isValid: boolean
}

interface ReputationInput {
  bond: BondData
  attestations: Attestation[]
  currentTime: number
}

interface ReputationScore {
  totalScore: number
  bondScore: number
  attestationScore: number
  timeWeight: number
}
```

## Constants

```typescript
// Bond Score
const BOND_MULTIPLIER = 0.01
const MAX_BOND_SCORE = 1000

// Attestation Score
const ATTESTATION_MULTIPLIER = 0.1
const MAX_ATTESTATION_WEIGHT = 100

// Time Weight
const DECAY_RATE = 0.5
const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000 // 1 year
```

## Examples

### Example 1: New User (1 day old bond)

```typescript
const result = calculateReputationScore({
  bond: {
    bondedAmount: 5000,
    bondStart: Date.now() - 24 * 60 * 60 * 1000,
    bondDuration: 24 * 60 * 60 * 1000,
    isSlashed: false,
  },
  attestations: [
    { weight: 100, timestamp: Date.now(), isValid: true },
  ],
  currentTime: Date.now(),
})

// Result:
// bondScore: 50
// attestationScore: 10
// timeWeight: ~0.013 (very low, only 1 day)
// totalScore: ~0.78
```

### Example 2: Established User (1 year old bond)

```typescript
const result = calculateReputationScore({
  bond: {
    bondedAmount: 50000,
    bondStart: Date.now() - 365 * 24 * 60 * 60 * 1000,
    bondDuration: 365 * 24 * 60 * 60 * 1000,
    isSlashed: false,
  },
  attestations: [
    { weight: 200, timestamp: Date.now(), isValid: true },
    { weight: 300, timestamp: Date.now(), isValid: true },
    { weight: 150, timestamp: Date.now(), isValid: true },
  ],
  currentTime: Date.now(),
})

// Result:
// bondScore: 500
// attestationScore: 65
// timeWeight: 1.0 (full weight at 1 year)
// totalScore: 565
```

### Example 3: Slashed User

```typescript
const result = calculateReputationScore({
  bond: {
    bondedAmount: 100000,
    bondStart: Date.now() - 365 * 24 * 60 * 60 * 1000,
    bondDuration: 365 * 24 * 60 * 60 * 1000,
    isSlashed: true, // Bond was slashed
  },
  attestations: [
    { weight: 500, timestamp: Date.now(), isValid: true },
  ],
  currentTime: Date.now(),
})

// Result:
// bondScore: 0 (slashed)
// attestationScore: 50
// timeWeight: 1.0
// totalScore: 50 (only attestations count)
```

### Example 4: Maximum Score

```typescript
const result = calculateReputationScore({
  bond: {
    bondedAmount: 100000, // Max bond score
    bondStart: Date.now() - 365 * 24 * 60 * 60 * 1000,
    bondDuration: 365 * 24 * 60 * 60 * 1000,
    isSlashed: false,
  },
  attestations: [
    { weight: 1000, timestamp: Date.now(), isValid: true }, // Max attestation
  ],
  currentTime: Date.now(),
})

// Result:
// bondScore: 1000 (capped at max)
// attestationScore: 100 (capped at max)
// timeWeight: 1.0
// totalScore: 1100 (maximum possible)
```

## Edge Cases

### Zero Bond
```typescript
// Returns 0 bond score, but attestations still count
const result = calculateReputationScore({
  bond: { bondedAmount: 0, bondStart: Date.now(), bondDuration: 0, isSlashed: false },
  attestations: [{ weight: 100, timestamp: Date.now(), isValid: true }],
  currentTime: Date.now(),
})
// bondScore: 0, attestationScore: 10, timeWeight: 0, totalScore: 0
```

### Invalid Attestations
```typescript
// Invalid attestations are ignored
const result = calculateReputationScore({
  bond: { bondedAmount: 5000, bondStart: Date.now(), bondDuration: 0, isSlashed: false },
  attestations: [
    { weight: 100, timestamp: Date.now(), isValid: true },
    { weight: 500, timestamp: Date.now(), isValid: false }, // Ignored
  ],
  currentTime: Date.now(),
})
// Only valid attestation (100) is counted
```

### Future Bond Start
```typescript
// Bond starting in the future has 0 time weight
const result = calculateReputationScore({
  bond: {
    bondedAmount: 5000,
    bondStart: Date.now() + 24 * 60 * 60 * 1000, // Tomorrow
    bondDuration: 0,
    isSlashed: false,
  },
  attestations: [],
  currentTime: Date.now(),
})
// timeWeight: 0, totalScore: 0
```

## Testing

Comprehensive test suite with 100% coverage:

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

See [TEST_DOCUMENTATION.md](./TEST_DOCUMENTATION.md) for detailed test scenarios.

## API Reference

### Functions

#### `calculateReputationScore(input: ReputationInput): ReputationScore`
Calculate comprehensive reputation score with all components.

#### `calculateReputationScoreWithCustomDuration(input: ReputationInput, maxDuration: number): ReputationScore`
Calculate reputation score with custom maximum duration for time weight.

#### `calculateBondScore(bond: BondData): number`
Calculate bond score component only.

#### `calculateAttestationScore(attestations: Attestation[]): number`
Calculate attestation score component only.

#### `calculateTimeWeight(bondStart: number, currentTime: number, maxDuration?: number): number`
Calculate time weight component only.

### Getters

#### `getBondMultiplier(): number`
Returns the bond multiplier constant (0.01).

#### `getMaxBondScore(): number`
Returns the maximum bond score (1000).

#### `getAttestationMultiplier(): number`
Returns the attestation multiplier constant (0.1).

#### `getMaxAttestationWeight(): number`
Returns the maximum attestation weight (100).

#### `getDecayRate(): number`
Returns the time weight decay rate (0.5).

#### `getMaxDuration(): number`
Returns the default maximum duration in ms (1 year).

## License

Part of the Credence Backend project.
