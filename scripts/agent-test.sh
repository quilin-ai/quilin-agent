#!/usr/bin/env bash
# agent-test.sh — tmux-based E2E test harness for the Quilin Agent REPL
#
# Lets a controller process (e.g. an outer agent or a CI script) drive an
# interactive Quilin REPL session running in a detached tmux session, so the
# controller can: send REPL inputs, poll for output patterns, capture full
# pane contents, and read a persisted log of everything the agent has emitted.
#
# Usage:
#   scripts/agent-test.sh start   <session> <command>          # detached tmux + pipe-pane to log
#   scripts/agent-test.sh send    <session> <input>            # send-keys input + Enter
#   scripts/agent-test.sh expect  <session> <pattern> [timeout_sec]  # poll capture-pane until match
#   scripts/agent-test.sh capture <session> [lines]            # dump pane contents
#   scripts/agent-test.sh log     <session>                    # print log path
#   scripts/agent-test.sh has     <session>                    # exit 0 if running, 1 otherwise
#   scripts/agent-test.sh cleanup <session>                    # kill-session + remove log
#   scripts/agent-test.sh selftest                             # round-trip test against bash REPL
#
# Trust contract:
#   <command> is executed by tmux via `/bin/sh -c "$command"`. Treat it as
#   caller-trusted code (same trust level as `eval`), never as untrusted
#   data. Do not pipe LLM output or user-typed strings into <command>.
#
# Behavior notes:
#   - `expect`'s ERE pattern matches against `tmux capture-pane -p -S -500`
#     output. tmux strips ANSI escape sequences by default in capture mode,
#     so callers should NOT include `\x1b\[...` codes in their patterns —
#     match the plain visible text. The persisted log file (pipe-pane), in
#     contrast, KEEPS raw ANSI codes; if you `grep` the log file directly
#     you may need `sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g'` first.
#   - If `<command>` exits before the 0.3s pipe-pane attach, `start` still
#     reports "started session 'X'" — but `tmux has-session` will return
#     false on the next call. Always `expect` for a known startup marker
#     (e.g. `quilin>`) right after `start`; if it times out, the command
#     died at boot. `cmd_log` is purely lexical (no tmux call, no
#     liveness check) — it always returns the path even when the session
#     does not exist.
#   - `cleanup` from one shell while `expect` is polling from another is
#     race-safe: tmux session disappears, the next `pane_matches` call
#     swallows the "no such pane" error via `2>/dev/null || true`, and
#     `expect` times out cleanly. No leaked process, no hang.
#
# Env:
#   AGENT_TEST_LOG_DIR              Log directory (default: /tmp/agent-test).
#                                   Validated against [A-Za-z0-9_./-]+ to
#                                   prevent shell-metachar injection through
#                                   the pipe-pane shell command.
#   AGENT_TEST_PANE_W               tmux pane width  (default: 200)
#   AGENT_TEST_PANE_H               tmux pane height (default: 50)
#   AGENT_TEST_SCROLLBACK_LINES     Scrollback lines `expect`'s capture-pane
#                                   poll inspects per iteration (default 500).
#                                   Bump for high-volume agents (e.g. LLM
#                                   streaming >500 lines / poll interval) to
#                                   avoid missing matches scrolled past.
#   AGENT_TEST_MAX_ATTEMPTS         `start`'s post-new-session poll budget
#                                   (default 40 × 50ms = 2s). The selftest
#                                   H-1 probe sets this to 4 (200ms) for
#                                   speed; users running `start` against a
#                                   long-running command never hit the
#                                   ceiling (first poll succeeds in 0ms).
#                                   Must be a positive integer; validated
#                                   before tmux invocation, so an invalid
#                                   value cannot leak a session.
#
# Example E2E flow (web_crawl repro):
#   ./scripts/agent-test.sh start qx 'just dev-yolo 2>&1'
#   ./scripts/agent-test.sh expect qx 'quilin>'
#   ./scripts/agent-test.sh send   qx '爬一下 docs.python.org'
#   ./scripts/agent-test.sh expect qx 'web_crawl' 60
#   ./scripts/agent-test.sh capture qx 1000
#   ./scripts/agent-test.sh cleanup qx
#
# Requirements:
#   bash >= 3.2 (works with macOS /bin/bash and homebrew bash 5+)
#   tmux >= 1.8 (pipe-pane -o, capture-pane -p -S, has-session -t =name)
#
# Cross-review note: this harness is itself reviewed code; see commit log.

