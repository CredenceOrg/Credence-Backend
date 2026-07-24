# FIXME comment convention

To keep `FIXME` comments actionable instead of becoming permanent clutter,
every `FIXME` in this repo must reference a tracked GitHub issue.

## Required format

```
FIXME(#123): short description of what needs to happen
```

Any of these are accepted, as long as an issue number or issue URL appears
on the same line as the `FIXME`:

```js
// FIXME(#123): remove this once the retry queue ships
// FIXME #123 - remove this once the retry queue ships
// FIXME: see https://github.com/org/repo/issues/123
```

This is **not** accepted and will fail CI:

```js
// FIXME: this is gross but works for now
```

## Why

A `FIXME` with no reference has no owner and no way to track whether it's
still relevant. Requiring an issue link means:

- Anyone can find the context (why it's there, who's responsible).
- Stale FIXMEs show up in the linked issue tracker instead of rotting in code.
- Reviewers can tell at a glance whether a shortcut is tracked or accidental.

## How it's enforced

`scripts/check-fixme.sh` runs in CI on every pull request
(`.github/workflows/fixme-check.yml`). It only scans **lines added in the
PR**, so it won't block your PR because of a pre-existing, unreferenced
`FIXME` somewhere else in the codebase — only new ones you introduce.

## Running it locally

```bash
# Check the whole tree
./scripts/check-fixme.sh

# Check only what you've changed vs. the base branch (what CI does)
./scripts/check-fixme.sh --diff origin/main
```

If it fails, fix it one of three ways:

1. Add a reference: `FIXME(#<issue-number>)`.
2. File the follow-up issue now and link it.
3. Just resolve the FIXME instead of leaving it.

## Tests

`test/check-fixme.test.sh` covers the checker itself (referenced FIXMEs
pass, unreferenced ones fail, issue URLs count, diff mode ignores
pre-existing FIXMEs on the base branch, and the checker doesn't flag its
own source). Run it with:

```bash
./test/check-fixme.test.sh
```
