#!/usr/bin/env python3
"""
Goal Monitor — Deploy & Patch Script for OpenClaw
==================================================

Run this script on the DROPLET (not your local machine).

What it does:
  1. Copies goal-monitor.mjs into the OpenClaw container at /app/goal-monitor.mjs
  2. Finds compiled source files inside the container
  3. Patches server-chat.js with THREE hooks:
     a. Text capture    — saves agent response text before buffer is cleared
     b. Lifecycle patch — calls onTurnEnd() with response text at turn end
     c. Cmd registration— registers /goal as a Telegram plugin command
  4. Creates the initial goals.json store
  5. Restarts the OpenClaw container

Usage:
  cd /opt/cursor-proxy-patched/goal-monitor
  python3 deploy.py             # apply the patch
  python3 deploy.py --revert    # revert the patch (restores backup)
  python3 deploy.py --verify    # check if the patch is applied
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import PurePosixPath

CONTAINER = "openclaw"
GOAL_MONITOR_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "goal-monitor.mjs")
GOAL_FILE_PATH = "/home/node/.openclaw/goals.json"

# Patch markers (used to detect if already patched and for --verify)
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


def docker_exec(cmd, user="root", check=True):
    """Run a command inside the OpenClaw container."""
    return run(f'docker exec -u {user} {CONTAINER} bash -c "{cmd}"', check=check)


def docker_cp_to(local_path, container_path):
    """Copy a file from host into the container."""
    run(f"docker cp {local_path} {CONTAINER}:{container_path}")


def docker_cp_from(container_path, local_path):
    """Copy a file from the container to host."""
    run(f"docker cp {CONTAINER}:{container_path} {local_path}")


# ── discovery ────────────────────────────────────────────────────────

def find_file_in_container(pattern, hint_path=""):
    """Find a file inside the container by name pattern."""
    extra = f"-path '*{hint_path}*'" if hint_path else ""
    result = docker_exec(
        f"find /app -name '{pattern}' {extra} 2>/dev/null | head -5",
        check=False,
    )
    return [p.strip() for p in result.splitlines() if p.strip()]


def discover_paths():
    """Discover all required file paths inside the container."""
    print("[1/7] Discovering file paths inside the OpenClaw container...")

    # server-chat.js
    candidates = find_file_in_container("server-chat.js", "gateway")
    if not candidates:
        candidates = find_file_in_container("server-chat.cjs", "gateway")
    if not candidates:
        print("[ERROR] Could not find server-chat.js")
        sys.exit(1)
    server_chat = candidates[0]
    print(f"  server-chat.js      -> {server_chat}")

    # system-events.js
    candidates = find_file_in_container("system-events.js", "infra")
    if not candidates:
        candidates = find_file_in_container("system-events.cjs", "infra")
    if not candidates:
        print("[ERROR] Could not find system-events.js")
        sys.exit(1)
    system_events = candidates[0]
    print(f"  system-events       -> {system_events}")

    # heartbeat-wake.js
    candidates = find_file_in_container("heartbeat-wake.js", "infra")
    if not candidates:
        candidates = find_file_in_container("heartbeat-wake.cjs", "infra")
    if not candidates:
        print("[ERROR] Could not find heartbeat-wake.js")
        sys.exit(1)
    heartbeat_wake = candidates[0]
    print(f"  heartbeat-wake      -> {heartbeat_wake}")

    # plugins/commands.js
    candidates = find_file_in_container("commands.js", "plugins")
    if not candidates:
        candidates = find_file_in_container("commands.cjs", "plugins")
    if not candidates:
        print("[ERROR] Could not find plugins/commands.js")
        sys.exit(1)
    plugins_commands = None
    for c in candidates:
        if "plugins" in c:
            plugins_commands = c
            break
    if not plugins_commands:
        plugins_commands = candidates[0]
    print(f"  plugins/commands    -> {plugins_commands}")

    return {
        "server_chat": server_chat,
        "system_events": system_events,
        "heartbeat_wake": heartbeat_wake,
        "plugins_commands": plugins_commands,
    }


def compute_relative_path(from_file, to_file):
    """Compute a POSIX relative path from one file's directory to another."""
    from_dir = str(PurePosixPath(from_file).parent)
    to_path = str(PurePosixPath(to_file))
    from_parts = from_dir.strip("/").split("/")
    to_parts = to_path.strip("/").split("/")
    common = 0
    for a, b in zip(from_parts, to_parts):
        if a == b:
            common += 1
        else:
            break
    ups = len(from_parts) - common
    remainder = to_parts[common:]
    rel = "/".join([".."] * ups + remainder) if ups else "/".join(remainder)
    if not rel.startswith("."):
        rel = "./" + rel
    return rel


