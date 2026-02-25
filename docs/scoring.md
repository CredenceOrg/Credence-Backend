# Reputation Scoring: Time-Weight Logic

The Credence Reputation Engine rewards users who commit capital for longer periods. This commitment is measured via the Time-Weight Multiplier.

## Multiplier Formula
We use a logarithmic growth function to ensure that while long-term bonding is rewarded, it does not lead to "reputation monopolies."

**Formula:**
`Multiplier = min(5.0, 1 + ln(1 + duration_in_days / 30))`

## Design Rationale
- **Incentive**: Moving from a 0-day bond to a 30-day bond provides the steepest reputation gain.
- **Diminishing Returns**: As durations reach years, the increase in the multiplier slows down.
- **Sustainability**: By capping the multiplier at 5.0, we ensure that new participants can still compete with long-standing participants if they provide high-quality evidence or bond larger amounts.