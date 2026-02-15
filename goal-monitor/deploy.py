#!/usr/bin/env python3
"""
Goal Monitor — Deploy & Patch Script for OpenClaw
==================================================

Run this script on the DROPLET (not your local machine).

What it does:
  1. Copies goal-monitor.mjs into the OpenClaw container at /app/goal-monitor.mjs
  2. Finds the compiled server-chat.js inside the container
  3. Discovers relative import paths for OpenClaw's internal modules
  4. Patches server-chat.js with TWO hooks:
     a. Lifecycle patch — calls onTurnEnd() when agent finishes a turn
     b. Command registration — registers /goal as a plugin command for Telegram
  5. Creates the initial goals.json store
  6. Fixes file permissions (node user)
  7. Restarts the OpenClaw container

Usage:
  cd /opt/cursor-proxy-patched/goal-monitor
  python3 deploy.py             # apply the patch
  python3 deploy.py --revert    # revert the patch (restores backup)
  python3 deploy.py --verify    # check if the patch is applied

Prerequisites:
  - Docker must be running
  - Container named "openclaw" must exist
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
LIFECYCLE_MARKER = "--- GOAL MONITOR PATCH ---"
CMD_REG_MARKER = "--- GOAL MONITOR: COMMAND REGISTRATION ---"
BACKUP_SUFFIX = ".goal-monitor-backup"


# ── helpers ──────────────────────────────────────────────────────────

def run(cmd, capture=True, check=True):
    """Run a shell command and return stdout."""
    result = subprocess.run(
        cmd, shell=True, capture_output=capture, text=True,
    )
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
    paths = [p.strip() for p in result.splitlines() if p.strip()]
    return paths


def discover_paths():
    """Discover all required file paths inside the container."""
    print("[1/8] Discovering file paths inside the OpenClaw container...")

    # server-chat.js
    candidates = find_file_in_container("server-chat.js", "gateway")
    if not candidates:
        candidates = find_file_in_container("server-chat.cjs", "gateway")
    if not candidates:
        print("[ERROR] Could not find server-chat.js in the container.")
        print("  Searched: /app/**/gateway/server-chat.{js,cjs}")
        sys.exit(1)
    server_chat = candidates[0]
    print(f"  server-chat.js      → {server_chat}")

    # system-events.js
    candidates = find_file_in_container("system-events.js", "infra")
    if not candidates:
        candidates = find_file_in_container("system-events.cjs", "infra")
    if not candidates:
        print("[ERROR] Could not find system-events.js")
        sys.exit(1)
    system_events = candidates[0]
    print(f"  system-events       → {system_events}")

    # heartbeat-wake.js
    candidates = find_file_in_container("heartbeat-wake.js", "infra")
    if not candidates:
        candidates = find_file_in_container("heartbeat-wake.cjs", "infra")
    if not candidates:
        print("[ERROR] Could not find heartbeat-wake.js")
        sys.exit(1)
    heartbeat_wake = candidates[0]
    print(f"  heartbeat-wake      → {heartbeat_wake}")

    # main-session.js
    candidates = find_file_in_container("main-session.js", "sessions")
    if not candidates:
        candidates = find_file_in_container("main-session.js", "config")
    if not candidates:
        candidates = find_file_in_container("main-session.cjs", "sessions")
    if not candidates:
        candidates = find_file_in_container("sessions.js", "config")
    if not candidates:
        print("[ERROR] Could not find main-session.js or sessions.js")
        sys.exit(1)
    main_session = candidates[0]
    print(f"  main-session        → {main_session}")

    # plugins/commands.js (for /goal command registration)
    candidates = find_file_in_container("commands.js", "plugins")
    if not candidates:
        candidates = find_file_in_container("commands.cjs", "plugins")
    if not candidates:
        print("[ERROR] Could not find plugins/commands.js")
        print("  Searched: /app/**/plugins/commands.{js,cjs}")
        sys.exit(1)
    # Filter to get the right one (there may be other commands.js files)
    plugins_commands = None
    for c in candidates:
        if "plugins" in c and "commands" in c:
            plugins_commands = c
            break
    if not plugins_commands:
        plugins_commands = candidates[0]
    print(f"  plugins/commands    → {plugins_commands}")

    return {
        "server_chat": server_chat,
        "system_events": system_events,
        "heartbeat_wake": heartbeat_wake,
        "main_session": main_session,
        "plugins_commands": plugins_commands,
    }


def compute_relative_path(from_file, to_file):
    """Compute a POSIX relative path from one file's directory to another file."""
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

