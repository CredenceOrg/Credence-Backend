#!/usr/bin/env bash
#
# check-fixme.sh
#
# Fails (exit 1) if any FIXME comment in the diff/tree does not carry a
# GitHub issue reference (e.g. "FIXME(#123)", "FIXME #123", "FIXME: see #123").
#
# Usage:
#   scripts/check-fixme.sh                # scan whole repo (tracked files)
#   scripts/check-fixme.sh --diff <base>   # scan only lines added vs <base>
#
# Env vars:
#   FIXME_CHECK_PATTERN   Override the "FIXME" keyword pattern (default: FIXME)
#   FIXME_CHECK_PATHSPEC  Extra pathspec exclusions, space-separated, passed
#                         through to git ls-files as ':!pattern' entries.

set -euo pipefail

FIXME_KEYWORD="${FIXME_CHECK_PATTERN:-FIXME}"

# A "valid" FIXME has an issue reference within the same comment:
#   FIXME(#123)
#   FIXME #123
#   FIXME: blah blah #123
#   FIXME - see https://github.com/org/repo/issues/123
ISSUE_REF_REGEX='#[0-9]+|issues/[0-9]+'

# Files/dirs we never want to scan.
DEFAULT_EXCLUDES=(
  ':!vendor/*'
  ':!node_modules/*'
  ':!dist/*'
  ':!build/*'
  ':!*.lock'
  ':!*.min.js'
  ':!scripts/check-fixme.sh'
  ':!README.md'
  ':!docs/fixme-convention.md'
)

mode="tree"
base_ref=""

if [[ "${1:-}" == "--diff" ]]; then
  mode="diff"
  base_ref="${2:?--diff requires a base ref, e.g. origin/main}"
fi

violations=0
tmp_report="$(mktemp)"
trap 'rm -f "$tmp_report"' EXIT

report_line() {
  # $1 = file, $2 = line number, $3 = line content
  echo "  $1:$2: $3" >>"$tmp_report"
  violations=$((violations + 1))
}

scan_file_tree() {
  local extra_excludes=()
  if [[ -n "${FIXME_CHECK_PATHSPEC:-}" ]]; then
    for p in $FIXME_CHECK_PATHSPEC; do
      extra_excludes+=(":!$p")
    done
  fi

  git ls-files -z -- . "${DEFAULT_EXCLUDES[@]}" "${extra_excludes[@]}" |
  while IFS= read -r -d '' file; do
    # Skip binary files quickly.
    if ! grep -Iq . "$file" 2>/dev/null; then
      continue
    fi
    (grep -nE "$FIXME_KEYWORD" "$file" 2>/dev/null || true) | while IFS=: read -r lineno content; do
      if ! grep -qE "$ISSUE_REF_REGEX" <<<"$content"; then
        report_line "$file" "$lineno" "$(sed -e 's/^[[:space:]]*//' <<<"$content")"
      fi
    done
  done
}

scan_diff() {
  # Only look at lines *added* by this branch vs base_ref, so pre-existing
  # FIXMEs elsewhere in the repo don't block unrelated PRs.
  git diff --unified=0 "${base_ref}...HEAD" -- . "${DEFAULT_EXCLUDES[@]}" |
  awk '
    /^\+\+\+ / { file=$0; sub(/^\+\+\+ [ab]\//, "", file); next }
    /^@@/ { match($0, /\+[0-9]+/); lineno = substr($0, RSTART+1, RLENGTH-1) + 0; next }
    /^\+/ && !/^\+\+\+/ {
      print file ":" lineno ":" substr($0, 2)
      lineno++
    }
  ' |
  while IFS=: read -r file lineno content; do
    if grep -qE "$FIXME_KEYWORD" <<<"$content" && ! grep -qE "$ISSUE_REF_REGEX" <<<"$content"; then
      report_line "$file" "$lineno" "$(sed -e 's/^[[:space:]]*//' <<<"$content")"
    fi
  done
}

if [[ "$mode" == "diff" ]]; then
  scan_diff
else
  scan_file_tree
fi

if [[ -s "$tmp_report" ]]; then
  echo "FIXME check failed: found FIXME comment(s) without an issue reference."
  echo "Every FIXME must reference a tracked issue, e.g.:"
  echo "  // FIXME(#123): remove this once the retry queue ships"
  echo
  cat "$tmp_report"
  echo
  echo "Fix by either:"
  echo "  1. Adding a reference: FIXME(#<issue-number>)"
  echo "  2. Filing the follow-up issue and linking it"
  echo "  3. Resolving the FIXME instead of leaving it"
  exit 1
fi

echo "FIXME check passed: no unreferenced FIXME comments found."
exit 0
