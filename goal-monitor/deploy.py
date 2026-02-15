#!/usr/bin/env python3
"""
Goal Monitor — Deploy & Patch Script for OpenClaw
==================================================

Run this script on the DROPLET (not your local machine).

What it does:
  1. Copies goal-monitor.mjs into the OpenClaw container at /app/goal-monitor.mjs
  2. Finds the compiled server-chat.js inside the container
  3. Discovers relative import paths for OpenClaw's internal modules
  4. Patches server-chat.js to call goal-monitor on lifecycle "end" events
  5. Creates the initial goals.json store
  6. Fixes file permissions (node user)
  7. Restarts the OpenClaw container

Usage:
  cd /opt/goal-monitor          # wherever you placed these files
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
import textwrap
from pathlib import PurePosixPath

CONTAINER = "openclaw"
GOAL_MONITOR_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "goal-monitor.mjs")
GOAL_FILE_PATH = "/home/node/.openclaw/goals.json"
PATCH_MARKER = "--- GOAL MONITOR PATCH ---"
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
    print("[1/7] Discovering file paths inside the OpenClaw container...")

    # server-chat.js
    candidates = find_file_in_container("server-chat.js", "gateway")
    if not candidates:
        # Try .cjs extension
        candidates = find_file_in_container("server-chat.cjs", "gateway")
    if not candidates:
        print("[ERROR] Could not find server-chat.js in the container.")
        print("  Searched: /app/**/gateway/server-chat.{js,cjs}")
        sys.exit(1)
    server_chat = candidates[0]
    print(f"  server-chat.js  → {server_chat}")

    # system-events.js
    candidates = find_file_in_container("system-events.js", "infra")
    if not candidates:
        candidates = find_file_in_container("system-events.cjs", "infra")
    if not candidates:
        print("[ERROR] Could not find system-events.js")
        sys.exit(1)
    system_events = candidates[0]
    print(f"  system-events   → {system_events}")

    # heartbeat-wake.js
    candidates = find_file_in_container("heartbeat-wake.js", "infra")
    if not candidates:
        candidates = find_file_in_container("heartbeat-wake.cjs", "infra")
    if not candidates:
        print("[ERROR] Could not find heartbeat-wake.js")
        sys.exit(1)
    heartbeat_wake = candidates[0]
    print(f"  heartbeat-wake  → {heartbeat_wake}")

    # main-session.js (may be in config/sessions/ or config/)
    candidates = find_file_in_container("main-session.js", "sessions")
    if not candidates:
        candidates = find_file_in_container("main-session.js", "config")
    if not candidates:
        candidates = find_file_in_container("main-session.cjs", "sessions")
    if not candidates:
        # Fallback: sessions.js that exports resolveMainSessionKeyFromConfig
        candidates = find_file_in_container("sessions.js", "config")
    if not candidates:
        print("[ERROR] Could not find main-session.js or sessions.js")
        sys.exit(1)
    main_session = candidates[0]
    print(f"  main-session    → {main_session}")

    return {
        "server_chat": server_chat,
        "system_events": system_events,
        "heartbeat_wake": heartbeat_wake,
        "main_session": main_session,
    }


def compute_relative_path(from_file, to_file):
    """Compute a POSIX relative path from one file's directory to another file."""
    from_dir = str(PurePosixPath(from_file).parent)
    to_path = str(PurePosixPath(to_file))
    # Split into parts
    from_parts = from_dir.strip("/").split("/")
    to_parts = to_path.strip("/").split("/")
    # Find common prefix length
    common = 0
    for a, b in zip(from_parts, to_parts):
        if a == b:
            common += 1
        else:
            break
    # Build relative path
    ups = len(from_parts) - common
    remainder = to_parts[common:]
    rel = "/".join([".."] * ups + remainder) if ups else "/".join(remainder)
    if not rel.startswith("."):
        rel = "./" + rel
    return rel


# ── patching ─────────────────────────────────────────────────────────

