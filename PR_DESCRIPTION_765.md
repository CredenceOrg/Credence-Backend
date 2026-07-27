## Summary

- add deterministic regression coverage for sessions expiring exactly at the TTL boundary
- verify expired sessions are deleted across multiple batches without deleting live sessions
- verify a live-only dataset is left untouched and does not issue delete queries

## Testing

- `npx vitest run src/jobs/expiredSessionsSweeper.test.ts` (16 tests passed)
- `npx eslint --no-ignore src/jobs/expiredSessionsSweeper.test.ts`
- `npm run sbom:check`

## Repository-wide validation notes

- `npm test` was attempted but exceeded the 20-minute local execution limit
- `npm run lint` is currently blocked by pre-existing errors in unrelated files
- `npx tsc --noEmit` is currently blocked by pre-existing errors in unrelated files
- `npm run security:scan` reports existing dependency advisories

Closes #765