def build_lifecycle_patch(rel_sys_events, rel_heartbeat, rel_main_session):
    """Build the lifecycle patch code (inserted after clearAgentRunContext).

    Every line is pre-indented with 4 spaces to align with the
    surrounding if-block inside the compiled server-chat.js.
    """
    indent = "    "
    lines = [
        f"// {LIFECYCLE_MARKER}",
        f'if (lifecyclePhase === "end" && !isAborted && sessionKey) {{',
        f'  Promise.all([',
        f'    import("/app/goal-monitor.mjs"),',
        f'    import("{rel_sys_events}"),',
        f'    import("{rel_heartbeat}"),',
        f'    import("{rel_main_session}")',
        f'  ]).then(([gm, se, hb, ms]) => {{',
        f'    gm.onTurnEnd(sessionKey, {{',
        f'      enqueueSystemEvent: se.enqueueSystemEvent,',
        f'      requestHeartbeatNow: hb.requestHeartbeatNow,',
        f'      resolveMainSessionKeyFromConfig: ms.resolveMainSessionKeyFromConfig',
        f'    }});',
        f'  }}).catch(() => {{}});',
        f'}}',
        f'// --- END GOAL MONITOR PATCH ---',
    ]
    return "\n".join(indent + line for line in lines)


def build_cmd_registration_patch(rel_plugins_commands):
    """Build the command registration code (appended to end of file).

    This runs at module load time via a Promise chain.
    When server-chat.js is evaluated, this fires immediately and registers
    /goal as a plugin command via registerPluginCommand, making it
    available in Telegram before any user interaction.
    """
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

    # Compute relative import paths from server-chat.js's directory
    rel_se = compute_relative_path(server_chat, paths["system_events"])
    rel_hb = compute_relative_path(server_chat, paths["heartbeat_wake"])
    rel_ms = compute_relative_path(server_chat, paths["main_session"])
    rel_pc = compute_relative_path(server_chat, paths["plugins_commands"])

    print(f"\n[2/8] Extracting {server_chat} from container...")
    local_original = "/tmp/server-chat-original.js"
    local_patched = "/tmp/server-chat-patched.js"
    docker_cp_from(server_chat, local_original)

    with open(local_original, "r", encoding="utf-8") as f:
        source = f.read()

    # Check if already patched
    has_lifecycle = LIFECYCLE_MARKER in source
    has_cmd_reg = CMD_REG_MARKER in source
    if has_lifecycle and has_cmd_reg:
        print("  [WARN] File is already fully patched. Use --revert first to re-patch.")
        return False
    if has_lifecycle or has_cmd_reg:
        print("  [WARN] File has a partial patch. Use --revert first, then re-deploy.")
        return False

    # Create backup inside the container
    print(f"[3/8] Creating backup at {server_chat}{BACKUP_SUFFIX}...")
    docker_exec(f"cp {server_chat} {server_chat}{BACKUP_SUFFIX}")

    # ── Lifecycle Patch ──────────────────────────────────────────────
    # Find clearAgentRunContext(evt.runId); and insert after it
    pattern = re.compile(
        r'(clearAgentRunContext\s*\(\s*evt\.runId\s*\)\s*;)',
        re.MULTILINE,
    )
    matches = list(pattern.finditer(source))
    if not matches:
        pattern2 = re.compile(r'(clearAgentRunContext\([^)]*\)\s*;)', re.MULTILINE)
        matches = list(pattern2.finditer(source))

    if not matches:
        print("[ERROR] Could not find clearAgentRunContext(evt.runId) in server-chat.js")
        print("  The compiled code structure may differ from expected.")
        sys.exit(1)

    match = matches[-1]
    insert_pos = match.end()

    print(f"[4/8] Applying lifecycle patch (after position {insert_pos})...")
    lifecycle_code = build_lifecycle_patch(rel_se, rel_hb, rel_ms)
    patched = source[:insert_pos] + "\n" + lifecycle_code + "\n" + source[insert_pos:]

    # ── Command Registration Patch ───────────────────────────────────
    print("[5/8] Applying command registration patch (appended to file)...")
    cmd_reg_code = build_cmd_registration_patch(rel_pc)
    patched = patched + "\n" + cmd_reg_code + "\n"

    with open(local_patched, "w", encoding="utf-8") as f:
        f.write(patched)

    # Verify both patches present
    if LIFECYCLE_MARKER not in patched:
        print("[ERROR] Lifecycle patch marker missing — something went wrong.")
        sys.exit(1)
    if CMD_REG_MARKER not in patched:
        print("[ERROR] Command registration patch marker missing — something went wrong.")
        sys.exit(1)

    # Copy patched file back
    print(f"[6/8] Deploying patched server-chat.js to container...")
    docker_cp_to(local_patched, server_chat)
    docker_exec(f"chown node:node {server_chat}")

    return True


