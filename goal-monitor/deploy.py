#!/usr/bin/env python3
"""
Goal Monitor — Deploy & Patch Script for OpenClaw
==================================================

Run this script on the DROPLET (not your local machine).

What it does:
  1. Copies goal-monitor.mjs into the OpenClaw container at /app/goal-monitor.mjs
  2. Discovers compiled chunk files in /app/dist/ by content search
  3. Patches gateway chunk(s) with TWO hooks:
     a. Text capture    — saves agent response text before buffer is cleared
     b. Lifecycle patch — calls onTurnEnd() at turn end with response text
        (enqueueSystemEvent and requestHeartbeatNow are local to the chunk)
  4. Patches extensionAPI.js with command registration hook
     (registerPluginCommand is a local function inside extensionAPI.js)
  5. Creates the initial goals.json store
  6. Restarts the OpenClaw container

Usage:
  cd /opt/cursor-proxy-patched/goal-monitor
  python3 deploy.py             # apply the patch
  python3 deploy.py --revert    # revert the patch (restores backups)
  python3 deploy.py --verify    # check if the patch is applied
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time

CONTAINER = "openclaw"
GOAL_MONITOR_SRC = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "goal-monitor.mjs"
)
GOAL_FILE_PATH = "/home/node/.openclaw/goals.json"
EXTENSION_API_PATH = "/app/dist/extensionAPI.js"

# Patch markers (used to detect existing patches and for --verify)
TEXT_CAPTURE_MARKER = "--- GOAL MONITOR: TEXT CAPTURE ---"
LIFECYCLE_MARKER = "--- GOAL MONITOR PATCH ---"
CMD_REG_MARKER = "--- GOAL MONITOR: COMMAND REGISTRATION ---"
STARTUP_TRIGGER_MARKER = "--- GOAL MONITOR: STARTUP TRIGGER ---"
BACKUP_SUFFIX = ".goal-monitor-backup"


# ── helpers ──────────────────────────────────────────────────────────


def run(cmd, capture=True, check=True):
    """Run a shell command and return stdout."""
    result = subprocess.run(cmd, shell=True, capture_output=capture, text=True)
    if check and result.returncode != 0:
        print(f"[ERROR] Command failed: {cmd}")
        if result.stderr:
            print(result.stderr.strip())
        sys.exit(1)
    return result.stdout.strip() if capture else ""


def docker_exec(cmd, check=True):
    """Run a bash command inside the OpenClaw container.

    Uses bash -c with single-quote wrapping for proper glob expansion
    and escaping inside the container shell.
    """
    escaped = cmd.replace("'", "'\\''")
    return run(
        f"docker exec -u root {CONTAINER} bash -c '{escaped}'",
        check=check,
    )


def docker_cp_to(local_path, container_path):
    """Copy a file from host into the container."""
    run(f"docker cp {local_path} {CONTAINER}:{container_path}")


def docker_cp_from(container_path, local_path):
    """Copy a file from the container to host."""
    run(f"docker cp {CONTAINER}:{container_path} {local_path}")


# ── discovery ────────────────────────────────────────────────────────


def find_dist_files_containing(pattern):
    """Find .js files in /app/dist/ containing a string pattern."""
    result = docker_exec(
        f'grep -rl "{pattern}" /app/dist/ --include="*.js" 2>/dev/null',
        check=False,
    )
    files = [p.strip() for p in result.splitlines() if p.strip() and p.endswith(".js")]
    # Exclude node_modules
    return [f for f in files if "/node_modules/" not in f]


def discover_paths():
    """Discover all required file paths inside the container by content search."""
    print("[DISCOVER] Searching compiled files in /app/dist/ ...")

    # ── Gateway chunk(s): contain chatRunState, emitChatFinal, etc. ──
    gateway_candidates = find_dist_files_containing("chatRunState")
    if not gateway_candidates:
        print("[ERROR] Could not find any .js file containing 'chatRunState' in /app/dist/")
        sys.exit(1)

    # Prefer gateway-cli files (known Rolldown chunk naming pattern)
    gateway_files = [f for f in gateway_candidates if "gateway-cli" in f]
    if not gateway_files:
        gateway_files = gateway_candidates[:2]

    for gf in gateway_files:
        print(f"  Gateway chunk: {gf}")

    # Verify key functions exist in each gateway chunk
    required_fns = [
        "emitChatFinal",
        "clearAgentRunContext",
        "enqueueSystemEvent",
        "requestHeartbeatNow",
    ]
    for gf in gateway_files:
        missing = []
        for fn in required_fns:
            count = docker_exec(
                f'grep -c "{fn}" "{gf}" 2>/dev/null || echo 0', check=False
            )
            c = count.strip().split("\n")[-1]
            if c == "0":
                missing.append(fn)
        if missing:
            print(f"  [WARN] Missing in {os.path.basename(gf)}: {', '.join(missing)}")
        else:
            print(f"  [OK] All required functions found in {os.path.basename(gf)}")

    # ── extensionAPI.js: stable path, contains registerPluginCommand ──
    ext_ok = False
    ext_check = docker_exec(
        f"test -f {EXTENSION_API_PATH} && echo exists || echo missing",
        check=False,
    )
    if "exists" in ext_check:
        reg_count = docker_exec(
            f'grep -c "registerPluginCommand" "{EXTENSION_API_PATH}" 2>/dev/null || echo 0',
            check=False,
        )
        c = reg_count.strip().split("\n")[-1]
        if int(c) > 0:
            print(f"  extensionAPI.js: {EXTENSION_API_PATH} ({c} registerPluginCommand refs)")
            ext_ok = True
        else:
            print(f"  [WARN] registerPluginCommand not found in {EXTENSION_API_PATH}")
    else:
        print(f"  [WARN] {EXTENSION_API_PATH} not found — command registration will be skipped")

    return {
        "gateway_files": gateway_files,
        "extension_api": EXTENSION_API_PATH if ext_ok else None,
    }


# ── patch builders ───────────────────────────────────────────────────


def build_text_capture_patch():
    """Build the text capture code inserted inside emitChatFinal.

    This saves the agent's response text to globalThis.__gmLastResponse
    BEFORE the buffer is cleared. The lifecycle patch reads it later.
    """
    return (
        f"    // {TEXT_CAPTURE_MARKER}\n"
        f"    globalThis.__gmLastResponse = {{ text: text, sessionKey: sessionKey, ts: Date.now() }};\n"
        f"    // --- END GOAL MONITOR: TEXT CAPTURE ---"
    )


def build_lifecycle_patch():
    """Build the lifecycle patch code (inserted after clearAgentRunContext).

    References enqueueSystemEvent and requestHeartbeatNow directly —
    they are local variables in the same gateway chunk file.
    Only dynamic import needed is for /app/goal-monitor.mjs.
    """
    indent = "    "
    lines = [
        f"// {LIFECYCLE_MARKER}",
        f'if (lifecyclePhase === "end" && !isAborted) {{',
        f"  const __gmData = globalThis.__gmLastResponse;",
        f"  if (__gmData && Date.now() - __gmData.ts < 10000) {{",
        f'    import("/app/goal-monitor.mjs").then((gm) => {{',
        f'      gm.onTurnEnd(__gmData.sessionKey || sessionKey, __gmData.text || "", {{',
        f"        enqueueSystemEvent,",
        f"        requestHeartbeatNow",
        f"      }});",
        f"    }}).catch(() => {{}});",
        f"  }}",
        f"}}",
        f"// --- END GOAL MONITOR PATCH ---",
    ]
    return "\n".join(indent + line for line in lines)


def build_cmd_registration_patch():
    """Build the command registration code (appended to extensionAPI.js).

    registerPluginCommand is a local function defined in extensionAPI.js,
    so it is directly accessible at the append point — no imports needed.
    """
    lines = [
        f"// {CMD_REG_MARKER}",
        'import("/app/goal-monitor.mjs").then((gm) => {',
        '  if (typeof gm.registerGoalCommand === "function") {',
        "    gm.registerGoalCommand(registerPluginCommand);",
        "  }",
        "}).catch((err) => {",
        '  console.error("[goal-monitor] /goal command registration failed:", err?.message || String(err));',
        "});",
        "// --- END GOAL MONITOR: COMMAND REGISTRATION ---",
    ]
    return "\n".join(lines)


def build_startup_trigger_patch():
    """Build a trigger import appended to the gateway chunk.

    extensionAPI.js is NOT loaded at startup by default — it's loaded
    on demand. The gateway chunk IS loaded at startup. By importing
    extensionAPI.js from the gateway chunk, we force it to load, which
    executes the command registration code appended to its end.
    """
    lines = [
        f"// {STARTUP_TRIGGER_MARKER}",
        '// Force extensionAPI.js to load at startup so /goal command gets registered',
        'import("/app/dist/extensionAPI.js").catch(() => {});',
        "// --- END GOAL MONITOR: STARTUP TRIGGER ---",
    ]
    return "\n".join(lines)


# ── gateway chunk patching ───────────────────────────────────────────


def patch_gateway_chunk(filepath):
    """Apply text capture and lifecycle patches to a gateway chunk file."""
    basename = os.path.basename(filepath)
    local_original = f"/tmp/{basename}.original"
    local_patched = f"/tmp/{basename}.patched"

    print(f"\n  Extracting {basename} from container ...")
    docker_cp_from(filepath, local_original)

    with open(local_original, "r", encoding="utf-8") as f:
        source = f.read()

    # Check if already patched
    if LIFECYCLE_MARKER in source or TEXT_CAPTURE_MARKER in source or STARTUP_TRIGGER_MARKER in source:
        print(f"  [SKIP] {basename} already patched. Use --revert first to re-patch.")
        return False

    # Create backup
    docker_exec(f'cp "{filepath}" "{filepath}{BACKUP_SUFFIX}"')
    print(f"  Backup created: {filepath}{BACKUP_SUFFIX}")

    # ── PATCH 1: Text Capture (inside emitChatFinal) ─────────────────
    print(f"  Applying text capture patch to {basename} ...")

    # Pattern: const text = chatRunState.buffers.get(clientRunId)...;
    #          chatRunState.buffers.delete(clientRunId);
    # Insert BETWEEN these two lines.
    tc_pattern = re.compile(
        r"((?:const|let|var)\s+(\w+)\s*=\s*chatRunState\.buffers\.get\(clientRunId\).*?;)"
        r"(\s*\n)"
        r"(\s*chatRunState\.buffers\.delete\(clientRunId\)\s*;)",
        re.DOTALL,
    )

    tc_match = tc_pattern.search(source)
    if not tc_match:
        # Fallback: simpler pattern
        tc_fallback = re.compile(
            r"(chatRunState\.buffers\.get\(clientRunId\).*?;\s*\n)"
            r"(\s*)(chatRunState\.buffers\.delete\(clientRunId\)\s*;)",
            re.DOTALL,
        )
        tc_match = tc_fallback.search(source)
        if not tc_match:
            print(f"  [ERROR] Could not find chatRunState.buffers.get/delete pattern in {basename}")
            sys.exit(1)

        insert_pos = tc_match.start(3)
        capture_code = build_text_capture_patch()
        source = source[:insert_pos] + capture_code + "\n" + source[insert_pos:]
    else:
        text_var = tc_match.group(2)  # captured variable name (usually 'text')
        insert_pos = tc_match.end(1) + len(tc_match.group(3))
        capture_code = build_text_capture_patch().replace(
            "text: text,", f"text: {text_var},"
        )
        source = source[:insert_pos] + capture_code + "\n" + source[insert_pos:]

    # ── PATCH 2: Lifecycle Handler (after clearAgentRunContext) ───────
    print(f"  Applying lifecycle patch to {basename} ...")

    lc_pattern = re.compile(
        r"(clearAgentRunContext\s*\([^)]*\)\s*;)", re.MULTILINE
    )
    lc_matches = list(lc_pattern.finditer(source))

    if not lc_matches:
        print(f"  [ERROR] Could not find clearAgentRunContext in {basename}")
        sys.exit(1)

    # Find the correct insertion point: the clearAgentRunContext call
    # that follows toolEventRecipients.markFinal (the lifecycle "end" block)
    target_match = None
    for m in lc_matches:
        context_before = source[max(0, m.start() - 300) : m.start()]
        if "toolEventRecipients.markFinal" in context_before:
            target_match = m
            break

    if not target_match:
        # Fallback: look for clearAgentRunContext near lifecyclePhase === "end"
        for m in lc_matches:
            context_before = source[max(0, m.start() - 300) : m.start()]
            if 'lifecyclePhase === "end"' in context_before:
                target_match = m
                break

    if not target_match:
        # Last resort: use the last match in the first half of the file
        first_half = len(source) // 2
        candidates = [m for m in lc_matches if m.start() < first_half]
        target_match = candidates[-1] if candidates else lc_matches[-1]

    insert_pos = target_match.end()
    lifecycle_code = build_lifecycle_patch()
    source = source[:insert_pos] + "\n" + lifecycle_code + "\n" + source[insert_pos:]

    # ── PATCH 3: Startup Trigger (appended to end of file) ───────────
    # extensionAPI.js is NOT loaded at startup — only on demand.
    # The gateway chunk IS loaded at startup. By importing extensionAPI.js
    # here, we force it to load, which executes the /goal command
    # registration code that was appended to its end.
    print(f"  Appending startup trigger to {basename} ...")
    startup_trigger = build_startup_trigger_patch()
    source = source + "\n" + startup_trigger + "\n"

    # Verify all patches are present
    for marker, name in [
        (TEXT_CAPTURE_MARKER, "text capture"),
        (LIFECYCLE_MARKER, "lifecycle"),
        (STARTUP_TRIGGER_MARKER, "startup trigger"),
    ]:
        if marker not in source:
            print(f"  [ERROR] {name} patch marker missing after patching {basename}")
            sys.exit(1)

    with open(local_patched, "w", encoding="utf-8") as f:
        f.write(source)

    docker_cp_to(local_patched, filepath)
    docker_exec(f'chown node:node "{filepath}"')
    print(f"  [OK] Patched: {basename}")
    return True


# ── extensionAPI.js patching ─────────────────────────────────────────


def patch_extension_api(filepath):
    """Append command registration patch to extensionAPI.js."""
    basename = os.path.basename(filepath)
    local_original = f"/tmp/{basename}.original"
    local_patched = f"/tmp/{basename}.patched"

    print(f"\n  Patching {basename} for /goal command registration ...")
    docker_cp_from(filepath, local_original)

    with open(local_original, "r", encoding="utf-8") as f:
        source = f.read()

    if CMD_REG_MARKER in source:
        print(f"  [SKIP] {basename} already has command registration patch.")
        return False

    # Verify registerPluginCommand is defined in this file
    if "function registerPluginCommand" not in source:
        print(f"  [WARN] registerPluginCommand function not found in {basename}")
        print(f"  Command registration skipped — /goal will not be available in Telegram menu")
        return False

    # Create backup
    docker_exec(f'cp "{filepath}" "{filepath}{BACKUP_SUFFIX}"')
    print(f"  Backup created: {filepath}{BACKUP_SUFFIX}")

    # Append command registration
    cmd_reg_code = build_cmd_registration_patch()
    source = source + "\n" + cmd_reg_code + "\n"

    if CMD_REG_MARKER not in source:
        print(f"  [ERROR] Command registration marker missing after patching {basename}")
        sys.exit(1)

    with open(local_patched, "w", encoding="utf-8") as f:
        f.write(source)

    docker_cp_to(local_patched, filepath)
    docker_exec(f'chown node:node "{filepath}"')
    print(f"  [OK] Patched: {basename}")
    return True


# ── goal-monitor.mjs deployment ──────────────────────────────────────


def deploy_goal_monitor():
    """Copy goal-monitor.mjs into the container."""
    print("  Deploying goal-monitor.mjs to /app/goal-monitor.mjs ...")
    if not os.path.isfile(GOAL_MONITOR_SRC):
        print(f"[ERROR] Cannot find {GOAL_MONITOR_SRC}")
        sys.exit(1)
    docker_cp_to(GOAL_MONITOR_SRC, "/app/goal-monitor.mjs")
    docker_exec("chown node:node /app/goal-monitor.mjs")
    print("  [OK] goal-monitor.mjs deployed")


def create_initial_goal_store():
    """Create the initial empty goals.json if it doesn't exist."""
    gf = GOAL_FILE_PATH
    check = docker_exec(f"test -f {gf} && echo exists || echo missing", check=False)
    if "exists" in check:
        print("  goals.json already exists — skipping")
        return
    store = {"version": 1, "goals": []}
    docker_exec(f"mkdir -p $(dirname {gf})", check=False)
    data = json.dumps(store, indent=2)
    escaped = data.replace("'", "'\\''")
    docker_exec(f"echo '{escaped}' > {gf}", check=False)
    docker_exec(f"chown node:node {gf}", check=False)
    print("  [OK] Created initial goals.json")


