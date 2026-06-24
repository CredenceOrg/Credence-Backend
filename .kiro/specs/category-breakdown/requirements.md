# Requirements Document

## Introduction

The `get_category_breakdown` feature adds a lightweight, read-only entrypoint to the QuickLendX Soroban smart contract that returns a per-category invoice-count breakdown. The primary consumer is a dashboard pie chart that needs to know "what kinds of invoices are on the platform?" without bearing the cost of computing a full `FinancialMetrics` bundle.

The feature introduces a new `CategoryBreakdown` contract type and a `get_category_breakdown(env)` function in `lib.rs`. It reuses the existing `invoices_by_category` storage index and `get_all_categories` helper already present in `storage.rs`, so no new storage keys or rescans of the primary invoice map are required.

The contract targets Soroban SDK 25.1.1.

---

## Glossary

- **Contract**: The QuickLendX Soroban smart contract deployed on Stellar.
- **InvoiceCategory**: An enum defined in the contract representing a fixed set of invoice types: `Services`, `Products`, `Consulting`, `Manufacturing`, `Technology`, `Healthcare`, `Other` (7 variants total).
- **CategoryBreakdown**: A new `#[contracttype]`-annotated struct that holds a `Vec<CategoryEntry>` with exactly one entry per `InvoiceCategory` variant (7 entries total).
- **CategoryEntry**: A `#[contracttype]`-annotated struct with fields `category: InvoiceCategory` and `count: u32`, representing one category and its invoice count.
- **invoices_by_category index**: The existing Soroban storage map keyed by `InvoiceCategory` that maps each category to a collection of invoice identifiers, maintained in `storage.rs`.
- **primary invoice storage map**: The primary Soroban storage map keyed by invoice ID that stores the full `Invoice` struct for each invoice (the map that `get_category_breakdown` must NOT iterate).
- **get_all_categories**: The existing helper in `storage.rs` that returns the full list of known `InvoiceCategory` variants.
- **FinancialMetrics**: The existing aggregate type computed by `analytics.rs` that includes category volumes among many other fields.
- **Zero-count policy**: The include-zeros policy adopted by this feature: every `InvoiceCategory` variant always appears in `CategoryBreakdown`, with `count = 0` when no invoices exist for that category.
- **Omission policy**: Not used by this feature; retained for reference. Under an omission policy, categories with zero invoices would be absent from the result.
- **Cancelled invoices**: Invoices whose status is `Cancelled`. This feature **includes** cancelled invoices in category counts; a cancelled invoice that was created under a given category still contributes 1 to that category's count.
- **get_invoice_count_by_status**: The existing counting pattern in the contract used as the model for counting entries in the `invoices_by_category` index without scanning the primary invoice map.

---

## Requirements

### Requirement 1: CategoryBreakdown Contract Type

**User Story:** As a contract consumer, I want a well-typed return value for the category breakdown entrypoint, so that I can deserialize the result predictably in client SDKs.

#### Acceptance Criteria

1. THE Contract SHALL define a `CategoryBreakdown` type annotated with `#[contracttype]` that holds a `Vec<CategoryEntry>` with exactly 7 entries — one per `InvoiceCategory` variant — where each `CategoryEntry` contains exactly one `InvoiceCategory` and one `u32` count.
2. THE Contract SHALL define `CategoryEntry` as a `#[contracttype]`-annotated struct with fields `category: InvoiceCategory` and `count: u32`.
3. THE Contract SHALL place the `CategoryBreakdown` and `CategoryEntry` type definitions in a module that is compiled into the contract binary and accessible from `lib.rs`.
4. THE Contract SHALL document, via a doc comment on `CategoryBreakdown`, that the returned `Vec` always includes one entry per `InvoiceCategory` variant in the order of variants returned by `get_all_categories`, with `count = 0` for categories that have no invoices (include-zeros policy).
5. THE Contract SHALL document, via a doc comment on `CategoryBreakdown`, that cancelled invoices (status `Cancelled`) **are counted** in the `count` field: a cancelled invoice contributes 1 to its category's count.

---

### Requirement 2: get_category_breakdown Entrypoint

**User Story:** As a dashboard client, I want a single read-only contract call that returns invoice counts per category, so that I can render a pie chart without invoking the full FinancialMetrics computation.

#### Acceptance Criteria

1. THE Contract SHALL expose a public function `get_category_breakdown(env: Env) -> CategoryBreakdown` in `lib.rs` as a Soroban contract entrypoint.
2. WHEN `get_category_breakdown` is invoked, THE Contract SHALL return a `CategoryBreakdown` whose `Vec<CategoryEntry>` contains exactly one entry per `InvoiceCategory` variant (7 entries), listed in the same order as the variants returned by `get_all_categories`.
3. WHEN `get_category_breakdown` is invoked, THE Contract SHALL produce each `CategoryEntry`'s count by reading the `invoices_by_category` index (or an equivalent secondary index) without accessing the primary invoice storage map.
4. THE `get_category_breakdown` function SHALL be free of state mutations and SHALL NOT require any authentication or caller identity check.
5. THE `get_category_breakdown` function's doc comment SHALL state: (a) the function is read-only and requires no authentication; (b) the result always contains exactly 7 entries, one per `InvoiceCategory` variant; (c) entries appear in the order returned by `get_all_categories`; and (d) cancelled invoices are included in counts.

