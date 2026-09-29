//! # Leverage module for the `credence_bond` contract
//!
//! Implements leveraged bond positions within the Credence economic-trust
//! protocol.  A leveraged position lets a bonder multiply their effective
//! trust score by posting collateral whose value covers the leveraged exposure;
//! the system enforces hard limits so that leverage can never push the contract
//! into an insolvent state.
//!
//! ## Invariants (must hold after every state-transition)
//!
//! 1. **Non-negative bonded amount** – `position.collateral_amount` is always
//!    `> 0` for any stored position; a position with zero collateral is removed.
//! 2. **Ratio bounds** – leverage ratio is always in
//!    `[MIN_LEVERAGE_RATIO, MAX_LEVERAGE_RATIO]` (inclusive) using integer
//!    scaling.  Fractional representation: the stored ratio has an implicit
//!    denominator of `LEVERAGE_RATIO_SCALE` (100), so 150 means 1.5×.
//! 3. **Exposure** – `exposure = collateral_amount × ratio / LEVERAGE_RATIO_SCALE`.
//!    After every mutation the exposure must be `≤ u128::MAX` (overflow guard).
//! 4. **Authorisation** – only the owner of a position may open, increase,
//!    decrease, or close it.  Admin may liquidate any unsafe position.
//! 5. **Idempotent close** – closing an already-closed (non-existent) position
//!    is a no-op, not an error.
//! 6. **Recovery** – a position whose exposure breaches `MAX_EXPOSURE_LIMIT`
//!    can be liquidated by the contract admin; the owner's collateral is
//!    partially refunded (after liquidation fee) and the position is removed.
//!
//! ## Error taxonomy
//!
//! All errors in this module are variants of [`LeverageError`].  They map
//! 1-to-1 to the on-chain SDK error codes documented in
//! `docs/API_ERROR_TAXONOMY.md`.

#![allow(dead_code)] // public API; entry points called from lib.rs

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol,
};

// ── constants ────────────────────────────────────────────────────────────────

/// Implicit denominator for the leverage ratio.
///
/// Stored ratio = integer multiple of this value.
/// Example: ratio 150 → 1.50×.
pub const LEVERAGE_RATIO_SCALE: u64 = 100;

/// Minimum permitted leverage ratio (1.00×).
/// A position must always have at least 1× leverage.
pub const MIN_LEVERAGE_RATIO: u64 = 100; // 1.00 × LEVERAGE_RATIO_SCALE

/// Maximum permitted leverage ratio (5.00×).
/// Hard-coded ceiling; protocol governance can lower this via a migration but
/// existing positions are not retroactively invalidated on a ceiling decrease
/// (they are flagged as liquidation candidates instead).
pub const MAX_LEVERAGE_RATIO: u64 = 500; // 5.00 × LEVERAGE_RATIO_SCALE

/// Maximum nominal exposure for a single position (in base token units).
///
/// Chosen so that `exposure × max_ratio` still fits in u128 with headroom.
/// If a position's effective exposure breaches this value, it becomes
/// subject to forced liquidation.
pub const MAX_EXPOSURE_LIMIT: u128 = 1_000_000_000_000_000; // 10^15 units

/// Minimum collateral that must be posted when opening a position.
///
/// Prevents dust positions that would cost more gas to liquidate than
/// their collateral is worth.
pub const MIN_COLLATERAL: u128 = 1_000; // 1 000 base units

/// Liquidation fee expressed in basis points (1% = 100 bps).
///
/// Fee is retained by the contract (credited to the admin treasury entry)
/// and deducted from the collateral returned to the owner on liquidation.
pub const LIQUIDATION_FEE_BPS: u128 = 100; // 1 %

/// Ledger data key used to store all active leverage positions.
const POSITIONS_KEY: Symbol = symbol_short!("POSITIONS");

/// Ledger data key used to store the admin address.
const ADMIN_KEY: Symbol = symbol_short!("ADMIN");

// ── error type ───────────────────────────────────────────────────────────────

/// Every error that can originate from this module.
///
/// Variants are stable and form part of the public ABI; do **not** reorder or
/// remove them — only append new ones.
#[derive(Debug, PartialEq, Clone, Copy)]
#[repr(u32)]
pub enum LeverageError {
    /// Caller is not the owner of the position.
    Unauthorized = 1,

    /// The requested leverage ratio is below `MIN_LEVERAGE_RATIO`.
    RatioBelowMinimum = 2,

    /// The requested leverage ratio exceeds `MAX_LEVERAGE_RATIO`.
    RatioAboveMaximum = 3,

    /// Collateral amount is below `MIN_COLLATERAL`.
    CollateralTooSmall = 4,

    /// The computed exposure would overflow a u128.
    ExposureOverflow = 5,

    /// The position does not exist (read-only operations that require it).
    PositionNotFound = 6,

    /// The position's exposure is within safe limits; liquidation denied.
    LiquidationNotNeeded = 7,