# ── revert ───────────────────────────────────────────────────────────


def revert_patches(paths):
    """Restore all patched files from their backups."""
    all_files = list(paths["gateway_files"])
    if paths.get("extension_api"):
        all_files.append(paths["extension_api"])

    reverted = 0
    for filepath in all_files:
        backup = filepath + BACKUP_SUFFIX
        check = docker_exec(
            f'test -f "{backup}" && echo exists || echo missing', check=False
        )
        if "exists" in check:
            basename = os.path.basename(filepath)
            print(f"  Reverting {basename} from backup ...")
            docker_exec(f'cp "{backup}" "{filepath}"')
            docker_exec(f'chown node:node "{filepath}"')
            reverted += 1
        else:
            print(f"  No backup for {os.path.basename(filepath)} — skipping")

    if reverted:
        print(f"\n  Reverted {reverted} file(s).")
    else:
        print("\n  No backups found. Nothing to revert.")
    return reverted > 0


# ── verify ───────────────────────────────────────────────────────────


def verify_patches(paths):
    """Check if all patches are currently applied."""
    all_ok = True

    # Check gateway chunks
    for gf in paths["gateway_files"]:
        basename = os.path.basename(gf)
        for marker, name in [
            (TEXT_CAPTURE_MARKER, "text capture"),
            (LIFECYCLE_MARKER, "lifecycle"),
            (STARTUP_TRIGGER_MARKER, "startup trigger"),
        ]:
            count = docker_exec(
                f'grep -c "{marker}" "{gf}" 2>/dev/null || echo 0',
                check=False,
            )
            c = count.strip().split("\n")[-1]
            if c and int(c) > 0:
                print(f"  [OK] {name} patch in {basename}")
            else:
                print(f"  [MISSING] {name} patch in {basename}")
                all_ok = False

    # Check extensionAPI.js
    if paths.get("extension_api"):
        ext_api = paths["extension_api"]
        count = docker_exec(
            f'grep -c "{CMD_REG_MARKER}" "{ext_api}" 2>/dev/null || echo 0',
            check=False,
        )
        c = count.strip().split("\n")[-1]
        if c and int(c) > 0:
            print(f"  [OK] command registration patch in extensionAPI.js")
        else:
            print(f"  [MISSING] command registration patch in extensionAPI.js")
            all_ok = False

    # Check deployed files
    gm_check = docker_exec(
        "test -f /app/goal-monitor.mjs && echo exists || echo missing",
        check=False,
    )
    if "exists" in gm_check:
        print("  [OK] /app/goal-monitor.mjs exists")
    else:
        print("  [MISSING] /app/goal-monitor.mjs")
        all_ok = False

    goal_check = docker_exec(
        f"test -f {GOAL_FILE_PATH} && echo exists || echo missing",
        check=False,
    )
    if "exists" in goal_check:
        print(f"  [OK] {GOAL_FILE_PATH} exists")
    else:
        print(f"  [MISSING] {GOAL_FILE_PATH}")
        all_ok = False

    if all_ok:
        print("\n  All patches and files verified.")
    else:
        print("\n  Some patches or files are missing. Re-deploy with: python3 deploy.py")