set -euo pipefail

LOG_DIR="${AGENT_TEST_LOG_DIR:-/tmp/agent-test}"
PANE_W="${AGENT_TEST_PANE_W:-200}"
PANE_H="${AGENT_TEST_PANE_H:-50}"
SCROLLBACK_LINES="${AGENT_TEST_SCROLLBACK_LINES:-500}"

# SCROLLBACK_LINES validation — must be a positive integer to avoid the
# `-S -0` "whole visible pane" semantics (see cmd_capture).
if [[ ! "$SCROLLBACK_LINES" =~ ^[1-9][0-9]*$ ]]; then
	echo "agent-test: AGENT_TEST_SCROLLBACK_LINES must be a positive integer (got: $SCROLLBACK_LINES)" >&2
	exit 1
fi

# LOG_DIR is interpolated into a tmux pipe-pane shell command and into
# `mkdir -p` / `: > $logfile`. Three independent hardenings:
#   1. Charset: only [A-Za-z0-9_./-] — no shell metachars, no quotes,
#      no backslashes (forbidden chars cannot escape single-quoting).
#   2. Cannot start with `-` — would otherwise be parsed as flags by
#      `mkdir -p` / `cat` / other utilities (BSD mkdir aborts with
#      "illegal option -- r" when given $LOG_DIR=-rf).
#   3. Cannot contain `..` segments — defends against path traversal
#      from a careless caller exporting AGENT_TEST_LOG_DIR=../../etc.
if [[ ! "$LOG_DIR" =~ ^[A-Za-z0-9_./][A-Za-z0-9_./-]*$ ]]; then
	echo "agent-test: AGENT_TEST_LOG_DIR has unsafe charset or leading dash: $LOG_DIR" >&2
	echo "agent-test: must match ^[A-Za-z0-9_./][A-Za-z0-9_./-]*$ (no quotes, no shell metachars, no leading -)" >&2
	exit 1
fi
if [[ "$LOG_DIR" == *..* ]]; then
	echo "agent-test: AGENT_TEST_LOG_DIR contains '..' (path traversal): $LOG_DIR" >&2
	exit 1
fi

# `--` ends option parsing so a path like `./logs` does not get reinterpreted.
mkdir -p -- "$LOG_DIR"

die() {
	echo "agent-test: $*" >&2
	exit 1
}

require_tmux() {
	command -v tmux >/dev/null 2>&1 || die "tmux not on PATH"
}

