#!/usr/bin/env python3
"""
Goal Monitor — Deploy & Patch Script for OpenClaw
==================================================

Run this script on the DROPLET (not your local machine).

What it does:
  1. Copies goal-monitor.mjs into the OpenClaw container at /app/goal-monitor.mjs
  2. Discovers compiled chunk files in /app/dist/ by CONTENT search
     (not filenames — the bundler uses hashed names)
  3. Patches gateway chunk(s) with TWO hooks:
     a. Text capture — saves agent response text before buffer is cleared
     b. Lifecycle    — calls onTurnEnd() at turn end; references
                       enqueueSystemEvent & requestHeartbeatNow directly
                       (both are local variables in the same chunk)
  4. Patches extensionAPI.js to register /goal as a Telegram plugin command
     (registerPluginCommand is a top-level function in that file)
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
GOAL_MONITOR_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "goal-monitor.mjs")
GOAL_FILE_PATH = "/home/node/.openclaw/goals.json"

# Patch markers (used to detect existing patches and for --verify)
TEXT_CAPTURE_MARKER = "--- GOAL MONITOR: TEXT CAPTURE ---"
LIFECYCLE_MARKER = "--- GOAL MONITOR PATCH ---"
CMD_REG_MARKER = "--- GOAL MONITOR: COMMAND REGISTRATION ---"
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

    Uses bash -c with single-quote wrapping so globs and pipes
    are expanded by the container's shell, not the host's.
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
    """Find .js files in /app/dist/ containing a string pattern.

    Uses grep -rl with --include to avoid matching node_modules
    or non-JS files.
    """
    result = docker_exec(
        f'grep -rl "{pattern}" /app/dist/ --include="*.js" 2>/dev/null',
        check=False,
    )
    files = [p.strip() for p in result.splitlines() if p.strip() and p.endswith(".js")]
    # Exclude node_modules and test files
    return [f for f in files if "/node_modules/" not in f and ".test." not in f]


def discover_paths():
    """Discover all required file paths by content search in /app/dist/.

    Returns dict with:
      gateway_files  — list of chunk files containing the chat lifecycle code
      extension_api  — path to extensionAPI.js (for /goal command registration)
    """
    print("[1] Discovering compiled files in /app/dist/...")

    # ── Gateway chunk(s) ─────────────────────────────────────────
    # The gateway chunk contains chatRunState, emitChatFinal,
    # clearAgentRunContext, enqueueSystemEvent, requestHeartbeatNow
    # — all as local variables/functions in the same file.
    gateway_candidates = find_dist_files_containing("chatRunState")
    if not gateway_candidates:
        print("[ERROR] Could not find any file containing 'chatRunState' in /app/dist/")
        sys.exit(1)

    # Prefer files matching the known "gateway-cli" naming pattern
    gateway_files = [f for f in gateway_candidates if "gateway-cli" in f]
    if not gateway_files:
        # Fallback: take any dist-level JS file with chatRunState
        gateway_files = gateway_candidates

    for gf in gateway_files:
        print(f"  Gateway chunk: {gf}")

    # Verify that key functions exist in each gateway chunk
    required_fns = [
        "emitChatFinal",
        "clearAgentRunContext",
        "enqueueSystemEvent",
        "requestHeartbeatNow",
    ]
    for gf in gateway_files:
        missing = []
        for fn_name in required_fns:
            count = docker_exec(
                f'grep -c "{fn_name}" "{gf}" 2>/dev/null || echo 0',
                check=False,
            ).strip().split("\n")[-1]
            if count == "0":
                missing.append(fn_name)
        if missing:
            print(f"  [WARN] Missing in {os.path.basename(gf)}: {', '.join(missing)}")

    # ── extensionAPI.js ──────────────────────────────────────────
    # Stable filename (no hash). Contains registerPluginCommand as
    # a top-level function definition.
    ext_api = "/app/dist/extensionAPI.js"
    ext_check = docker_exec(
        f'test -f {ext_api} && echo exists || echo missing',
        check=False,
    )
    if "exists" not in ext_check:
        # Fallback: find by content
        candidates = find_dist_files_containing("registerPluginCommand")
        if candidates:
            ext_api = candidates[0]
            print(f"  [INFO] extensionAPI.js not at expected path, using: {ext_api}")
        else:
            print("  [WARN] registerPluginCommand not found — /goal command won't register")
            ext_api = None
    else:
        # Double-check it actually has the function
        fn_check = docker_exec(
            f'grep -c "registerPluginCommand" "{ext_api}" 2>/dev/null || echo 0',
            check=False,
        ).strip().split("\n")[-1]
        if fn_check == "0":
            print("  [WARN] extensionAPI.js exists but doesn't contain registerPluginCommand")
            ext_api = None
        else:
            print(f"  Extension API: {ext_api}")

    return {
        "gateway_files": gateway_files,
        "extension_api": ext_api,
    }


# ── patch builders ───────────────────────────────────────────────────

def build_text_capture_patch():
    """Build the text capture code inserted inside emitChatFinal.

    This saves the agent's response text (and the sessionKey) to
    globalThis.__gmLastResponse BEFORE the buffer is cleared.
    The lifecycle patch reads it later.
    """
    return (
        f'    // {TEXT_CAPTURE_MARKER}\n'
        f'    globalThis.__gmLastResponse = {{ text: text, sessionKey: sessionKey, ts: Date.now() }};\n'
        f'    // --- END GOAL MONITOR: TEXT CAPTURE ---'
    )


def build_lifecycle_patch():
    """Build the lifecycle patch code (inserted after clearAgentRunContext).

    References enqueueSystemEvent and requestHeartbeatNow DIRECTLY
    since they are local variables in the same gateway chunk file.
    Only one dynamic import is needed: goal-monitor.mjs itself.
    """
    indent = "    "
    lines = [
        f"// {LIFECYCLE_MARKER}",
        f'if (lifecyclePhase === "end" && !isAborted) {{',
        f'  const __gmData = globalThis.__gmLastResponse;',
        f'  if (__gmData && Date.now() - __gmData.ts < 10000) {{',
        f'    import("/app/goal-monitor.mjs").then((gm) => {{',
        f'      gm.onTurnEnd(__gmData.sessionKey || sessionKey, __gmData.text || "", {{',
        f'        enqueueSystemEvent,',
        f'        requestHeartbeatNow',
        f'      }});',
        f'    }}).catch(() => {{}});',
        f'  }}',
        f'}}',
        f'// --- END GOAL MONITOR PATCH ---',
    ]
    return "\n".join(indent + line for line in lines)


def build_cmd_registration_patch():
    """Build the command registration code (appended to extensionAPI.js).

    registerPluginCommand is a top-level function defined in the same
    file (extensionAPI.js), so it's directly accessible — no imports needed
    except for goal-monitor.mjs itself.
    """
    lines = [
        f"// {CMD_REG_MARKER}",
        'import("/app/goal-monitor.mjs").then((gm) => {',
        '  if (typeof gm.registerGoalCommand === "function") {',
        '    gm.registerGoalCommand(registerPluginCommand);',
        '  }',
        '}).catch((err) => {',
        '  console.error("[goal-monitor] /goal command registration failed:", err?.message || String(err));',
        '});',
        '// --- END GOAL MONITOR: COMMAND REGISTRATION ---',
    ]
    return "\n".join(lines)


# ── patch application ────────────────────────────────────────────────

def apply_gateway_patches(gateway_file):
    """Apply text capture and lifecycle patches to a gateway chunk file.

    Returns True if patches were applied, False if already patched.
    """
    local_original = "/tmp/gateway-original.js"
    local_patched = "/tmp/gateway-patched.js"
    docker_cp_from(gateway_file, local_original)

    with open(local_original, "r", encoding="utf-8") as f:
        source = f.read()

    # Check if already patched
    if TEXT_CAPTURE_MARKER in source or LIFECYCLE_MARKER in source:
        print(f"  [SKIP] Already patched — use --revert first to re-patch")
        return False

    # Create backup
    print(f"  Creating backup...")
    docker_exec(f'cp "{gateway_file}" "{gateway_file}{BACKUP_SUFFIX}"')

    # ── PATCH 1: Text Capture (inside emitChatFinal) ─────────────
    #
    # Target pattern in the compiled code:
    #   const text = chatRunState.buffers.get(clientRunId)?.trim() ?? "";
    #   chatRunState.buffers.delete(clientRunId);
    #
    # We insert between these two lines to capture text before it's gone.

    print(f"  Applying text capture patch...")

    tc_pattern = re.compile(
        r'((?:const|let|var)\s+(\w+)\s*=\s*chatRunState\.buffers\.get\(clientRunId\).*?;)'
        r'(\s*\n)'
        r'(\s*chatRunState\.buffers\.delete\(clientRunId\)\s*;)',
        re.DOTALL,
    )

    tc_match = tc_pattern.search(source)
    if not tc_match:
        # Fallback: simpler pattern (no variable capture)
        tc_fallback = re.compile(
            r'(chatRunState\.buffers\.get\(clientRunId\).*?;\s*\n)'
            r'(\s*)(chatRunState\.buffers\.delete\(clientRunId\)\s*;)',
            re.DOTALL,
        )
        tc_match = tc_fallback.search(source)
        if not tc_match:
            print("[ERROR] Could not find chatRunState.buffers.get/delete pattern")
            print("  The compiled code structure may have changed.")
            sys.exit(1)

        # Fallback insertion: before buffers.delete
        insert_pos = tc_match.start(3)
        capture_code = build_text_capture_patch()
        source = source[:insert_pos] + capture_code + "\n" + source[insert_pos:]
    else:
        # Primary insertion: between the buffer read and the delete
        text_var = tc_match.group(2)  # captured variable name (usually 'text')
        insert_pos = tc_match.end(1) + len(tc_match.group(3))
        capture_code = build_text_capture_patch().replace(
            "text: text,", f"text: {text_var},"
        )
        source = source[:insert_pos] + capture_code + "\n" + source[insert_pos:]

    # ── PATCH 2: Lifecycle Handler (after clearAgentRunContext) ───
    #
    # Target pattern in the compiled code:
    #   if (lifecyclePhase === "end" || lifecyclePhase === "error") {
    #       toolEventRecipients.markFinal(evt.runId);
    #       clearAgentRunContext(evt.runId);
    #   }
    #
    # We insert after clearAgentRunContext(evt.runId); to hook into
    # the lifecycle end. enqueueSystemEvent and requestHeartbeatNow are
    # local variables in the same chunk, so we reference them directly.

    print(f"  Applying lifecycle patch...")

    lc_pattern = re.compile(
        r'(clearAgentRunContext\s*\([^)]*\)\s*;)',
        re.MULTILINE,
    )
    lc_matches = list(lc_pattern.finditer(source))

    if not lc_matches:
        print("[ERROR] Could not find clearAgentRunContext call")
        sys.exit(1)

    # Find the CORRECT clearAgentRunContext call — the one in the
    # lifecycle block that follows toolEventRecipients.markFinal.
    # This is the main lifecycle handler (around lines 2157-2160
    # in the unpatched file).
    target_match = None

    # Strategy 1: look for toolEventRecipients.markFinal nearby
    for m in lc_matches:
        context_before = source[max(0, m.start() - 300):m.start()]
        if "toolEventRecipients.markFinal" in context_before:
            target_match = m
            break

    # Strategy 2: look for lifecyclePhase === "end" nearby
    if not target_match:
        for m in lc_matches:
            context_before = source[max(0, m.start() - 300):m.start()]
            if 'lifecyclePhase === "end"' in context_before:
                target_match = m
                break

    # Strategy 3: last match in the first third of the file
    if not target_match:
        first_third = len(source) // 3
        for m in reversed(lc_matches):
            if m.start() < first_third:
                target_match = m
                break

    if not target_match:
        target_match = lc_matches[-1]
        print(f"  [WARN] Using fallback clearAgentRunContext match at offset {target_match.start()}")

    insert_pos = target_match.end()
    lifecycle_code = build_lifecycle_patch()
    source = source[:insert_pos] + "\n" + lifecycle_code + "\n" + source[insert_pos:]

    # Verify both patches are present
    for marker, name in [
        (TEXT_CAPTURE_MARKER, "text capture"),
        (LIFECYCLE_MARKER, "lifecycle"),
    ]:
        if marker not in source:
            print(f"[ERROR] {name} patch marker missing after patching")
            sys.exit(1)

    with open(local_patched, "w", encoding="utf-8") as f:
        f.write(source)

    docker_cp_to(local_patched, gateway_file)
    docker_exec(f'chown node:node "{gateway_file}"')
    print(f"  Patched {os.path.basename(gateway_file)}")
    return True


def apply_cmd_registration(ext_api_file):
    """Append /goal command registration to extensionAPI.js.

    registerPluginCommand is a function defined in this same file,
    so it's directly accessible from the appended code.

    Returns True if patch was applied, False if already patched or skipped.
    """
    if not ext_api_file:
        print("  [SKIP] No extensionAPI.js found — /goal command not registered")
        return False

    local_original = "/tmp/extapi-original.js"
    local_patched = "/tmp/extapi-patched.js"
    docker_cp_from(ext_api_file, local_original)

    with open(local_original, "r", encoding="utf-8") as f:
        source = f.read()

    if CMD_REG_MARKER in source:
        print(f"  [SKIP] Already patched — use --revert first to re-patch")
        return False

    # Create backup
    print(f"  Creating backup...")
    docker_exec(f'cp "{ext_api_file}" "{ext_api_file}{BACKUP_SUFFIX}"')

    # Append registration code
    cmd_code = build_cmd_registration_patch()
    source = source + "\n" + cmd_code + "\n"

    with open(local_patched, "w", encoding="utf-8") as f:
        f.write(source)

    docker_cp_to(local_patched, ext_api_file)
    docker_exec(f'chown node:node "{ext_api_file}"')
    print(f"  Patched {os.path.basename(ext_api_file)}")
    return True


# ── goal-monitor.mjs deployment ──────────────────────────────────────

def deploy_goal_monitor():
    """Copy goal-monitor.mjs into the container."""
    print("  Deploying goal-monitor.mjs to /app/goal-monitor.mjs...")
    if not os.path.isfile(GOAL_MONITOR_SRC):
        print(f"[ERROR] Cannot find {GOAL_MONITOR_SRC}")
        sys.exit(1)
    docker_cp_to(GOAL_MONITOR_SRC, "/app/goal-monitor.mjs")
    docker_exec("chown node:node /app/goal-monitor.mjs")


def create_initial_goal_store():
    """Create the initial empty goals.json if it doesn't exist."""
    gf = GOAL_FILE_PATH
    check = docker_exec(f"test -f {gf} && echo exists || echo missing", check=False)
    if "exists" in check:
        print("  goals.json already exists — skipping")
        return
    store = {"version": 1, "goals": []}
    docker_exec(
        f"python3 -c \""
        f"import json; "
        f"open('{gf}','w').write(json.dumps({json.dumps(store)},indent=2))"
        f"\"",
        check=False,
    )
    check2 = docker_exec(f"test -f {gf} && echo exists || echo missing", check=False)
    if "missing" in check2:
        docker_exec(f"mkdir -p $(dirname {gf})")
        data = json.dumps(store, indent=2)
        escaped = data.replace("'", "'\\''")
        docker_exec(f"echo '{escaped}' > {gf}")
    docker_exec(f"chown node:node {gf}", check=False)
    print("  Created initial goals.json")