# ── goal-monitor.mjs deployment ──────────────────────────────────────

def deploy_goal_monitor():
    """Copy goal-monitor.mjs into the container."""
    print("[7/8] Deploying goal-monitor.mjs to /app/goal-monitor.mjs...")
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
        print("  goals.json already exists — skipping creation")
        return
    store = {"version": 1, "goals": []}
    docker_exec(
        f"python3 -c \""
        f"import json; "
        f"open('{gf}','w').write(json.dumps({json.dumps(store)},indent=2))"
        f"\"",
        check=False,
    )
    # Fallback: write via echo if python3 isn't available
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
    """Check if the patch is currently applied."""
    server_chat = paths["server_chat"]

    lc_check = docker_exec(
        f"grep -c '{LIFECYCLE_MARKER}' {server_chat} 2>/dev/null || echo 0",
        check=False,
    )
    lc_count = lc_check.strip().split("\n")[-1]

    cmd_check = docker_exec(
        f"grep -c '{CMD_REG_MARKER}' {server_chat} 2>/dev/null || echo 0",
        check=False,
    )
    cmd_count = cmd_check.strip().split("\n")[-1]

    has_lifecycle = lc_count and int(lc_count) > 0
    has_cmd_reg = cmd_count and int(cmd_count) > 0

    if has_lifecycle and has_cmd_reg:
        print(f"[OK] Both patches applied in {server_chat}")
    elif has_lifecycle:
        print(f"[WARN] Only lifecycle patch applied (missing command registration)")
    elif has_cmd_reg:
        print(f"[WARN] Only command registration applied (missing lifecycle patch)")
    else:
        print(f"[INFO] No patches applied in {server_chat}")
        return

    # Check goal-monitor.mjs
    gm_check = docker_exec(
        "test -f /app/goal-monitor.mjs && echo exists || echo missing",
        check=False,
    )
    if "exists" in gm_check:
        print("[OK] /app/goal-monitor.mjs exists")
    else:
        print("[WARN] /app/goal-monitor.mjs is MISSING")

    # Check goals.json
    goal_check = docker_exec(
        f"test -f {GOAL_FILE_PATH} && echo exists || echo missing",
        check=False,
    )
    if "exists" in goal_check:
        print(f"[OK] {GOAL_FILE_PATH} exists")
    else:
        print(f"[WARN] {GOAL_FILE_PATH} is MISSING")


# ── restart ──────────────────────────────────────────────────────────

def restart_container():
    """Restart the OpenClaw container."""
    print("[8/8] Restarting OpenClaw container...")
    run(f"docker restart {CONTAINER}")
    print("  Container restarted. Waiting 5 seconds for startup...")
    time.sleep(5)
    status = run(f"docker ps --filter name={CONTAINER} --format '{{{{.Status}}}}'")
    print(f"  Container status: {status}")


# ── main ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Deploy the Goal Monitor patch for OpenClaw",
    )
    parser.add_argument(
        "--revert", action="store_true",
        help="Revert the patch (restore from backup)",
    )
    parser.add_argument(
        "--verify", action="store_true",
        help="Check if the patch is applied",
    )
    parser.add_argument(
        "--container", default=CONTAINER,
        help=f"Docker container name (default: {CONTAINER})",
    )
    args = parser.parse_args()

    global CONTAINER
    CONTAINER = args.container

    # Verify container is running
    status = run(
        f"docker inspect -f '{{{{.State.Running}}}}' {CONTAINER}",
        check=False,
    )
    if "true" not in status:
        print(f"[ERROR] Container '{CONTAINER}' is not running.")
        sys.exit(1)

    # Discover paths
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
    print("  Goal Monitor — Deploy & Patch")
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

  2. Send the agent a message via Telegram to start working.

  3. When the agent finishes a turn, the goal monitor will
     automatically trigger a continuation.

  4. Monitor logs:
     docker logs openclaw -f --tail 50 2>&1 | grep goal-monitor

  5. Manage goals from Telegram:
     /goal list
     /goal status
     /goal pause
     /goal resume
     /goal delete
""")


if __name__ == "__main__":
    main()