---

### Requirement 3: Zero-Count Policy

**User Story:** As a dashboard client, I want a clear and consistent rule about zero-count categories, so that I can write deterministic rendering logic without defensive special cases.

#### Acceptance Criteria

1. THE Contract SHALL implement the include-zeros policy: the returned `CategoryBreakdown` SHALL contain exactly 7 `CategoryEntry` values — one per `InvoiceCategory` variant — with `count = 0` for categories that have no invoices, and no duplicate `category` keys.
2. THE Contract SHALL document the include-zeros policy in the `CategoryBreakdown` doc comment so that callers know the result always contains exactly one entry per `InvoiceCategory` variant.
3. THE Contract SHALL produce no duplicate `category` keys in the returned `CategoryBreakdown`; each of the 7 `InvoiceCategory` variants SHALL appear exactly once.
4. THE order of entries in the returned `CategoryBreakdown` SHALL follow the order of variants returned by `get_all_categories`, giving callers a deterministic traversal guarantee.

---

### Requirement 4: No Primary-Map Rescan

**User Story:** As a platform operator, I want the category breakdown to be computed without scanning the full invoice storage map, so that ledger resource consumption remains bounded and predictable as invoice volume grows.

#### Acceptance Criteria

1. THE `get_category_breakdown` implementation SHALL derive each category's count without accessing the primary invoice storage map (the Soroban storage map keyed by invoice ID that holds the full `Invoice` struct); any secondary data source such as the `invoices_by_category` index is acceptable.
2. THE Contract SHALL NOT read from or iterate over the primary invoice storage map — including indirectly via helpers that themselves iterate it — inside `get_category_breakdown`.
3. THE `get_category_breakdown` function doc comment SHALL explicitly state that counts are derived from the `invoices_by_category` index without scanning the primary invoice storage map, and that the result contains exactly one entry per `InvoiceCategory` variant (7 entries).

---

### Requirement 5: Test Coverage

**User Story:** As a contributor, I want comprehensive tests for `get_category_breakdown`, so that edge cases and regressions are caught before deployment.

#### Acceptance Criteria

1. THE test suite SHALL include a test that invokes `get_category_breakdown` on an environment with zero invoices and verifies: (a) the result contains exactly 7 entries; (b) every `InvoiceCategory` variant appears exactly once; and (c) every entry has `count = 0`.
2. THE test suite SHALL include a test that invokes `get_category_breakdown` after all invoices have been added under a single category and verifies: (a) that category's `count` equals the total number of invoices added; and (b) all other 6 categories have `count = 0`.
3. THE test suite SHALL include a test that invokes `get_category_breakdown` with invoices spread across multiple categories and verifies that the sum of all `count` values equals the total number of invoices added (cancelled invoices included, per the documented cancelled-invoice policy).
4. THE test suite SHALL include a test that adds invoices with `Cancelled` status and verifies that each cancelled invoice contributes 1 to its category's `count`, confirming the include-cancelled policy documented in `CategoryBreakdown`.
5. THE test suite SHALL achieve at least 95% line and branch coverage of all new code introduced by this feature, as measured by `cargo tarpaulin`.
6. WHEN `cargo test` is executed against the contract crate, THE Contract SHALL produce zero test failures.
7. WHEN `cargo clippy` is executed against the contract crate, THE Contract SHALL produce zero warnings in source files introduced by this feature.

---

### Requirement 6: Documentation and Doc Comments

**User Story:** As a developer integrating QuickLendX, I want complete doc comments on all new public types and functions, so that I can understand the contract interface without reading the implementation.

#### Acceptance Criteria

1. THE `CategoryBreakdown` type SHALL have a doc comment that explicitly states: (a) its purpose as the return type of `get_category_breakdown`; (b) that it is a `Vec<CategoryEntry>` with exactly 7 entries; (c) the include-zeros policy (all 7 variants always present, `count = 0` when empty); and (d) that cancelled invoices are included in counts.
2. THE `CategoryEntry` type SHALL have a doc comment that explicitly states: (a) the `category` field holds the `InvoiceCategory` variant this entry describes; and (b) the `count` field holds the number of invoices in that category (including cancelled invoices).
3. THE `get_category_breakdown` function SHALL have a doc comment that explicitly states: (a) it is read-only and requires no authentication; (b) the result always contains exactly 7 entries, one per `InvoiceCategory` variant; (c) entries appear in the order returned by `get_all_categories`; and (d) counts are derived from the `invoices_by_category` index without scanning the primary invoice storage map.
4. THE Contract SHALL include updated or new documentation (README section or inline module-level doc) that lists `get_category_breakdown` as an available entrypoint with: its signature (`get_category_breakdown(env: Env) -> CategoryBreakdown`), its return type, its read-only / no-auth nature, and its cost characteristic (one storage read per `InvoiceCategory` variant, no primary-map scan).
