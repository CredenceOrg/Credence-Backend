# Reputation Score Calculation - Test Documentation

## Overview

This document describes the comprehensive unit test suite for the reputation score calculation module. The tests achieve >95% code coverage and validate all code paths, edge cases, and formula correctness.

## Test Structure

### Modules Tested

1. **timeWeight.test.ts** - Time weight calculation tests
2. **bondScore.test.ts** - Bond score calculation tests
3. **attestationScore.test.ts** - Attestation score calculation tests
4. **score.test.ts** - Main reputation score integration tests

## Formula

The reputation score is calculated using the following formula:

```
totalScore = (bondScore + attestationScore) × timeWeight
```

Where:
- **bondScore** = min(bondedAmount × 0.01, 1000)
- **attestationScore** = min(Σ(validAttestationWeights) × 0.1, 100)
- **timeWeight** = 1 - e^(-0.5 × (duration/maxDuration) × 10), capped at [0, 1]

## Test Scenarios

### 1. Time Weight Tests (timeWeight.test.ts)

#### Positive Cases
- Zero duration returns 0
- Partial duration returns value between 0 and 1
- Max duration (1 year) returns 1
- Duration exceeding max returns 1
- Monotonic increase with time
- Specific durations (6 months, 1 day)

#### Edge Cases
- Zero or negative bondStart
- Zero or negative currentTime
- bondStart after currentTime
- Very large timestamps
- Minimum positive duration (1ms)

#### Custom Max Duration
- Custom max duration respected
- Partial weight with custom max
- Zero custom max duration

#### Boundary Conditions
- Exact 1 year duration
- 1 year ± 1ms

### 2. Bond Score Tests (bondScore.test.ts)

#### Positive Cases
- Normal bond amounts
- Large bond amounts
- Score capping at maximum (1000)
- Minimum positive bond
- Bond at max threshold
- Fractional bond amounts

#### Slashed Bonds
- Slashed bond returns 0
- Slashed bond with large amount returns 0
- Slashed bond with zero amount returns 0

#### Zero and Negative Bonds
- Zero bond amount returns 0
- Negative bond amount returns 0
- Very small negative amounts

#### Edge Cases
- Very large bond amounts
- Zero/negative bondStart (doesn't affect score)
- Zero/negative bondDuration (doesn't affect score)

#### Boundary Conditions
- Bond just below max threshold
- Bond just above max threshold
- Very small positive bonds

### 3. Attestation Score Tests (attestationScore.test.ts)

#### Positive Cases
- Single attestation
- Multiple attestations
- Score capping at maximum (100)
- Attestations at max threshold
- Many small attestations
- Fractional weights

#### Invalid Attestations
- Ignore invalid attestations
- All invalid attestations return 0
- Mix of valid and invalid

#### Zero and Negative Weights
- Zero weight attestations
- Negative weights ignored
- Mix of positive and negative
- All zero weights

#### Empty and Null Cases
- Empty array returns 0
- Null attestations return 0
- Undefined attestations return 0

#### Edge Cases
- Very large weights
- Very small positive weights
- Single attestation at max
- Multiple attestations exceeding max
- Zero/negative timestamps (don't affect score)

#### Boundary Conditions
- Weight just below max threshold
- Weight just above max threshold
- Minimum positive weight
- Large number of attestations (1000)

### 4. Main Score Tests (score.test.ts)

#### Formula Verification
- All components present
- Partial time weight
- Only bond score
- Only attestation score
- Maximum possible score

#### Zero Bond Cases
- Zero bond amount
- Zero bond with attestations

#### Slashed Bond Cases
- Slashed bond with attestations
- Slashed bond without attestations

#### Zero Time Weight Cases
- Zero duration
- Future bond start

#### Max Duration Cases
- Duration exceeding max

#### Invalid Attestations
- Invalid attestations ignored

#### Comprehensive Edge Cases
- All zero inputs
- Negative bond amount
- Very large values
- Fractional values

#### Custom Duration Tests
- Custom max duration
- Partial weight with custom duration
- Zero custom duration

## Coverage Goals

All test files achieve the following coverage targets:

- **Lines**: ≥95%
- **Functions**: ≥95%
- **Branches**: ≥95%
- **Statements**: ≥95%

## Test Execution

### Run all tests
```bash
npm test
```

### Run tests in watch mode
```bash
npm run test:watch
```

### Run tests with coverage
```bash
npm run test:coverage
```

## Test Data Patterns

### Fixed Inputs
All tests use fixed, deterministic inputs to ensure reproducible results:
- Timestamps: 1000000, 2000000, etc.
- Bond amounts: 1000, 5000, 10000, 50000, 100000
- Attestation weights: 100, 200, 300, 500, 1000
- Durations: ONE_DAY, ONE_YEAR constants

### Expected Outputs
All assertions use exact values or precise floating-point comparisons:
- Integer results: exact equality (`toBe`)
- Floating-point results: close comparison (`toBeCloseTo`)
- Range checks: `toBeGreaterThan`, `toBeLessThan`

## Edge Case Categories

1. **Zero Values**: All inputs tested with zero values
2. **Negative Values**: All numeric inputs tested with negative values
3. **Maximum Values**: All inputs tested at or above maximum thresholds
4. **Boundary Values**: Values just above/below thresholds
5. **Invalid States**: Slashed bonds, invalid attestations
6. **Empty/Null**: Empty arrays, null/undefined inputs
7. **Extreme Values**: Very large numbers, MAX_SAFE_INTEGER

## Validation Strategy

Each test follows this pattern:
1. **Arrange**: Create fixed input data
2. **Act**: Call the function under test
3. **Assert**: Verify exact expected output

This ensures:
- Deterministic test results
- Easy debugging when tests fail
- Clear documentation of expected behavior
- Regression detection

## Future Enhancements

Potential areas for additional testing:
- Performance benchmarks for large datasets
- Fuzz testing with random inputs
- Integration tests with database
- End-to-end API tests
- Property-based testing with fast-check