# ── patching ─────────────────────────────────────────────────────────

def build_text_capture_patch():
    """Build the text capture code inserted inside emitChatFinal.

    This saves the agent's response text to globalThis.__gmLastResponse
    BEFORE the buffer is cleared. The lifecycle patch reads it later.
    """
    return (
        f'    // {TEXT_CAPTURE_MARKER}\n'
        f'    globalThis.__gmLastResponse = {{ text: text, sessionKey: sessionKey, ts: Date.now() }};\n'
        f'    // --- END GOAL MONITOR: TEXT CAPTURE ---'
    )


def build_lifecycle_patch(rel_sys_events, rel_heartbeat):
    """Build the lifecycle patch code (inserted after clearAgentRunContext).

    Reads the captured response text from globalThis and passes it to
    goal-monitor's onTurnEnd along with the session key.
    No session filtering — works for ALL sessions.
    """
    indent = "    "
    lines = [
        f"// {LIFECYCLE_MARKER}",
        f'if (lifecyclePhase === "end" && !isAborted) {{',
        f'  const __gmData = globalThis.__gmLastResponse;',
        f'  if (__gmData && Date.now() - __gmData.ts < 10000) {{',
        f'    const __gmText = __gmData.text || "";',
        f'    const __gmSession = __gmData.sessionKey || sessionKey;',
        f'    Promise.all([',
        f'      import("/app/goal-monitor.mjs"),',
        f'      import("{rel_sys_events}"),',
        f'      import("{rel_heartbeat}")',
        f'    ]).then(([gm, se, hb]) => {{',
        f'      gm.onTurnEnd(__gmSession, __gmText, {{',
        f'        enqueueSystemEvent: se.enqueueSystemEvent,',
        f'        requestHeartbeatNow: hb.requestHeartbeatNow',
        f'      }});',
        f'    }}).catch(() => {{}});',
        f'  }}',
        f'}}',
        f'// --- END GOAL MONITOR PATCH ---',
    ]
    return "\n".join(indent + line for line in lines)


def build_cmd_registration_patch(rel_plugins_commands):
    """Build the command registration code (appended to end of file)."""
    lines = [
        f"// {CMD_REG_MARKER}",
        "Promise.all([",
        '  import("/app/goal-monitor.mjs"),',
        f'  import("{rel_plugins_commands}")',
        "]).then(([gm, pc]) => {",
        "  if (typeof gm.registerGoalCommand === 'function' &&",
        "      typeof pc.registerPluginCommand === 'function') {",
        "    gm.registerGoalCommand(pc.registerPluginCommand);",
        "  }",
        "}).catch((err) => {",
        '  console.error("[goal-monitor] /goal command registration failed:", err?.message || String(err));',
        "});",
        "// --- END GOAL MONITOR: COMMAND REGISTRATION ---",
    ]
    return "\n".join(lines)


