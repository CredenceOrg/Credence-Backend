//! `credence_bond` — Credence economic-trust bond contract.
//!
//! Entry points are exposed via the Soroban SDK `#[contract]` / `#[contractimpl]`
//! macros inside each sub-module.

#![no_std]

pub mod leverage;

pub use leverage::{
    AdjustCollateralParams, AdjustRatioParams, LeverageContract, LeverageContractClient,
    LeverageError, LeveragePosition, LiquidationResult, OpenPositionParams,
    // constants
    LEVERAGE_RATIO_SCALE, LIQUIDATION_FEE_BPS, MAX_EXPOSURE_LIMIT, MAX_LEVERAGE_RATIO,
    MIN_COLLATERAL, MIN_LEVERAGE_RATIO,
};