# ── revert ───────────────────────────────────────────────────────────

def revert_patches(paths):
    """Restore all patched files from their backups."""
    files_to_revert = list(paths["gateway_files"])
    if paths.get("extension_api"):
        files_to_revert.append(paths["extension_api"])

    any_reverted = False
    for f in files_to_revert:
        backup = f + BACKUP_SUFFIX
        check = docker_exec(
            f'test -f "{backup}" && echo exists || echo missing',
            check=False,
        )
        if "exists" in check:
            print(f"  Reverting {os.path.basename(f)} from backup...")
            docker_exec(f'cp "{backup}" "{f}"')
            docker_exec(f'chown node:node "{f}"')
            any_reverted = True
        else:
            print(f"  No backup for {os.path.basename(f)}")

    if any_reverted:
        print("  Reverted successfully.")
    else:
        print("  [WARN] No backups found to revert.")


# ── verify ───────────────────────────────────────────────────────────

def verify_patches(paths):
    """Check if all patches are currently applied."""
    all_ok = True

    # Check gateway patches
    for gf in paths["gateway_files"]:
        basename = os.path.basename(gf)
        for marker, name in [
            (TEXT_CAPTURE_MARKER, "text capture"),
            (LIFECYCLE_MARKER, "lifecycle"),
        ]:
            count = docker_exec(
                f'grep -c "{marker}" "{gf}" 2>/dev/null || echo 0',
                check=False,
            ).strip().split("\n")[-1]
            if count and int(count) > 0:
                print(f"  [OK] {name} patch in {basename}")
            else:
                print(f"  [MISSING] {name} patch in {basename}")
                all_ok = False

    # Check command registration
    ext_api = paths.get("extension_api")
    if ext_api:
        count = docker_exec(
            f'grep -c "{CMD_REG_MARKER}" "{ext_api}" 2>/dev/null || echo 0',
            check=False,
        ).strip().split("\n")[-1]
        if count and int(count) > 0:
            print(f"  [OK] command registration in {os.path.basename(ext_api)}")
        else:
            print(f"  [MISSING] command registration in {os.path.basename(ext_api)}")
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
        print("\n  Some items missing. Re-deploy: python3 deploy.py")


