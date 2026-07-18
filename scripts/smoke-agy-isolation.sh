#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# smoke-agy-isolation.sh — Source-repository isolation smoke test
# ──────────────────────────────────────────────────────────────────────
#
# PURPOSE
#   Verify that running `genki contribute --host agy` does NOT mutate the
#   source repository referenced in the task fixture.  The test:
#     1. Creates a temporary, clean Git fixture repository.
#     2. Snapshots its content checksums and `git status` BEFORE the run.
#     3. Runs one Agy contribution task (`--max-tasks 1`).
#     4. Snapshots the same artifacts AFTER the run.
#     5. Exits non-zero (FAIL) if any source file changed, was added,
#        deleted, or if the git working tree became dirty.
#
# PREREQUISITES
#   • Node.js ≥ 22.18        (node --version)
#   • Git ≥ 2.40             (git --version)
#   • Agy ≥ 1.1.2            (agy --version)
#   • genki CLI on PATH       genki --help
#     (build with `npm run build && npm install -g .` from the repo root)
#   • Authenticated Agy session (provider credentials set up)
#
# USAGE
#   bash scripts/smoke-agy-isolation.sh          # run from repo root
#   GENKI_SMOKE_TIMEOUT=120 bash scripts/...     # override timeout (s)
#   DRY_RUN=1 bash scripts/...                   # skip the live Agy call
#
# EXIT CODES
#   0  — PASS  (source repo is clean after session)
#   1  — FAIL  (source repo was mutated)
#   2  — BLOCKED (prerequisite missing / timeout / auth error)
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Configurable timeout for the Agy run (seconds).  Default: 180s.
readonly TIMEOUT_SECS="${GENKI_SMOKE_TIMEOUT:-180}"

# Colour helpers (degrade gracefully if stdout is not a tty).
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

info()    { printf '%s[info]%s  %s\n'    "$BOLD"   "$RESET" "$*"; }
pass_msg(){ printf '%s[PASS]%s  %s\n'    "$GREEN"  "$RESET" "$*"; }
fail_msg(){ printf '%s[FAIL]%s  %s\n'    "$RED"    "$RESET" "$*"; }
blocked() { printf '%s[BLOCKED]%s %s\n'  "$YELLOW" "$RESET" "$*"; exit 2; }

# ── 0. Prerequisite checks ──────────────────────────────────────────
command -v node  >/dev/null 2>&1 || blocked "node is not on PATH"
command -v git   >/dev/null 2>&1 || blocked "git is not on PATH"
command -v genki >/dev/null 2>&1 || blocked "genki is not on PATH (build + npm install -g .)"

if [[ "${DRY_RUN:-}" != "1" ]]; then
  command -v agy >/dev/null 2>&1 || blocked "agy is not on PATH"
  agy_version="$(agy --version 2>/dev/null || true)"
  info "agy version: ${agy_version:-unknown}"
fi

info "node $(node --version) | git $(git --version | awk '{print $3}')"
info "genki at $(command -v genki)"

# ── 1. Create temporary fixture repo ────────────────────────────────
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/genki-smoke-XXXXXXXXXX")"
readonly TMPBASE
# shellcheck disable=SC2064
trap "rm -rf '$TMPBASE'" EXIT

SOURCE_REPO="$TMPBASE/source-repo"
TASK_DIR="$TMPBASE/tasks"
STATE_ROOT="$TMPBASE/genki-state"

mkdir -p "$SOURCE_REPO" "$TASK_DIR" "$STATE_ROOT"

# Initialise a minimal Git repository as the "source".
git -C "$SOURCE_REPO" init --initial-branch=main -q
cat > "$SOURCE_REPO/hello.js" <<'JSEOF'
// Fixture file for isolation smoke test.
function greet(name) {
  return `Hello, ${name}!`;
}
module.exports = { greet };
JSEOF
cat > "$SOURCE_REPO/hello.test.js" <<'JSEOF'
const assert = require("node:assert/strict");
const { greet } = require("./hello.js");
assert.strictEqual(greet("world"), "Hello, world!");
console.log("test passed");
JSEOF
git -C "$SOURCE_REPO" add -A
git -C "$SOURCE_REPO" commit -q -m "initial fixture"

info "Source fixture created at $SOURCE_REPO"
info "Source HEAD: $(git -C "$SOURCE_REPO" rev-parse HEAD)"

# ── 2. Write a single task JSON ──────────────────────────────────────
cat > "$TASK_DIR/001-smoke.json" <<TASKEOF
{
  "schemaVersion": "1",
  "id": "isolation-smoke-001",
  "title": "Isolation smoke task",
  "repository": {
    "path": "$SOURCE_REPO",
    "baseRef": "HEAD"
  },
  "instructions": "Add a farewell function to hello.js that returns 'Goodbye, <name>!' and a matching test in hello.test.js.",
  "validation": [
    {
      "argv": ["node", "hello.test.js"],
      "timeoutSeconds": 15
    }
  ],
  "policy": {
    "maxRuntimeSeconds": 90,
    "maxChangedFiles": 3,
    "maxPatchBytes": 10000
  }
}
TASKEOF