require_session_name() {
	local name="${1-}"
	[[ -n "$name" ]] || die "session name required"
	[[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || die "session name must match [A-Za-z0-9_-]+: $name"
}

log_path_for() {
	local session="$1"
	printf '%s/%s.log' "$LOG_DIR" "$session"
}

# Use exact-match (=name) prefix only for session-targeting commands
# (has-session, kill-session). Pane-targeting commands (capture-pane,
# send-keys, pipe-pane) require a pane-target, where `=name` resolution
# differs and tmux 3.6a returns "can't find pane: =name". Session-name
# regex already excludes ambiguous chars, so prefix-match collisions are
# limited to `foo` vs `foobar` overlaps for pane ops — accept that risk
# and rely on `has-session` for unambiguous existence checks.
session_exists() {
	tmux has-session -t "=$1" 2>/dev/null
}

# Pipeline-free pattern match: capture into a variable so an early grep
# exit cannot SIGPIPE the producer (defensive; not currently observed to
# misbehave under bash 3.2/5+, but cheaper than auditing pipefail interaction
# every time).
pane_matches() {
	local session="$1"
	local pattern="$2"
	local out
	# Scrollback depth governed by AGENT_TEST_SCROLLBACK_LINES (default 500).
	# Higher values cost slightly more CPU per poll but reduce risk of
	# missing matches that scroll past during high-volume LLM streaming.
	out="$(tmux capture-pane -t "$session" -p -S -"$SCROLLBACK_LINES" 2>/dev/null || true)"
	printf '%s' "$out" | grep -qE -- "$pattern"
}

cmd_start() {
	require_tmux
	local session="${1-}"
	local command="${2-}"
	require_session_name "$session"
	[[ -n "$command" ]] || die "start: command required"

	# Validate AGENT_TEST_MAX_ATTEMPTS BEFORE any session-creating side
	# effect (the INT/TERM trap below does NOT cover generic die exits, so
	# a post-new-session validation failure would leak both session and
	# zero-byte logfile). Empty-string is treated as "use default" — same
	# convention as LOG_DIR / SCROLLBACK_LINES env handling.
	local max_attempts="${AGENT_TEST_MAX_ATTEMPTS:-40}"
	if [[ ! "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
		die "AGENT_TEST_MAX_ATTEMPTS must be a positive integer (got: $max_attempts)"
	fi

	local logfile
	logfile="$(log_path_for "$session")"

	# Install the SIGINT/SIGTERM trap *before* `tmux new-session` so the
	# race window between the kernel marking the session alive and our
	# shell registering a cleanup handler shrinks to a single variable
	# assignment (sub-microsecond — bounded by bash's signal-check
	# granularity between simple commands). The trap body uses lazy
	# expansion: $session, $logfile, $session_started are read at fire
	# time. Until session_started=1 the trap is a pure exit-130 no-op;
	# after session_started=1 it kills the session and rm's the logfile.
	# require_session_name + validate_log_dir guarantee these variables
	# are shell-metachar safe, so lazy expansion cannot inject.
	local session_started=0
	# shellcheck disable=SC2016
	trap '(( session_started )) && { rm -f "$logfile"; tmux kill-session -t "=$session" 2>/dev/null || true; }; exit 130' INT TERM

	# C-3: do NOT pre-check via session_exists then call new-session —
	# that's TOCTOU. Instead let `tmux new-session -d` itself report
	# the duplicate-session error and translate it to our actionable
	# format. tmux returns non-zero with "duplicate session" stderr
	# when the name is taken; we capture stderr and re-raise.
	local new_session_err
	if ! new_session_err="$(tmux new-session -d -s "$session" -x "$PANE_W" -y "$PANE_H" "$command" 2>&1)"; then
		# new-session failed — no session created, trap cleanup unneeded.
		trap - INT TERM
		# Distinguish duplicate-session from other failures (e.g. malformed
		# command spec) by matching tmux's well-known error string.
		if [[ "$new_session_err" == *"duplicate session"* ]]; then
			die "session '$session' already exists — cleanup first or pick another name"
		fi
		die "start: tmux new-session failed: $new_session_err"
	fi
	# Session is alive in the tmux server; arm the trap's cleanup body.
	session_started=1

	# Now safe to truncate (start succeeded). Pipe-pane will append from
	# this point; any prior content is intentionally discarded so each
	# `start` produces a fresh log.
	: >"$logfile"

	# Poll session_exists instead of using a fixed `sleep 0.3`. tmux
	# `new-session -d` is synchronous w.r.t. has-session for healthy
	# long-running commands — the first poll succeeds immediately, 0ms.
	#
	# The 50ms × 40 = 2s ceiling covers two distinct cases:
	#   (a) slow-CI / cold-tmux-server warm-up where the long-running
	#       inner shell genuinely needs a moment.
	#   (b) Fast-exit commands like `start <s> 'true'` — the session
	#       already died by the time we poll. We exhaust the full 2s
	#       budget *by design* (we are confirming death, not waiting
	#       for life), then the H-1 die path emits a structured
	#       diagnostic. Selftest exercises this path and accepts the
	#       2s cost; users running `start <s> '<long-cmd>'` never see
	#       it.
	#
	# Override the ceiling by exporting AGENT_TEST_MAX_ATTEMPTS — the
	# selftest H-1 probe sets this to 4 (200ms) to keep selftest fast.
	local poll_attempts=0
	while ((poll_attempts < max_attempts)); do
		if session_exists "$session"; then
			break
		fi
		sleep 0.05
		poll_attempts=$((poll_attempts + 1))
	done

	# H-1: post-startup verification. If the session is gone after the
	# poll window, the command exited before we could attach pipe-pane.
	# Emit a structured, actionable error rather than letting the user
	# discover this via "no such session" on the next subcommand. Also
	# rm the truncated logfile so a tight loop of failed `start`s does
	# not leak zero-byte files into LOG_DIR; disarm the trap because the
	# session is already dead.
	if ! session_exists "$session"; then
		rm -f "$logfile"
		trap - INT TERM
		die "start: command exited before pipe-pane could attach — session '$session' is dead.
       Likely causes: the <command> string failed at parse / exec, or finished
       too fast (e.g. 'true' / 'echo hi'). Use a long-running command (a REPL
       like 'bash -i' or 'just dev-yolo'), or wrap a short command to keep
       the pane alive after it exits: '<your-cmd>; sleep 3600'.
       NOTE: 'sleep N && <your-cmd>' would block for N seconds BEFORE running
       your command — that is NOT what you want here."
	fi

	# Wrap pipe-pane in an explicit failure branch. The INT/TERM trap
	# does NOT cover non-zero exits under `set -e` — if pipe-pane fails
	# (e.g. tmux server-side fault), the script aborts before the
	# trap-clear and would leak BOTH session and zero-byte logfile.
	# Mirror the H-1 die path: rm, kill, clear trap, die. `-o` is tmux's
	# TOGGLE flag (idempotent re-attach); `cat >>` does the actual append.
	if ! tmux pipe-pane -t "$session" -o "cat >>'$logfile'"; then
		rm -f "$logfile"
		tmux kill-session -t "=$session" 2>/dev/null || true
		trap - INT TERM
		die "start: tmux pipe-pane attach failed for session '$session' — tmux server may be unhealthy"
	fi

	# Pipe-pane attached; the SIGINT trap is no longer needed because
	# subsequent failures (in the caller, not in cmd_start) are the
	# caller's responsibility to clean up via `cmd_cleanup`.
	trap - INT TERM

	echo "agent-test: started session '$session'  log=$logfile  pane=${PANE_W}x${PANE_H}"
}

cmd_send() {
	require_tmux
	local session="${1-}"
	require_session_name "$session"
	shift
	# Require exactly one input arg so whitespace inside the input is
	# preserved verbatim. Multi-arg `send qx hello world` would silently
	# normalize whitespace via `$*`, breaking REPL inputs that care about
	# tabs / multi-space alignment / JSON / code snippets.
	[[ $# -eq 1 ]] || die "send: expects exactly one quoted input string (got $#)"
	local input="$1"

	if ! session_exists "$session"; then
		die "send: no such session '$session'"
	fi

	# `--` ends option parsing so an input starting with `-` is not eaten.
	# `Enter` after the literal text submits the line.
	tmux send-keys -t "$session" -- "$input" Enter
}

cmd_expect() {
	require_tmux
	local session="${1-}"
	local pattern="${2-}"
	local timeout="${3-30}"
	require_session_name "$session"
	[[ -n "$pattern" ]] || die "expect: pattern required"
	[[ "$timeout" =~ ^[0-9]+$ ]] || die "expect: timeout must be a non-negative integer (got: $timeout)"

	if ! session_exists "$session"; then
		die "expect: no such session '$session'"
	fi

	# Initial check before the loop. Covers two cases:
	#   1. timeout=0 → caller wants single-shot "is it there now?" — must
	#      return 0 if the pattern is already present, not loop-skip to 1.
	#   2. fast-path: pattern already streamed before expect was called.
	if pane_matches "$session" "$pattern"; then
		echo "agent-test: matched immediately — pattern: $pattern"
		return 0
	fi

	local interval=1
	local elapsed=0
	while ((elapsed < timeout)); do
		sleep "$interval"
		elapsed=$((elapsed + interval))
		if pane_matches "$session" "$pattern"; then
			echo "agent-test: matched after ${elapsed}s — pattern: $pattern"
			return 0
		fi
	done

	echo "agent-test: TIMEOUT after ${timeout}s waiting for pattern: $pattern" >&2
	echo "agent-test: --- last 100 pane lines ---" >&2
	tmux capture-pane -t "$session" -p -S -100 >&2 || true
	echo "agent-test: --- end ---" >&2
	return 1
}

cmd_capture() {
	require_tmux
	local session="${1-}"
	local lines="${2-500}"
	require_session_name "$session"
	# `lines` must be ≥ 1 OR the literal sentinel `all` (tmux's full
	# scrollback). `0` is rejected because tmux interprets `-S -0` as
	# "whole visible pane" not "zero lines" — likely a caller typo.
	# `all` maps to `tmux capture-pane -S -` (start at the top of the
	# entire pane history).
	if [[ "$lines" != "all" && ! "$lines" =~ ^[1-9][0-9]*$ ]]; then
		die "capture: lines must be a positive integer or the literal 'all' (got: $lines)"
	fi

	if ! session_exists "$session"; then
		die "capture: no such session '$session'"
	fi

	if [[ "$lines" == "all" ]]; then
		tmux capture-pane -t "$session" -p -S -
	else
		tmux capture-pane -t "$session" -p -S -"$lines"
	fi
}

cmd_log() {
	local session="${1-}"
	require_session_name "$session"
	log_path_for "$session"
}

cmd_has() {
	require_tmux
	local session="${1-}"
	require_session_name "$session"
	if session_exists "$session"; then
		return 0
	fi
	return 1
}

cmd_cleanup() {
	require_tmux
	local session="${1-}"
	require_session_name "$session"
	local logfile
	logfile="$(log_path_for "$session")"
	# Track each side independently so the user sees both outcomes
	# (G-1 from cross review): a partial cleanup where kill-session
	# succeeds but rm fails — or vice versa — was previously hidden by
	# a single "killed" / "already gone" message that did not mention
	# the log file at all.
	local session_status="absent"
	local log_status="absent"
	if session_exists "$session"; then
		if tmux kill-session -t "=$session" 2>/dev/null || tmux kill-session -t "$session" 2>/dev/null; then
			session_status="killed"
		else
			session_status="kill-failed"
		fi
	fi
	# Always attempt log removal so callers running many test cases do
	# not leak files into $LOG_DIR. If a caller wants to keep the log,
	# they should `cp` it before cleanup or read via `log` first.
	if [[ -f "$logfile" ]]; then
		if rm -f "$logfile"; then
			log_status="removed"
		else
			log_status="rm-failed"
		fi
	fi
	echo "agent-test: cleanup '$session' — session=$session_status log=$log_status"
}

# Self-test: round-trip start/send/expect/cleanup against a fresh bash REPL.
# Stand-in for unit tests; verifies the harness end-to-end without needing
# the Quilin REPL (which has its own startup latency / dependencies).
cmd_selftest() {
	require_tmux
	local s="agent_test_selftest_$$"
	echo "agent-test: selftest using session '$s'"

	# Trap cleanup so a failing assertion does not leak the tmux session
	# or its log file. Removed via `trap - EXIT` on success path.
	# Use printf -v %q to defensively shell-quote the session name even
	# though our session_name regex already excludes shell-metachars —
	# G-3 hardening, costs nothing and locks the API contract: future
	# changes that loosen the session-name regex will not silently
	# create a trap injection vulnerability.
	local safe_s
	printf -v safe_s '%q' "$s"
	# EXIT trap also covers the H-1 probe session created below — if a
	# signal lands between probe success-detection and explicit cleanup,
	# the EXIT handler still cleans up. agent_test_h1_$$ matches the
	# literal name used at the H-1 negative probe (same shell PID).
	# shellcheck disable=SC2064
	trap "cmd_cleanup $safe_s 2>/dev/null || true; cmd_cleanup agent_test_h1_$$ 2>/dev/null || true" EXIT

	# Use an interactive bash with no rc files so prompt is deterministic.
	cmd_start "$s" 'env PS1="\$ " bash --norc --noprofile -i 2>&1'
	cmd_expect "$s" '\$' 5

	# Round-trip 1: simple echo
	cmd_send "$s" 'echo HELLO_AGENT_TEST_42'
	cmd_expect "$s" 'HELLO_AGENT_TEST_42' 5

	# Round-trip 2: whitespace preservation (catches Round-1 Bug 3 regression)
	cmd_send "$s" 'printf "%s\n" "two  spaces"'
	cmd_expect "$s" 'two  spaces' 5

	# Round-trip 3: timeout=0 fast-path against already-present marker
	# (catches Round-1 Bug 2 regression)
	cmd_expect "$s" 'HELLO_AGENT_TEST_42' 0

	# has should be true
	if ! cmd_has "$s"; then
		echo "agent-test: SELFTEST FAIL — has returned false on a live session" >&2
		return 1
	fi

	# capture must contain at least one of our markers — must run BEFORE
	# the large-stream stress below, otherwise the 2000-line yes output
	# pushes earlier markers out of any reasonable scrollback window.
	if ! cmd_capture "$s" 200 | grep -q 'HELLO_AGENT_TEST_42'; then
		echo "agent-test: SELFTEST FAIL — capture missed marker" >&2
		return 1
	fi

	# Stress: large output should not break match (defends pane_matches
	# against future regressions if someone re-introduces a SIGPIPE-prone
	# pipeline). Send a stream that fills a pane buffer then verify match.
	cmd_send "$s" 'yes BIG_STREAM_ABCDEFGHIJ_XYZ | head -2000'
	cmd_expect "$s" 'BIG_STREAM_ABCDEFGHIJ_XYZ' 5

	cmd_cleanup "$s"

	# After cleanup: has should be false, log should be gone
	if cmd_has "$s" 2>/dev/null; then
		echo "agent-test: SELFTEST FAIL — session lingering after cleanup" >&2
		return 1
	fi
	if [[ -f "$(log_path_for "$s")" ]]; then
		echo "agent-test: SELFTEST FAIL — log file lingering after cleanup" >&2
		return 1
	fi

	# LOG_DIR injection / traversal / leading-dash — fork sub-shells so
	# the validation `exit 1` does not abort the parent script. Each
	# probe must EXIT NON-ZERO; if any one passes (exit 0), it's a
	# validation regression. (catches Round-1 Bug 4 + Round-2 Bugs 1 / 2)
	#
	# Use `log` (not `has`) as the inner probe: `log` is purely lexical —
	# it does NOT call tmux — so a non-zero exit unambiguously means
	# LOG_DIR validation rejected. With `has nope` the inner script could
	# also exit non-zero because tmux reports "no such session", which
	# would mask a validation regression where the gate accidentally
	# loosened.
	local probe
	for probe in \
		"/tmp/x'; touch /tmp/AGENT_TEST_PWNED; #" \
		'../../etc' \
		'-rf' \
		'$(touch /tmp/AGENT_TEST_PWNED)'
	do
		if AGENT_TEST_LOG_DIR="$probe" "${BASH_SOURCE[0]}" log probe 2>/dev/null; then
			echo "agent-test: SELFTEST FAIL — LOG_DIR validation accepted: $probe" >&2
			return 1
		fi
	done
	if [[ -e /tmp/AGENT_TEST_PWNED ]]; then
		rm -f /tmp/AGENT_TEST_PWNED
		echo "agent-test: SELFTEST FAIL — LOG_DIR injection wrote a file" >&2
		return 1
	fi

	# Multi-arg send rejection
	if "${BASH_SOURCE[0]}" send "$s" hello world 2>/dev/null; then
		echo "agent-test: SELFTEST FAIL — multi-arg send accepted" >&2
		return 1
	fi

	# Invalid AGENT_TEST_MAX_ATTEMPTS must die BEFORE creating a session,
	# so no tmux session leaks. Probe several invalid forms.
	local mxa_probe
	for mxa_probe in 0 04 -1 abc '4; touch /tmp/AGENT_TEST_MXA_PWNED'; do
		local mxa_session="agent_test_mxa_$$"
		if AGENT_TEST_MAX_ATTEMPTS="$mxa_probe" "${BASH_SOURCE[0]}" start "$mxa_session" 'sleep 60' 2>/dev/null; then
			echo "agent-test: SELFTEST FAIL — invalid AGENT_TEST_MAX_ATTEMPTS accepted: $mxa_probe" >&2
			cmd_cleanup "$mxa_session" 2>/dev/null || true
			return 1
		fi
		if tmux has-session -t "=$mxa_session" 2>/dev/null; then
			echo "agent-test: SELFTEST FAIL — invalid AGENT_TEST_MAX_ATTEMPTS leaked session: $mxa_probe" >&2
			tmux kill-session -t "=$mxa_session" 2>/dev/null || true
			return 1
		fi
		if [[ -f "$(log_path_for "$mxa_session")" ]]; then
			echo "agent-test: SELFTEST FAIL — invalid AGENT_TEST_MAX_ATTEMPTS leaked logfile: $mxa_probe" >&2
			rm -f "$(log_path_for "$mxa_session")"
			return 1
		fi
	done
	if [[ -e /tmp/AGENT_TEST_MXA_PWNED ]]; then
		rm -f /tmp/AGENT_TEST_MXA_PWNED
		echo "agent-test: SELFTEST FAIL — AGENT_TEST_MAX_ATTEMPTS injection wrote a file" >&2
		return 1
	fi

	# H-1 negative coverage: `start` with a command that exits immediately
	# ('true') must die with the "command exited before pipe-pane could
	# attach" diagnostic. Locks the H-1 contract so a future refactor that
	# drops the session_exists post-poll check trips selftest immediately.
	# Uses a fresh session name to avoid interference; the H-1 die path
	# also rm's the log file, so no leak after this probe.
	local h1_probe="agent_test_h1_$$"
	local h1_err
	local h1_rc=0
	# `set -e` aborts on a non-zero command substitution INSIDE an
	# assignment, so the rc capture has to use `|| ...` to keep us alive
	# on the expected die-path.
	# Cap the H-1 probe poll budget at 4 × 50ms = 200ms instead of the
	# default 2s — fast-exit commands always exhaust the budget, so we
	# trim it for selftest reliability and CI throughput.
	h1_err="$(AGENT_TEST_MAX_ATTEMPTS=4 "${BASH_SOURCE[0]}" start "$h1_probe" true 2>&1)" || h1_rc=$?
	if (( h1_rc == 0 )); then
		echo "agent-test: SELFTEST FAIL — H-1 fast-exit command accepted" >&2
		# Defensive cleanup in case start somehow succeeded.
		cmd_cleanup "$h1_probe" 2>/dev/null || true
		return 1
	fi
	# Lock the H-1 diagnostic path specifically. Without this assertion,
	# dropping the session_exists post-poll check still produces non-zero
	# exit + clean logfile via the pipe-pane failure fallback (which also
	# rms the logfile), making the contract ambiguous — the test would
	# pass spuriously on broken code.
	if [[ "$h1_err" != *"command exited before pipe-pane could attach"* ]]; then
		echo "agent-test: SELFTEST FAIL — H-1 probe did not produce the H-1 diagnostic." >&2
		echo "  exit=$h1_rc  stderr=$h1_err" >&2
		return 1
	fi
	if [[ -f "$(log_path_for "$h1_probe")" ]]; then
		echo "agent-test: SELFTEST FAIL — H-1 die path leaked logfile" >&2
		rm -f "$(log_path_for "$h1_probe")"
		return 1
	fi

	# Success: drop the cleanup trap.
	trap - EXIT
	echo "agent-test: SELFTEST PASSED"
}

usage() {
	# Print the leading comment block from this script (the documentation
	# header). Use BASH_SOURCE so it works when invoked via PATH/symlink.
	sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

main() {
	local sub="${1-help}"
	case "$sub" in
		start)
			shift
			cmd_start "$@"
			;;
		send)
			shift
			cmd_send "$@"
			;;
		expect)
			shift
			cmd_expect "$@"
			;;
		capture)
			shift
			cmd_capture "$@"
			;;
		log)
			shift
			cmd_log "$@"
			;;
		has)
			shift
			cmd_has "$@"
			;;
		cleanup)
			shift
			cmd_cleanup "$@"
			;;
		selftest)
			cmd_selftest
			;;
		help | --help | -h)
			usage
			;;
		*)
			# G-2: invalid subcommand — usage to stderr so CI wrappers
			# parsing stderr see the error, not stdout (which a chained
			# pipeline might be reading for parseable output).
			echo "agent-test: unknown subcommand: $sub" >&2
			usage >&2
			exit 1
			;;
	esac
}

main "$@"