def apply_patch(paths):
    """Extract, patch, and re-deploy server-chat.js."""
    server_chat = paths["server_chat"]

    # Compute relative import paths
    rel_se = compute_relative_path(server_chat, paths["system_events"])
    rel_hb = compute_relative_path(server_chat, paths["heartbeat_wake"])
    rel_pc = compute_relative_path(server_chat, paths["plugins_commands"])

    print(f"\n[2/7] Extracting {server_chat} from container...")
    local_original = "/tmp/server-chat-original.js"
    local_patched = "/tmp/server-chat-patched.js"
    docker_cp_from(server_chat, local_original)

    with open(local_original, "r", encoding="utf-8") as f:
        source = f.read()

    # Check if already patched
    if LIFECYCLE_MARKER in source or TEXT_CAPTURE_MARKER in source or CMD_REG_MARKER in source:
        print("  [WARN] File already has patches. Use --revert first to re-patch.")
        return False

    # Create backup
    print(f"[3/7] Creating backup at {server_chat}{BACKUP_SUFFIX}...")
    docker_exec(f"cp {server_chat} {server_chat}{BACKUP_SUFFIX}")

    # ── PATCH 1: Text Capture (inside emitChatFinal) ─────────────────
    # Find: chatRunState.buffers.delete(clientRunId)
    # Insert BEFORE it: save text to globalThis.__gmLastResponse
    print("[4/7] Applying text capture patch (inside emitChatFinal)...")

    # The pattern in emitChatFinal:
    #   const text = chatRunState.buffers.get(clientRunId)?.trim() ?? "";
    #   chatRunState.buffers.delete(clientRunId);
    # We insert between these two lines.
    text_capture_pattern = re.compile(
        r'((?:const|let|var)\s+(\w+)\s*=\s*chatRunState\.buffers\.get\(clientRunId\).*?;)'
        r'(\s*\n)'
        r'(\s*chatRunState\.buffers\.delete\(clientRunId\)\s*;)',
        re.DOTALL,
    )

    tc_match = text_capture_pattern.search(source)
    if not tc_match:
        # Fallback: try simpler pattern
        tc_fallback = re.compile(
            r'(chatRunState\.buffers\.get\(clientRunId\).*?;\s*\n)'
            r'(\s*)(chatRunState\.buffers\.delete\(clientRunId\)\s*;)',
            re.DOTALL,
        )
        tc_match = tc_fallback.search(source)
        if not tc_match:
            print("[ERROR] Could not find chatRunState.buffers.get/delete pattern")
            print("  The compiled code structure may differ from expected.")
            sys.exit(1)

        # Fallback insertion: before buffers.delete
        insert_pos = tc_match.start(3)
        text_var = "text"  # assume variable is named 'text'
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

    # ── PATCH 2: Lifecycle Handler (after clearAgentRunContext) ───────
    print("[5/7] Applying lifecycle patch (after clearAgentRunContext)...")

    lifecycle_pattern = re.compile(
        r'(clearAgentRunContext\s*\(\s*evt\.runId\s*\)\s*;)',
        re.MULTILINE,
    )
    lc_matches = list(lifecycle_pattern.finditer(source))
    if not lc_matches:
        lifecycle_pattern2 = re.compile(
            r'(clearAgentRunContext\([^)]*\)\s*;)', re.MULTILINE
        )
        lc_matches = list(lifecycle_pattern2.finditer(source))

    if not lc_matches:
        print("[ERROR] Could not find clearAgentRunContext in server-chat.js")
        sys.exit(1)

    lc_match = lc_matches[-1]
    insert_pos = lc_match.end()
    lifecycle_code = build_lifecycle_patch(rel_se, rel_hb)
    source = source[:insert_pos] + "\n" + lifecycle_code + "\n" + source[insert_pos:]

    # ── PATCH 3: Command Registration (appended to end) ──────────────
    print("[6/7] Applying command registration patch (appended)...")
    cmd_reg_code = build_cmd_registration_patch(rel_pc)
    source = source + "\n" + cmd_reg_code + "\n"

    # Verify all patches present
    for marker, name in [
        (TEXT_CAPTURE_MARKER, "text capture"),
        (LIFECYCLE_MARKER, "lifecycle"),
        (CMD_REG_MARKER, "command registration"),
    ]:
        if marker not in source:
            print(f"[ERROR] {name} patch marker missing after patching")
            sys.exit(1)

    with open(local_patched, "w", encoding="utf-8") as f:
        f.write(source)

    # Copy back
    docker_cp_to(local_patched, server_chat)
    docker_exec(f"chown node:node {server_chat}")

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

def revert_patch(paths):
    """Restore server-chat.js from the backup."""
    server_chat = paths["server_chat"]
    backup = server_chat + BACKUP_SUFFIX

    check = docker_exec(f"test -f {backup} && echo exists || echo missing", check=False)
    if "exists" not in check:
        print(f"[ERROR] No backup found at {backup}")
        sys.exit(1)

    print(f"Reverting {server_chat} from backup...")
    docker_exec(f"cp {backup} {server_chat}")
    docker_exec(f"chown node:node {server_chat}")
    print("Reverted successfully.")


# ── verify ───────────────────────────────────────────────────────────

def verify_patch(paths):
    """Check if all patches are currently applied."""
    server_chat = paths["server_chat"]

    markers = {
        "text capture": TEXT_CAPTURE_MARKER,
        "lifecycle": LIFECYCLE_MARKER,
        "command registration": CMD_REG_MARKER,
    }

    all_ok = True
    for name, marker in markers.items():
        check = docker_exec(
            f"grep -c '{marker}' {server_chat} 2>/dev/null || echo 0",
            check=False,
        )
        count = check.strip().split("\n")[-1]
        if count and int(count) > 0:
            print(f"  [OK] {name} patch applied")
        else:
            print(f"  [MISSING] {name} patch NOT applied")
            all_ok = False

    # Check files
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
    print("[7/7] Restarting OpenClaw container...")
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
        verify_patch(paths)
        return

    if args.revert:
        revert_patch(paths)
        restart_container()
        return

    # Full deploy
    print("\n" + "=" * 60)
    print("  Goal Monitor — Deploy & Patch (with AI Analysis Gate)")
    print("=" * 60 + "\n")

    patched = apply_patch(paths)
    deploy_goal_monitor()
    create_initial_goal_store()

    if patched:
        restart_container()
    else:
        print("\n[INFO] No restart needed (already patched).")

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