# ── restart ──────────────────────────────────────────────────────────

def restart_container():
    """Restart the OpenClaw container."""
    print("\nRestarting OpenClaw container...")
    run(f"docker restart {CONTAINER}")
    print("  Waiting 5 seconds for startup...")
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
        "--container", default=CONTAINER,
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
        revert_patches(paths)
        restart_container()
        return

    # ── Full deploy ──────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("  Goal Monitor — Deploy & Patch (with AI Analysis Gate)")
    print("=" * 60)

    # Step: Deploy goal-monitor.mjs first (patches import it)
    print("\n[2] Deploying goal-monitor.mjs...")
    deploy_goal_monitor()
    create_initial_goal_store()

    # Step: Patch gateway chunk(s)
    any_patched = False
    for i, gf in enumerate(paths["gateway_files"]):
        print(f"\n[{3 + i}] Patching gateway chunk: {os.path.basename(gf)}")
        if apply_gateway_patches(gf):
            any_patched = True

    # Step: Patch extensionAPI.js for /goal command
    print(f"\n[{3 + len(paths['gateway_files'])}] Registering /goal command...")
    if apply_cmd_registration(paths.get("extension_api")):
        any_patched = True

    # Step: Restart
    if any_patched:
        restart_container()
    else:
        print("\n[INFO] No new patches applied (already patched).")
        print("  Use --revert first if you need to re-patch.")

    print("\n" + "=" * 60)
    print("  Deployment complete!")
    print("=" * 60)
    print("""
Next steps:
  1. Set a goal from Telegram:
     /goal Continue reverse engineering till all phases complete

  2. Send the agent a message to start working.

  3. When the agent finishes a turn, the goal monitor will:
     - Capture the agent's response text
     - Send it to Claude for analysis against the active goal
     - Only continue if Claude says YES

  4. Monitor logs:
     docker logs openclaw -f --tail 50 2>&1 | grep goal-monitor

  5. Manage goals:
     /goal list
     /goal status
     /goal pause
""")


if __name__ == "__main__":
    main()
