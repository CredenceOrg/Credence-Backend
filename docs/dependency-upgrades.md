# Dependency Upgrade Policy

This document outlines the policy for dependency upgrades within the Credence Backend, ensuring that we stay up-to-date while mitigating the risk of introducing instability or vulnerabilities.

## How Aggressively We Upgrade Dependencies

We balance the need for security patches and new features against the stability risks of constantly upgrading core libraries. Our general approach is:

1. **Security Patches (Patch/Minor versions)**: 
   - We aggressively upgrade dependencies when critical or high vulnerabilities are disclosed.
   - Patch and minor upgrades (e.g., `1.2.3` to `1.2.4` or `1.3.0`) are merged as quickly as possible provided CI passes, as they generally maintain backward compatibility.
   - Automated tools (e.g. Dependabot, Renovate) open these PRs automatically.

2. **Major Version Upgrades**:
   - We do not aggressively adopt new major versions of core dependencies (like Express, PostgreSQL clients, Redis clients). 
   - Major upgrades are evaluated carefully, requiring a migration plan, extensive testing on a staging environment, and verification against the `test:chaos` suite.

3. **Development Dependencies**:
   - Tooling dependencies (TypeScript, ESLint, Vitest) can be upgraded more freely since they don't affect the production runtime.

## Who Reviews

All dependency upgrades require review, even if automated tests pass.

- **Routine Patches / Minor Upgrades**: Any backend contributor can review and approve a patch or minor upgrade PR. Reviewers must ensure the changelog does not contain unexpected breaking changes disguised as minor bumps.
- **Major Upgrades**: Must be reviewed by at least one `CODEOWNERS` maintainer.
- **Security Hotfixes**: Reviewed and expedited by a maintainer or security champion on duty.

## Testing Before Upgrading

Before approving any upgrade PR, ensure:
- The standard test suite (`npm test`) passes.
- `npm run security:scan` and `npm run sbom:check` complete successfully.
- For core infrastructure libraries (e.g. `pg`, `ioredis`), `npm run test:chaos` must be green.