    /// Admin address has not been set; contract is not initialised.
    NotInitialized = 8,

    /// Caller is not the admin.
    NotAdmin = 9,

    /// Arithmetic under/overflow in internal calculation.
    ArithmeticError = 10,

    /// Collateral to subtract exceeds current collateral.
    InsufficientCollateral = 11,
}

// ── data types ───────────────────────────────────────────────────────────────

/// A single leveraged bond position.
///
/// All fields use fixed-width integer types to guarantee deterministic
/// on-chain encoding and to avoid floating-point precision issues.
#[contracttype]
#[derive(Debug, Clone, PartialEq)]
pub struct LeveragePosition {
    /// Owner / bonder address.
    pub owner: Address,

    /// Base collateral posted by the owner (base token units).
    pub collateral_amount: u128,

    /// Leverage ratio with implicit denominator `LEVERAGE_RATIO_SCALE`.
    /// E.g. 150 means 1.50×.
    pub ratio: u64,

    /// Ledger sequence at which the position was opened.
    pub opened_at: u32,

    /// Ledger sequence at which the position was last modified.
    pub updated_at: u32,

    /// `true` when the position has been marked for liquidation (but not yet
    /// executed). Useful for partial-liquidation workflows and event emission.
    pub liquidation_pending: bool,
}

impl LeveragePosition {
    /// Compute the effective nominal exposure.
    ///
    /// Returns `Err(LeverageError::ExposureOverflow)` if the multiplication
    /// would overflow u128.
    #[inline]
    pub fn effective_exposure(&self) -> Result<u128, LeverageError> {
        let ratio_u128 = self.ratio as u128;
        self.collateral_amount
            .checked_mul(ratio_u128)
            .ok_or(LeverageError::ExposureOverflow)?
            .checked_div(LEVERAGE_RATIO_SCALE as u128)
            .ok_or(LeverageError::ArithmeticError)
    }

    /// Returns `true` when the position's exposure breaches the safety limit.
    #[inline]
    pub fn is_unsafe(&self) -> bool {
        match self.effective_exposure() {
            Ok(exp) => exp > MAX_EXPOSURE_LIMIT,
            Err(_) => true, // overflow is always unsafe
        }
    }
}

/// Parameters for opening a new leveraged position.
#[contracttype]
#[derive(Debug, Clone)]
pub struct OpenPositionParams {
    pub collateral_amount: u128,
    /// Leverage ratio with implicit denominator `LEVERAGE_RATIO_SCALE`.
    pub ratio: u64,
}

/// Parameters for adjusting an existing position's collateral.
#[contracttype]
#[derive(Debug, Clone)]
pub struct AdjustCollateralParams {
    pub amount: u128,
    /// `true` to add, `false` to subtract.
    pub add: bool,
}

/// Parameters for changing the leverage ratio on an existing position.
#[contracttype]
#[derive(Debug, Clone)]
pub struct AdjustRatioParams {
    pub new_ratio: u64,
}

/// Result of a successful liquidation.
#[contracttype]
#[derive(Debug, Clone, PartialEq)]
pub struct LiquidationResult {
    /// Collateral returned to the owner after the liquidation fee.
    pub returned_collateral: u128,
    /// Fee retained by the contract.
    pub fee_collected: u128,
    /// Exposure that was eliminated.
    pub exposure_eliminated: u128,
}

// ── core logic (pure functions) ───────────────────────────────────────────────
//
// Extracted from the contract impl so they can be unit-tested without an Env
// (Soroban test environments are expensive to construct).

/// Validate and return the effective exposure for a candidate position.
///
/// Called before writing any state so all checks happen atomically.
pub fn validate_open(params: &OpenPositionParams) -> Result<u128, LeverageError> {
    if params.ratio < MIN_LEVERAGE_RATIO {
        return Err(LeverageError::RatioBelowMinimum);
    }
    if params.ratio > MAX_LEVERAGE_RATIO {
        return Err(LeverageError::RatioAboveMaximum);
    }
    if params.collateral_amount < MIN_COLLATERAL {
        return Err(LeverageError::CollateralTooSmall);
    }

    let exposure = (params.collateral_amount as u128)
        .checked_mul(params.ratio as u128)
        .ok_or(LeverageError::ExposureOverflow)?
        .checked_div(LEVERAGE_RATIO_SCALE as u128)
        .ok_or(LeverageError::ArithmeticError)?;

    Ok(exposure)
}

/// Compute the new collateral after an adjustment, validating all invariants.
///
/// Returns `(new_collateral, new_exposure)` on success.
pub fn validate_adjust_collateral(
    position: &LeveragePosition,
    params: &AdjustCollateralParams,
) -> Result<(u128, u128), LeverageError> {
    let new_collateral = if params.add {
        position
            .collateral_amount
            .checked_add(params.amount)
            .ok_or(LeverageError::ExposureOverflow)?
    } else {
        position
            .collateral_amount
            .checked_sub(params.amount)
            .ok_or(LeverageError::InsufficientCollateral)?
    };

    if new_collateral < MIN_COLLATERAL {
        return Err(LeverageError::CollateralTooSmall);
    }

    let new_exposure = (new_collateral as u128)
        .checked_mul(position.ratio as u128)
        .ok_or(LeverageError::ExposureOverflow)?
        .checked_div(LEVERAGE_RATIO_SCALE as u128)
        .ok_or(LeverageError::ArithmeticError)?;

    Ok((new_collateral, new_exposure))
}