# ── restart ──────────────────────────────────────────────────────────


def restart_container():
    """Restart the OpenClaw container."""
    print("\n[RESTART] Restarting OpenClaw container ...")
    run(f"docker restart {CONTAINER}")
    print("  Waiting 5 seconds for startup ...")
    time.sleep(5)
    status = run(f"docker ps --filter name={CONTAINER} --format '{{{{.Status}}}}'")
    print(f"  Container status: {status}")


# ── main ─────────────────────────────────────────────────────────────


def main():
    global CONTAINER

    parser = argparse.ArgumentParser(
        description="Deploy the Goal Monitor patch for OpenClaw",
    )
    parser.add_argument("--revert", action="store_true", help="Revert the patch")
    parser.add_argument("--verify", action="store_true", help="Check if patch is applied")
    parser.add_argument(
        "--container",
        default=CONTAINER,
        help=f"Docker container name (default: {CONTAINER})",
    )
    args = parser.parse_args()

    CONTAINER = args.container

    # Verify container is running
    status = run(
        f"docker inspect -f '{{{{.State.Running}}}}' {CONTAINER}",
        check=False,
    )
    if "true" not in status:
        print(f"[ERROR] Container '{CONTAINER}' is not running.")
        sys.exit(1)

    paths = discover_paths()

    if args.verify:
        verify_patches(paths)
        return

    if args.revert:
        if revert_patches(paths):
            restart_container()
        return

    # ── Full deploy ──────────────────────────────────────────────────

    print("\n" + "=" * 60)
    print("  Goal Monitor — Deploy & Patch (with AI Analysis Gate)")
    print("=" * 60)

    any_patched = False

    # Step 1: Patch gateway chunk(s) — text capture + lifecycle
    print("\n[PATCH] Patching gateway chunk(s) ...")
    for gf in paths["gateway_files"]:
        if patch_gateway_chunk(gf):
            any_patched = True

    # Step 2: Patch extensionAPI.js — command registration
    if paths.get("extension_api"):
        print("\n[PATCH] Patching extensionAPI.js ...")
        if patch_extension_api(paths["extension_api"]):
            any_patched = True
    else:
        print("\n[SKIP] extensionAPI.js not available — /goal command registration skipped")

    # Step 3: Deploy goal-monitor.mjs
    print("\n[DEPLOY] Deploying goal-monitor.mjs and goals.json ...")
    deploy_goal_monitor()
    create_initial_goal_store()

    # Step 4: Restart
    if any_patched:
        restart_container()
    else:
        print("\n[INFO] No patches applied (already patched). Skipping restart.")

    print("\n" + "=" * 60)
    print("  Deployment complete!")
    print("=" * 60)
    print(
        """
Next steps:
  1. Set a goal from Telegram:
     /goal Continue reverse engineering till all phases complete

  2. Send the agent a message to start working.

  3. When the agent finishes a turn, the goal monitor will:
     - Capture the agent's full response text
     - Send it to Claude for analysis against the active goal
     - Only continue if Claude says YES

  4. Monitor logs:
     docker logs openclaw -f --tail 50 2>&1 | grep goal-monitor

  5. Manage goals:
     /goal list
     /goal status
     /goal pause
"""
    )


if __name__ == "__main__":
    main()