def build_patch_code(rel_sys_events, rel_heartbeat, rel_main_session):
    """Build the JavaScript patch code to insert into server-chat.js.

    Every line is pre-indented with 4 spaces so it aligns with the
    surrounding if-block inside the compiled server-chat.js.
    """
    indent = "    "
    lines = [
        f"// {PATCH_MARKER}",
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


def apply_patch(paths):
    """Extract, patch, and re-deploy server-chat.js."""
    server_chat = paths["server_chat"]

    # Compute relative import paths from server-chat.js's directory
    rel_se = compute_relative_path(server_chat, paths["system_events"])
    rel_hb = compute_relative_path(server_chat, paths["heartbeat_wake"])
    rel_ms = compute_relative_path(server_chat, paths["main_session"])

    print(f"\n[2/7] Extracting {server_chat} from container...")
    local_original = "/tmp/server-chat-original.js"
    local_patched = "/tmp/server-chat-patched.js"
    docker_cp_from(server_chat, local_original)

    with open(local_original, "r", encoding="utf-8") as f:
        source = f.read()

    # Check if already patched
    if PATCH_MARKER in source:
        print("  [WARN] File is already patched. Use --revert first to re-patch.")
        return False

    # Create backup inside the container
    print(f"[3/7] Creating backup at {server_chat}{BACKUP_SUFFIX}...")
    docker_exec(f"cp {server_chat} {server_chat}{BACKUP_SUFFIX}")

    # Find the patch insertion point.
    # We look for the final lifecycle cleanup block:
    #   if (lifecyclePhase === "end" || lifecyclePhase === "error") {
    #     toolEventRecipients.markFinal(evt.runId);
    #     clearAgentRunContext(evt.runId);
    #   }
    #
    # We insert our code AFTER clearAgentRunContext(evt.runId);
    # but BEFORE the closing } of that if-block.

    # Strategy: find "clearAgentRunContext" that's inside a block with
    # "lifecyclePhase" checks. We anchor on clearAgentRunContext.
    pattern = re.compile(
        r'(clearAgentRunContext\s*\(\s*evt\.runId\s*\)\s*;)',
        re.MULTILINE,
    )

    matches = list(pattern.finditer(source))
    if not matches:
        # Fallback: try without spaces
        pattern2 = re.compile(r'(clearAgentRunContext\([^)]*\)\s*;)', re.MULTILINE)
        matches = list(pattern2.finditer(source))

    if not matches:
        print("[ERROR] Could not find clearAgentRunContext(evt.runId) in server-chat.js")
        print("  The compiled code structure may differ from expected.")
        print("  Please check the file manually.")
        sys.exit(1)

    # Use the LAST match (the one in the final cleanup block at line ~408)
    match = matches[-1]
    insert_pos = match.end()

    print(f"[4/7] Patching server-chat.js (inserting after position {insert_pos})...")
    patch_code = build_patch_code(rel_se, rel_hb, rel_ms)

    patched = source[:insert_pos] + "\n" + patch_code + "\n" + source[insert_pos:]

    with open(local_patched, "w", encoding="utf-8") as f:
        f.write(patched)

    # Verify the patch looks correct (basic sanity)
    if PATCH_MARKER not in patched:
        print("[ERROR] Patch marker not found in output — something went wrong.")
        sys.exit(1)

    # Copy patched file back
    print(f"[5/7] Deploying patched server-chat.js to container...")
    docker_cp_to(local_patched, server_chat)
    docker_exec(f"chown node:node {server_chat}")

    return True


# ── goal-monitor.mjs deployment ──────────────────────────────────────

def deploy_goal_monitor():
    """Copy goal-monitor.mjs into the container."""
    print("[6/7] Deploying goal-monitor.mjs to /app/goal-monitor.mjs...")
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
    data = json.dumps(store, indent=2)
    # Write via python inside the container to avoid escaping issues
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
    print("Reverted successfully. Restart the container to apply.")


# ── verify ───────────────────────────────────────────────────────────

def verify_patch(paths):
    """Check if the patch is currently applied."""
    server_chat = paths["server_chat"]
    check = docker_exec(
        f"grep -c '{PATCH_MARKER}' {server_chat} 2>/dev/null || echo 0",
        check=False,
    )
    count = check.strip().split("\n")[-1]
    if count and int(count) > 0:
        print(f"[OK] Goal monitor patch IS applied in {server_chat}")
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
    else:
        print(f"[INFO] Goal monitor patch is NOT applied in {server_chat}")


# ── restart ──────────────────────────────────────────────────────────

def restart_container():
    """Restart the OpenClaw container."""
    print("[7/7] Restarting OpenClaw container...")
    run(f"docker restart {CONTAINER}")
    print("  Container restarted. Waiting 5 seconds for startup...")
    import time
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
        print("\n[INFO] No restart needed (file was already patched).")

    print("\n" + "=" * 60)
    print("  Deployment complete!")
    print("=" * 60)
    print(f"""
Next steps:
  1. Set a goal:
     python3 goal-cli.py set "Continue reverse engineering till all phases complete"

  2. Send the agent a message via Telegram to start working.

  3. When the agent finishes a turn, the goal monitor will
     automatically trigger a continuation.

  4. Monitor logs:
     docker logs openclaw -f --tail 50 2>&1 | grep goal-monitor

  5. Manage goals:
     python3 goal-cli.py list
     python3 goal-cli.py pause <id>
     python3 goal-cli.py delete <id>
""")


if __name__ == "__main__":
    main()