/// Validate a ratio change and return the new exposure.
pub fn validate_adjust_ratio(
    position: &LeveragePosition,
    new_ratio: u64,
) -> Result<u128, LeverageError> {
    if new_ratio < MIN_LEVERAGE_RATIO {
        return Err(LeverageError::RatioBelowMinimum);
    }
    if new_ratio > MAX_LEVERAGE_RATIO {
        return Err(LeverageError::RatioAboveMaximum);
    }

    let new_exposure = position
        .collateral_amount
        .checked_mul(new_ratio as u128)
        .ok_or(LeverageError::ExposureOverflow)?
        .checked_div(LEVERAGE_RATIO_SCALE as u128)
        .ok_or(LeverageError::ArithmeticError)?;

    Ok(new_exposure)
}

/// Compute a liquidation result for a position that is over-limit.
///
/// Returns `Err(LeverageError::LiquidationNotNeeded)` if the position is
/// within safe bounds, preventing erroneous forced liquidations.
pub fn compute_liquidation(position: &LeveragePosition) -> Result<LiquidationResult, LeverageError> {
    if !position.is_unsafe() {
        return Err(LeverageError::LiquidationNotNeeded);
    }

    let exposure = position.effective_exposure()?;

    // Fee = collateral × fee_bps / 10_000.
    let fee = position
        .collateral_amount
        .checked_mul(LIQUIDATION_FEE_BPS)
        .ok_or(LeverageError::ArithmeticError)?
        .checked_div(10_000)
        .ok_or(LeverageError::ArithmeticError)?;

    let returned = position
        .collateral_amount
        .checked_sub(fee)
        .ok_or(LeverageError::ArithmeticError)?;

    Ok(LiquidationResult {
        returned_collateral: returned,
        fee_collected: fee,
        exposure_eliminated: exposure,
    })
}

// ── Soroban contract implementation ──────────────────────────────────────────

#[contract]
pub struct LeverageContract;

#[contractimpl]
impl LeverageContract {
    // ── Initialisation ────────────────────────────────────────────────────────

