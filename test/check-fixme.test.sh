#!/usr/bin/env bash
#
# Lightweight test harness for scripts/check-fixme.sh.
# No external test framework required — just bash + git.
#
# Usage: ./test/check-fixme.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/check-fixme.sh"

pass_count=0
fail_count=0

assert_exit() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  ok   - $desc"
    pass_count=$((pass_count + 1))
  else
    echo "  FAIL - $desc (expected exit $expected, got $actual)"
    fail_count=$((fail_count + 1))
  fi
}

make_sandbox() {
  local dir
  dir="$(mktemp -d)"
  git -C "$dir" init -q
  git -C "$dir" config user.email test@test.com
  git -C "$dir" config user.name test
  mkdir -p "$dir/scripts"
  cp "$SCRIPT" "$dir/scripts/check-fixme.sh"
  echo "$dir"
}

echo "== check-fixme.sh test suite =="

# --- Test 1: FIXME with #123 ref passes ---
sandbox="$(make_sandbox)"
mkdir -p "$sandbox/src"
cat > "$sandbox/src/a.js" <<'EOF'
// FIXME(#123): remove after migration
EOF
git -C "$sandbox" add -A && git -C "$sandbox" commit -q -m "init"
set +e
(cd "$sandbox" && ./scripts/check-fixme.sh) >/dev/null 2>&1
code=$?
set -e
assert_exit "referenced FIXME passes" 0 "$code"
rm -rf "$sandbox"

# --- Test 2: bare FIXME fails ---
sandbox="$(make_sandbox)"
mkdir -p "$sandbox/src"
cat > "$sandbox/src/a.js" <<'EOF'
// FIXME: no ref here
EOF
git -C "$sandbox" add -A && git -C "$sandbox" commit -q -m "init"
set +e
(cd "$sandbox" && ./scripts/check-fixme.sh) >/dev/null 2>&1
code=$?
set -e
assert_exit "unreferenced FIXME fails" 1 "$code"
rm -rf "$sandbox"

# --- Test 3: issue URL counts as a valid reference ---
sandbox="$(make_sandbox)"
mkdir -p "$sandbox/src"
cat > "$sandbox/src/a.py" <<'EOF'
# FIXME - see https://github.com/org/repo/issues/456
EOF
git -C "$sandbox" add -A && git -C "$sandbox" commit -q -m "init"
set +e
(cd "$sandbox" && ./scripts/check-fixme.sh) >/dev/null 2>&1
code=$?
set -e
assert_exit "issue URL counts as valid reference" 0 "$code"
rm -rf "$sandbox"

# --- Test 4: script doesn't flag itself ---
sandbox="$(make_sandbox)"
set +e
(cd "$sandbox" && ./scripts/check-fixme.sh) >/dev/null 2>&1
code=$?
set -e
assert_exit "checker script does not flag its own comments" 0 "$code"
rm -rf "$sandbox"

# --- Test 5: no FIXME anywhere passes ---
sandbox="$(make_sandbox)"
mkdir -p "$sandbox/src"
echo "console.log('hello')" > "$sandbox/src/a.js"
git -C "$sandbox" add -A && git -C "$sandbox" commit -q -m "init"
set +e
(cd "$sandbox" && ./scripts/check-fixme.sh) >/dev/null 2>&1
code=$?
set -e
assert_exit "clean tree passes" 0 "$code"
rm -rf "$sandbox"

# --- Test 6: --diff mode only flags newly added lines ---
sandbox="$(make_sandbox)"
mkdir -p "$sandbox/src"
cat > "$sandbox/src/a.js" <<'EOF'
// FIXME: pre-existing, unreferenced, on base branch
EOF
git -C "$sandbox" add -A && git -C "$sandbox" commit -q -m "init"
git -C "$sandbox" checkout -q -b feature
cat >> "$sandbox/src/a.js" <<'EOF'
// FIXME(#42): new line, referenced
EOF
git -C "$sandbox" add -A && git -C "$sandbox" commit -q -m "add referenced line"
set +e
(cd "$sandbox" && ./scripts/check-fixme.sh --diff master) >/dev/null 2>&1
code=$?
set -e
assert_exit "--diff ignores pre-existing FIXME on base branch" 0 "$code"
rm -rf "$sandbox"

echo
echo "== $pass_count passed, $fail_count failed =="
[[ "$fail_count" -eq 0 ]]