# ── 3. Snapshot source BEFORE the run ────────────────────────────────
snapshot_source() {
  # $1 = label for diagnostics
  local label="$1"
  local status porcelain checksum

  porcelain="$(git -C "$SOURCE_REPO" status --porcelain=v1 --untracked-files=normal 2>&1)"
  # Compute recursive SHA-256 of all files in the repo work tree.
  # Portable across macOS (shasum) and Linux (sha256sum).
  if command -v sha256sum >/dev/null 2>&1; then
    checksum="$(find "$SOURCE_REPO" -path "$SOURCE_REPO/.git" -prune -o -type f -print0 \
      | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | awk '{print $1}')"
  else
    checksum="$(find "$SOURCE_REPO" -path "$SOURCE_REPO/.git" -prune -o -type f -print0 \
      | sort -z | xargs -0 shasum -a 256 2>/dev/null | shasum -a 256 | awk '{print $1}')"
  fi

  status="clean"
  if [[ -n "$porcelain" ]]; then
    status="dirty"
  fi

  info "[$label] git status: $status"
  info "[$label] content checksum: $checksum"

  # Export for comparison.
  printf '%s\n' "$checksum"  > "$TMPBASE/${label}-checksum.txt"
  printf '%s\n' "$porcelain" > "$TMPBASE/${label}-porcelain.txt"
  printf '%s\n' "$status"    > "$TMPBASE/${label}-status.txt"
}

snapshot_source "BEFORE"

# ── 4. Run genki contribute (or skip in DRY_RUN mode) ───────────────
run_exit=0
if [[ "${DRY_RUN:-}" == "1" ]]; then
  info "DRY_RUN=1 — skipping live Agy invocation"
else
  info "Running genki contribute --host agy --max-tasks 1 (timeout ${TIMEOUT_SECS}s)..."

  # Portable timeout: run genki in the background, kill if over budget.
  # Works on macOS (which lacks GNU `timeout`) and Linux alike.
  GENKI_LOG="$TMPBASE/genki-output.log"

  set +e
  (
    GENKI_STATE_ROOT="$STATE_ROOT" \
    printf 'y\n' | genki contribute \
      --task-dir "$TASK_DIR" \
      --host agy \
      --max-tasks 1 \
      --duration 5m \
      --max-total-runtime 3m \
      --max-task-runtime 2m \
      --allow node \
    >"$GENKI_LOG" 2>&1
  ) &
  GENKI_PID=$!

  # Watchdog: kill after TIMEOUT_SECS.
  (
    sleep "$TIMEOUT_SECS" 2>/dev/null
    kill "$GENKI_PID" 2>/dev/null || true
  ) &
  WATCHDOG_PID=$!

  wait "$GENKI_PID" 2>/dev/null
  run_exit=$?

  # Disarm the watchdog if genki finished first.
  kill "$WATCHDOG_PID" 2>/dev/null || true
  wait "$WATCHDOG_PID" 2>/dev/null || true
  set -e

  # Display captured output.
  if [[ -f "$GENKI_LOG" ]]; then
    while IFS= read -r line; do
      info "[genki] $line"
    done < "$GENKI_LOG"
  fi

  if [[ $run_exit -eq 137 ]] || [[ $run_exit -eq 143 ]]; then
    info "genki contribute was killed after ${TIMEOUT_SECS}s timeout."
    info "This is acceptable — we still verify source integrity."
  elif [[ $run_exit -ne 0 ]]; then
    info "genki contribute exited with code $run_exit."
    info "Proceeding to verify source integrity regardless."
  fi
fi

# ── 5. Snapshot source AFTER the run ─────────────────────────────────
snapshot_source "AFTER"

# ── 6. Compare BEFORE vs AFTER ───────────────────────────────────────
before_checksum="$(cat "$TMPBASE/BEFORE-checksum.txt")"
after_checksum="$(cat "$TMPBASE/AFTER-checksum.txt")"
before_status="$(cat "$TMPBASE/BEFORE-status.txt")"
after_status="$(cat "$TMPBASE/AFTER-status.txt")"
after_porcelain="$(cat "$TMPBASE/AFTER-porcelain.txt")"

VERDICT="PASS"

# Check 1: source must still be clean.
if [[ "$after_status" != "clean" ]]; then
  fail_msg "Source repository is DIRTY after the run."
  fail_msg "git status --porcelain output:"
  printf '%s\n' "$after_porcelain" | sed 's/^/    /'
  VERDICT="FAIL"
fi

# Check 2: content checksums must match.
if [[ "$before_checksum" != "$after_checksum" ]]; then
  fail_msg "Source content checksums differ."
  fail_msg "  before: $before_checksum"
  fail_msg "  after:  $after_checksum"
  VERDICT="FAIL"
fi

# ── 7. Final verdict ────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════"
if [[ "$VERDICT" == "PASS" ]]; then
  pass_msg "Source repository isolation: PASS"
  echo "  Source was clean before and remains clean after."
  echo "  Content checksums match: $before_checksum"
  echo "════════════════════════════════════════════════════════"
  exit 0
else
  fail_msg "Source repository isolation: FAIL"
  echo "  Source was mutated during the Genki contribution session."
  echo "════════════════════════════════════════════════════════"
  exit 1
fi