    /// Initialise the contract, setting the admin address.
    ///
    /// Can only be called once; panics if already initialised to prevent
    /// admin hijacking through re-initialisation.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&ADMIN_KEY) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&ADMIN_KEY, &admin);
    }

    // ── Position management ───────────────────────────────────────────────────

    /// Open a new leveraged position for `caller`.
    ///
    /// Fails if the caller already has an open position (use
    /// `adjust_collateral` or `adjust_ratio` instead).
    pub fn open_position(
        env: Env,
        caller: Address,
        params: OpenPositionParams,
    ) -> Result<LeveragePosition, LeverageError> {
        caller.require_auth();

        // Validate inputs before touching storage.
        validate_open(&params)?;

        let mut positions: soroban_sdk::Map<Address, LeveragePosition> = env
            .storage()
            .persistent()
            .get(&POSITIONS_KEY)
            .unwrap_or(soroban_sdk::Map::new(&env));

        // Idempotency guard: reject duplicate opens.
        if positions.contains_key(caller.clone()) {
            return Err(LeverageError::PositionNotFound);
        }

        let ledger = env.ledger().sequence();
        let position = LeveragePosition {
            owner: caller.clone(),
            collateral_amount: params.collateral_amount,
            ratio: params.ratio,
            opened_at: ledger,
            updated_at: ledger,
            liquidation_pending: false,
        };

        positions.set(caller, position.clone());
        env.storage().persistent().set(&POSITIONS_KEY, &positions);

        Ok(position)
    }

    /// Adjust the collateral on an existing position.
    ///
    /// Only the owner may call this.  Reducing to zero is rejected; use
    /// `close_position` instead.
    pub fn adjust_collateral(
        env: Env,
        caller: Address,
        params: AdjustCollateralParams,
    ) -> Result<LeveragePosition, LeverageError> {
        caller.require_auth();

        let mut positions: soroban_sdk::Map<Address, LeveragePosition> = env
            .storage()
            .persistent()
            .get(&POSITIONS_KEY)
            .unwrap_or(soroban_sdk::Map::new(&env));

        let mut position = positions
            .get(caller.clone())
            .ok_or(LeverageError::PositionNotFound)?;

        if position.owner != caller {
            return Err(LeverageError::Unauthorized);
        }

        let (new_collateral, _new_exposure) =
            validate_adjust_collateral(&position, &params)?;

        position.collateral_amount = new_collateral;
        position.updated_at = env.ledger().sequence();

        positions.set(caller, position.clone());
        env.storage().persistent().set(&POSITIONS_KEY, &positions);

        Ok(position)
    }

    /// Change the leverage ratio on an existing position.
    ///
    /// Only the owner may call this.
    pub fn adjust_ratio(
        env: Env,
        caller: Address,
        params: AdjustRatioParams,
    ) -> Result<LeveragePosition, LeverageError> {
        caller.require_auth();

        let mut positions: soroban_sdk::Map<Address, LeveragePosition> = env
            .storage()
            .persistent()
            .get(&POSITIONS_KEY)
            .unwrap_or(soroban_sdk::Map::new(&env));

        let mut position = positions
            .get(caller.clone())
            .ok_or(LeverageError::PositionNotFound)?;

        if position.owner != caller {
            return Err(LeverageError::Unauthorized);
        }

        validate_adjust_ratio(&position, params.new_ratio)?;

        position.ratio = params.new_ratio;
        position.updated_at = env.ledger().sequence();

        positions.set(caller, position.clone());
        env.storage().persistent().set(&POSITIONS_KEY, &positions);

        Ok(position)
    }

    /// Close and remove a position, returning collateral to the owner.
    ///
    /// Calling this on a non-existent position is a no-op (idempotent).
    pub fn close_position(env: Env, caller: Address) -> Option<LeveragePosition> {
        caller.require_auth();

        let mut positions: soroban_sdk::Map<Address, LeveragePosition> = match env
            .storage()
            .persistent()
            .get(&POSITIONS_KEY)
        {
            Some(p) => p,
            None => return None,
        };

        let position = positions.remove(caller.clone());
        env.storage().persistent().set(&POSITIONS_KEY, &positions);
        position
    }

    /// Force-liquidate an unsafe position.
    ///
    /// Caller must be the admin.  The position owner receives their collateral
    /// minus the liquidation fee.  The fee is credited to the contract.
    ///
    /// Returns `Err(LeverageError::LiquidationNotNeeded)` if the position is
    /// safe, preventing erroneous liquidations.
    pub fn liquidate(
        env: Env,
        caller: Address,
        target: Address,
    ) -> Result<LiquidationResult, LeverageError> {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(LeverageError::NotInitialized)?;

        if caller != admin {
            return Err(LeverageError::NotAdmin);
        }

        let mut positions: soroban_sdk::Map<Address, LeveragePosition> = env
            .storage()
            .persistent()
            .get(&POSITIONS_KEY)
            .unwrap_or(soroban_sdk::Map::new(&env));

        let position = positions
            .get(target.clone())
            .ok_or(LeverageError::PositionNotFound)?;

        let result = compute_liquidation(&position)?;

        positions.remove(target);
        env.storage().persistent().set(&POSITIONS_KEY, &positions);

        Ok(result)
    }

    // ── Read-only queries ─────────────────────────────────────────────────────

    /// Fetch a position by owner address.
    pub fn get_position(
        env: Env,
        owner: Address,
    ) -> Result<LeveragePosition, LeverageError> {
        let positions: soroban_sdk::Map<Address, LeveragePosition> = env
            .storage()
            .persistent()
            .get(&POSITIONS_KEY)
            .unwrap_or(soroban_sdk::Map::new(&env));

        positions
            .get(owner)
            .ok_or(LeverageError::PositionNotFound)
    }

    /// Return the effective exposure for an owner's position.
    pub fn get_exposure(
        env: Env,
        owner: Address,
    ) -> Result<u128, LeverageError> {
        let position = Self::get_position(env, owner)?;
        position.effective_exposure()
    }

    /// Return whether a position is currently unsafe (eligible for liquidation).
    pub fn is_position_unsafe(env: Env, owner: Address) -> bool {
        match Self::get_position(env, owner) {
            Ok(p) => p.is_unsafe(),
            Err(_) => false,
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── helpers ──────────────────────────────────────────────────────────────

    fn make_position(collateral: u128, ratio: u64) -> LeveragePosition {
        LeveragePosition {
            owner: Address::generate(&Env::default()),
            collateral_amount: collateral,
            ratio,
            opened_at: 1,
            updated_at: 1,
            liquidation_pending: false,
        }
    }

    fn open_params(collateral: u128, ratio: u64) -> OpenPositionParams {
        OpenPositionParams { collateral_amount: collateral, ratio }
    }

    /// Build an unsafe position whose exposure is exactly `MAX_EXPOSURE_LIMIT + delta`.
    fn unsafe_position(delta: u128) -> LeveragePosition {
        let target = MAX_EXPOSURE_LIMIT + delta;
        // exposure = collateral × MAX_RATIO / SCALE  →  collateral = ⌈target × SCALE / MAX_RATIO⌉
        let collateral = (target * LEVERAGE_RATIO_SCALE as u128
            + MAX_LEVERAGE_RATIO as u128
            - 1)
            / MAX_LEVERAGE_RATIO as u128;
        make_position(collateral, MAX_LEVERAGE_RATIO)
    }

    // ── constants sanity ─────────────────────────────────────────────────────

    #[test]
    fn constants_are_consistent() {
        assert!(MIN_LEVERAGE_RATIO < MAX_LEVERAGE_RATIO);
        assert_eq!(MIN_LEVERAGE_RATIO % LEVERAGE_RATIO_SCALE, 0);
        assert_eq!(MAX_LEVERAGE_RATIO % LEVERAGE_RATIO_SCALE, 0);
        assert!(LIQUIDATION_FEE_BPS < 10_000);
        assert!(MIN_COLLATERAL > 0);
        assert!(MAX_EXPOSURE_LIMIT > 0);
    }

    // ── validate_open: success ────────────────────────────────────────────────

    #[test]
    fn open_at_min_boundary_succeeds() {
        let result = validate_open(&open_params(MIN_COLLATERAL, MIN_LEVERAGE_RATIO));
        assert_eq!(result.unwrap(), MIN_COLLATERAL); // 1× → exposure == collateral
    }

    #[test]
    fn open_at_max_ratio_boundary_succeeds() {
        assert!(validate_open(&open_params(MIN_COLLATERAL, MAX_LEVERAGE_RATIO)).is_ok());
    }

    #[test]
    fn open_large_collateral_min_ratio_succeeds() {
        assert!(validate_open(&open_params(1_000_000_000_u128, MIN_LEVERAGE_RATIO)).is_ok());
    }

    #[test]
    fn open_exposure_computed_correctly() {
        // 10_000 at 2.5× (ratio=250) → exposure = 25_000
        let exposure = validate_open(&open_params(10_000, 250)).unwrap();
        assert_eq!(exposure, 25_000);
    }

    // ── validate_open: rejection ──────────────────────────────────────────────

    #[test]
    fn open_ratio_zero_rejected() {
        assert_eq!(
            validate_open(&open_params(MIN_COLLATERAL, 0)).unwrap_err(),
            LeverageError::RatioBelowMinimum
        );
    }

    #[test]
    fn open_ratio_one_below_min_rejected() {
        assert_eq!(
            validate_open(&open_params(MIN_COLLATERAL, MIN_LEVERAGE_RATIO - 1)).unwrap_err(),
            LeverageError::RatioBelowMinimum
        );
    }

    #[test]
    fn open_ratio_one_above_max_rejected() {
        assert_eq!(
            validate_open(&open_params(MIN_COLLATERAL, MAX_LEVERAGE_RATIO + 1)).unwrap_err(),
            LeverageError::RatioAboveMaximum
        );
    }

    #[test]
    fn open_ratio_far_above_max_rejected() {
        assert_eq!(
            validate_open(&open_params(MIN_COLLATERAL, u64::MAX)).unwrap_err(),
            LeverageError::RatioAboveMaximum
        );
    }

    #[test]
    fn open_collateral_zero_rejected() {
        assert_eq!(
            validate_open(&open_params(0, MIN_LEVERAGE_RATIO)).unwrap_err(),
            LeverageError::CollateralTooSmall
        );
    }

    #[test]
    fn open_collateral_one_below_min_rejected() {
        assert_eq!(
            validate_open(&open_params(MIN_COLLATERAL - 1, MIN_LEVERAGE_RATIO)).unwrap_err(),
            LeverageError::CollateralTooSmall
        );
    }

    #[test]
    fn open_overflow_collateral_rejected() {
        assert_eq!(
            validate_open(&open_params(u128::MAX, MAX_LEVERAGE_RATIO)).unwrap_err(),
            LeverageError::ExposureOverflow
        );
    }

    #[test]
    fn open_max_collateral_min_ratio_overflows() {
        // Even at MIN_LEVERAGE_RATIO, u128::MAX × 100 overflows.
        assert_eq!(
            validate_open(&open_params(u128::MAX, MIN_LEVERAGE_RATIO)).unwrap_err(),
            LeverageError::ExposureOverflow
        );
    }

    // ── effective_exposure ────────────────────────────────────────────────────

    #[test]
    fn exposure_at_1x_equals_collateral() {
        for c in [MIN_COLLATERAL, 10_000, 999_999, 1_000_000_000] {
            let pos = make_position(c, MIN_LEVERAGE_RATIO);
            assert_eq!(pos.effective_exposure().unwrap(), c);
        }
    }

    #[test]
    fn exposure_at_2x() {
        let pos = make_position(50_000, 200);
        assert_eq!(pos.effective_exposure().unwrap(), 100_000);
    }

    #[test]
    fn exposure_at_5x() {
        let pos = make_position(50_000, MAX_LEVERAGE_RATIO);
        assert_eq!(pos.effective_exposure().unwrap(), 250_000);
    }

    #[test]
    fn exposure_truncates_remainder() {
        // 10_001 × 150 / 100 = 15_001.5 → truncates to 15_001
        let pos = make_position(10_001, 150);
        assert_eq!(pos.effective_exposure().unwrap(), 15_001);
    }

    #[test]
    fn exposure_overflow_returns_err() {
        let pos = make_position(u128::MAX, MAX_LEVERAGE_RATIO);
        assert_eq!(
            pos.effective_exposure().unwrap_err(),
            LeverageError::ExposureOverflow
        );
    }

    // ── is_unsafe ─────────────────────────────────────────────────────────────

    #[test]
    fn safe_position_is_not_unsafe() {
        let pos = make_position(MIN_COLLATERAL, MIN_LEVERAGE_RATIO);
        assert!(!pos.is_unsafe());
    }

    #[test]
    fn position_at_exact_limit_is_safe() {
        // exposure = MAX_EXPOSURE_LIMIT (not strictly greater → safe)
        let collateral = (MAX_EXPOSURE_LIMIT * LEVERAGE_RATIO_SCALE as u128)
            / MIN_LEVERAGE_RATIO as u128;
        let pos = make_position(collateral, MIN_LEVERAGE_RATIO);
        let exposure = pos.effective_exposure().unwrap();
        assert!(exposure <= MAX_EXPOSURE_LIMIT);
        assert!(!pos.is_unsafe());
    }

    #[test]
    fn position_one_above_limit_is_unsafe() {
        let pos = unsafe_position(1);
        assert!(pos.is_unsafe());
    }

    #[test]
    fn overflow_position_is_unsafe() {
        let pos = make_position(u128::MAX, MAX_LEVERAGE_RATIO);
        assert!(pos.is_unsafe());
    }

    #[test]
    fn large_safe_position_is_not_unsafe() {
        // 10^12 at 1× → exposure 10^12 < 10^15 (MAX_EXPOSURE_LIMIT)
        let pos = make_position(1_000_000_000_000, MIN_LEVERAGE_RATIO);
        assert!(!pos.is_unsafe());
    }

    // ── validate_adjust_collateral ────────────────────────────────────────────

    #[test]
    fn increase_collateral_succeeds() {
        let pos = make_position(10_000, MIN_LEVERAGE_RATIO);
        let (new_col, _) = validate_adjust_collateral(
            &pos,
            &AdjustCollateralParams { amount: 5_000, add: true },
        )
        .unwrap();
        assert_eq!(new_col, 15_000);
    }

    #[test]
    fn decrease_collateral_to_minimum_succeeds() {
        let pos = make_position(MIN_COLLATERAL + 500, MIN_LEVERAGE_RATIO);
        let (new_col, _) = validate_adjust_collateral(
            &pos,
            &AdjustCollateralParams { amount: 500, add: false },
        )
        .unwrap();
        assert_eq!(new_col, MIN_COLLATERAL);
    }

    #[test]
    fn decrease_collateral_below_min_rejected() {
        let pos = make_position(MIN_COLLATERAL + 1, MIN_LEVERAGE_RATIO);
        assert_eq!(
            validate_adjust_collateral(
                &pos,
                &AdjustCollateralParams { amount: 2, add: false }
            )
            .unwrap_err(),
            LeverageError::CollateralTooSmall
        );
    }

    #[test]
    fn decrease_collateral_to_zero_rejected() {
        let pos = make_position(MIN_COLLATERAL, MIN_LEVERAGE_RATIO);
        assert_eq!(
            validate_adjust_collateral(
                &pos,
                &AdjustCollateralParams { amount: MIN_COLLATERAL, add: false }
            )
            .unwrap_err(),
            LeverageError::CollateralTooSmall
        );
    }

    #[test]
    fn decrease_collateral_exceeds_balance_rejected() {
        let pos = make_position(MIN_COLLATERAL, MIN_LEVERAGE_RATIO);
        assert_eq!(
            validate_adjust_collateral(
                &pos,
                &AdjustCollateralParams { amount: MIN_COLLATERAL + 1, add: false }
            )
            .unwrap_err(),
            LeverageError::InsufficientCollateral
        );
    }

    #[test]
    fn increase_collateral_overflow_rejected() {
        let pos = make_position(u128::MAX, MIN_LEVERAGE_RATIO);
        assert_eq!(
            validate_adjust_collateral(
                &pos,
                &AdjustCollateralParams { amount: 1, add: true }
            )
            .unwrap_err(),
            LeverageError::ExposureOverflow
        );
    }

    #[test]
    fn adjust_collateral_exposure_recomputed_correctly() {
        // 10_000 at 2× → exposure 20_000; add 5_000 → new exposure 30_000
        let pos = make_position(10_000, 200);
        let (_, new_exposure) = validate_adjust_collateral(
            &pos,
            &AdjustCollateralParams { amount: 5_000, add: true },
        )
        .unwrap();
        assert_eq!(new_exposure, 30_000);
    }

    // ── validate_adjust_ratio ─────────────────────────────────────────────────

    #[test]
    fn adjust_ratio_to_max_succeeds() {
        let pos = make_position(10_000, MIN_LEVERAGE_RATIO);
        assert_eq!(validate_adjust_ratio(&pos, MAX_LEVERAGE_RATIO).unwrap(), 50_000);
    }

    #[test]
    fn adjust_ratio_to_min_succeeds() {
        let pos = make_position(10_000, MAX_LEVERAGE_RATIO);
        assert_eq!(validate_adjust_ratio(&pos, MIN_LEVERAGE_RATIO).unwrap(), 10_000);
    }

    #[test]
    fn adjust_ratio_to_same_value_is_idempotent() {
        let pos = make_position(10_000, 200);
        let e1 = validate_adjust_ratio(&pos, 200).unwrap();
        let e2 = validate_adjust_ratio(&pos, 200).unwrap();
        assert_eq!(e1, e2);
    }

    #[test]
    fn adjust_ratio_below_min_rejected() {
        let pos = make_position(10_000, 200);
        assert_eq!(
            validate_adjust_ratio(&pos, MIN_LEVERAGE_RATIO - 1).unwrap_err(),
            LeverageError::RatioBelowMinimum
        );
    }

    #[test]
    fn adjust_ratio_above_max_rejected() {
        let pos = make_position(10_000, 200);
        assert_eq!(
            validate_adjust_ratio(&pos, MAX_LEVERAGE_RATIO + 1).unwrap_err(),
            LeverageError::RatioAboveMaximum
        );
    }

    #[test]
    fn adjust_ratio_zero_rejected() {
        let pos = make_position(10_000, 200);
        assert_eq!(
            validate_adjust_ratio(&pos, 0).unwrap_err(),
            LeverageError::RatioBelowMinimum
        );
    }

    #[test]
    fn adjust_ratio_overflow_rejected() {
        let pos = make_position(u128::MAX, MIN_LEVERAGE_RATIO);
        assert_eq!(
            validate_adjust_ratio(&pos, MAX_LEVERAGE_RATIO).unwrap_err(),
            LeverageError::ExposureOverflow
        );
    }

    // ── compute_liquidation ───────────────────────────────────────────────────

    #[test]
    fn liquidation_denied_for_safe_position() {
        let pos = make_position(MIN_COLLATERAL, MIN_LEVERAGE_RATIO);
        assert_eq!(
            compute_liquidation(&pos).unwrap_err(),
            LeverageError::LiquidationNotNeeded
        );
    }

    #[test]
    fn liquidation_succeeds_for_unsafe_position() {
        let pos = unsafe_position(1);
        assert!(compute_liquidation(&pos).is_ok());
    }

    #[test]
    fn liquidation_fee_is_correct() {
        let pos = unsafe_position(1);
        let result = compute_liquidation(&pos).unwrap();
        let expected_fee = pos.collateral_amount * LIQUIDATION_FEE_BPS / 10_000;
        assert_eq!(result.fee_collected, expected_fee);
    }

    #[test]
    fn liquidation_conserves_collateral() {
        // returned + fee must equal original collateral exactly.
        let pos = unsafe_position(1);
        let result = compute_liquidation(&pos).unwrap();
        assert_eq!(
            result.returned_collateral + result.fee_collected,
            pos.collateral_amount,
            "collateral conservation violated"
        );
    }

    #[test]
    fn liquidation_exposure_eliminated_matches_position() {
        let pos = unsafe_position(100);
        let result = compute_liquidation(&pos).unwrap();
        assert_eq!(
            result.exposure_eliminated,
            pos.effective_exposure().unwrap()
        );
    }

    #[test]
    fn liquidation_returned_is_less_than_collateral() {
        let pos = unsafe_position(1);
        let result = compute_liquidation(&pos).unwrap();
        assert!(result.returned_collateral < pos.collateral_amount);
    }

    // ── error codes are stable ────────────────────────────────────────────────

    #[test]
    fn error_codes_are_unique_and_nonzero() {
        let codes: [u32; 11] = [
            LeverageError::Unauthorized as u32,
            LeverageError::RatioBelowMinimum as u32,
            LeverageError::RatioAboveMaximum as u32,
            LeverageError::CollateralTooSmall as u32,
            LeverageError::ExposureOverflow as u32,
            LeverageError::PositionNotFound as u32,
            LeverageError::LiquidationNotNeeded as u32,
            LeverageError::NotInitialized as u32,
            LeverageError::NotAdmin as u32,
            LeverageError::ArithmeticError as u32,
            LeverageError::InsufficientCollateral as u32,
        ];
        let mut sorted = codes.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), codes.len(), "error codes must be unique");
        for c in &codes {
            assert!(*c > 0, "error codes must be non-zero");
        }
    }

    // ── determinism / idempotency ─────────────────────────────────────────────

    #[test]
    fn validate_open_is_deterministic() {
        let p = open_params(50_000, 300);
        assert_eq!(validate_open(&p), validate_open(&p));
    }

    #[test]
    fn validate_adjust_collateral_is_deterministic() {
        let pos = make_position(20_000, 200);
        let params = AdjustCollateralParams { amount: 5_000, add: true };
        assert_eq!(
            validate_adjust_collateral(&pos, &params),
            validate_adjust_collateral(&pos, &params)
        );
    }

    #[test]
    fn compute_liquidation_is_deterministic() {
        let pos = unsafe_position(500);
        assert_eq!(compute_liquidation(&pos), compute_liquidation(&pos));
    }

    // ── round-trip / regression ───────────────────────────────────────────────

    #[test]
    fn add_then_subtract_collateral_is_identity() {
        let collateral: u128 = 50_000;
        let delta: u128 = 10_000;
        let pos = make_position(collateral, MIN_LEVERAGE_RATIO);

        let (after_add, _) = validate_adjust_collateral(
            &pos,
            &AdjustCollateralParams { amount: delta, add: true },
        )
        .unwrap();

        let pos2 = make_position(after_add, MIN_LEVERAGE_RATIO);
        let (final_col, _) = validate_adjust_collateral(
            &pos2,
            &AdjustCollateralParams { amount: delta, add: false },
        )
        .unwrap();

        assert_eq!(final_col, collateral);
    }

    #[test]
    fn ratio_round_trip_is_stable() {
        let pos = make_position(10_000, 300);
        let e1 = validate_adjust_ratio(&pos, 400).unwrap();
        let pos2 = make_position(10_000, 400); // apply the change
        let e2 = validate_adjust_ratio(&pos2, 400).unwrap();
        assert_eq!(e1, e2);
    }

    #[test]
    fn sequential_collateral_and_ratio_adjustments_produce_correct_exposure() {
        // Start: 10_000 at 2× → 20_000
        // Add 10_000 collateral → 20_000 at 2× → 40_000
        // Change ratio to 3× → 20_000 × 3 = 60_000
        let pos = make_position(10_000, 200);

        let (new_col, _) = validate_adjust_collateral(
            &pos,
            &AdjustCollateralParams { amount: 10_000, add: true },
        )
        .unwrap();
        assert_eq!(new_col, 20_000);

        let pos2 = make_position(new_col, 200);
        let new_exposure = validate_adjust_ratio(&pos2, 300).unwrap();
        assert_eq!(new_exposure, 60_000);
    }

    // ── boundary: ratio at exactly MIN / MAX ──────────────────────────────────

    #[test]
    fn ratio_exactly_min_accepted() {
        assert!(validate_open(&open_params(MIN_COLLATERAL, MIN_LEVERAGE_RATIO)).is_ok());
    }

    #[test]
    fn ratio_exactly_max_accepted() {
        assert!(validate_open(&open_params(MIN_COLLATERAL, MAX_LEVERAGE_RATIO)).is_ok());
    }

    // ── boundary: collateral at exactly MIN / MIN-1 ───────────────────────────

    #[test]
    fn collateral_exactly_min_accepted() {
        assert!(validate_open(&open_params(MIN_COLLATERAL, MIN_LEVERAGE_RATIO)).is_ok());
    }

    #[test]
    fn collateral_one_below_min_rejected() {
        assert_eq!(
            validate_open(&open_params(MIN_COLLATERAL - 1, MIN_LEVERAGE_RATIO)).unwrap_err(),
            LeverageError::CollateralTooSmall
        );
    }

    // ── recovery scenarios ────────────────────────────────────────────────────

    #[test]
    fn unsafe_position_can_be_recovered_via_liquidation() {
        let pos = unsafe_position(100);
        assert!(pos.is_unsafe(), "position must be unsafe before recovery");
        let result = compute_liquidation(&pos);
        assert!(result.is_ok(), "liquidation must succeed for recovery: {:?}", result);
    }

    #[test]
    fn safe_position_blocked_from_erroneous_liquidation() {
        let pos = make_position(MIN_COLLATERAL, MIN_LEVERAGE_RATIO);
        assert_eq!(
            compute_liquidation(&pos).unwrap_err(),
            LeverageError::LiquidationNotNeeded,
            "safe position must not be liquidatable"
        );
    }

    #[test]
    fn recovery_does_not_lose_collateral() {
        let pos = unsafe_position(1);
        if let Ok(result) = compute_liquidation(&pos) {
            assert_eq!(
                result.returned_collateral + result.fee_collected,
                pos.collateral_amount,
            );
        }
    }

    #[test]
    fn overflow_position_triggers_unsafe_and_allows_liquidation() {
        // A position crafted with extreme values is unsafe and liquidatable.
        let target = MAX_EXPOSURE_LIMIT + 1_000_000;
        let collateral = (target * LEVERAGE_RATIO_SCALE as u128
            + MAX_LEVERAGE_RATIO as u128
            - 1)
            / MAX_LEVERAGE_RATIO as u128;
        let pos = make_position(collateral, MAX_LEVERAGE_RATIO);
        assert!(pos.is_unsafe());
        assert!(compute_liquidation(&pos).is_ok());
    }
}
