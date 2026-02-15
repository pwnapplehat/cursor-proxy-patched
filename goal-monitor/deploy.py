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
  4. Patches the reply module (reply-*.js) with command registration
     — registers /goal directly in the authoritative pluginCommands Map
     — picked up by Telegram bot.command() setup and auto-reply chain
  5. Creates the initial goals.json store
  6. Restarts the OpenClaw container

Why the reply module and NOT extensionAPI.js?
  Rolldown duplicates the pluginCommands Map into multiple chunks.
  extensionAPI.js has its own copy of registerPluginCommand + Map, but the
  Telegram bot dispatcher and auto-reply handlePluginCommand both read from
  the Map in reply-*.js. Registering in extensionAPI.js adds to the wrong
  Map — the command is invisible to the dispatcher.

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

    # ── Reply module: contains the AUTHORITATIVE pluginCommands Map ──
    # This is the Map that the Telegram bot.command() setup and auto-reply
    # handlePluginCommand handler both read from. It lives in reply-*.js.
    #
    # We find it by searching for files containing getPluginCommandSpecs
    # (the function called by registerTelegramNativeCommands to build the
    # Telegram command menu). Only the reply chunk has this + pluginCommands.
    reply_candidates = find_dist_files_containing("getPluginCommandSpecs")
    reply_module = None

    # Prefer files matching reply-*.js pattern
    reply_files = [f for f in reply_candidates if "/reply-" in f]
    if reply_files:
        # Further narrow: must also contain pluginCommands Map definition
        for rf in reply_files:
            check = docker_exec(
                f'grep -c "pluginCommands" "{rf}" 2>/dev/null || echo 0',
                check=False,
            )
            c = check.strip().split("\n")[-1]
            if int(c) > 5:  # Should have many references
                reply_module = rf
                break
        if not reply_module:
            reply_module = reply_files[0]
    elif reply_candidates:
        reply_module = reply_candidates[0]

    if reply_module:
        print(f"  Reply module: {reply_module}")
        # Verify it has the pluginCommands Map
        pc_count = docker_exec(
            f'grep -c "pluginCommands" "{reply_module}" 2>/dev/null || echo 0',
            check=False,
        )
        c = pc_count.strip().split("\n")[-1]
        print(f"  [OK] pluginCommands refs: {c}")
    else:
        print("  [WARN] Reply module not found — /goal command registration will be skipped")

    return {
        "gateway_files": gateway_files,
        "reply_module": reply_module,
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
    """Build the command registration code (appended to reply module).

    Directly inserts into the pluginCommands Map that the Telegram bot
    dispatcher and auto-reply handlePluginCommand both read from.

    The pluginCommands Map is a module-scoped const in the reply chunk,
    so code appended to the file can access it directly. The handler
    dynamically imports goal-monitor.mjs and delegates to handleGoalCommand.

    Timing: This code runs at module load time (when reply-*.js is first
    imported during Telegram channel init). registerTelegramNativeCommands()
    is called AFTER the module loads, so getPluginCommandSpecs() will see
    the /goal entry and register a native bot.command("goal") handler.
    Result: /goal appears in the Telegram command menu and is handled
    by grammY before reaching bot.on("message").
    """
    lines = [
        f"// {CMD_REG_MARKER}",
        "// Register /goal in the authoritative pluginCommands Map.",
        "// This Map is read by both bot.command() setup and auto-reply handlePluginCommand.",
        "(function() {",
        '  var gmKey = "/goal";',
        '  console.log("[goal-monitor] pluginCommands type:", typeof pluginCommands, "isMap:", pluginCommands instanceof Map);',
        '  console.log("[goal-monitor] Map size BEFORE set:", pluginCommands.size, "keys:", Array.from(pluginCommands.keys()).join(", "));',
        "  if (pluginCommands.has(gmKey)) {",
        '    console.log("[goal-monitor] /goal already registered — skipping");',
        "    return;",
        "  }",
        "  pluginCommands.set(gmKey, {",
        '    name: "goal",',
        '    description: "Manage autonomous continuation goals",',
        "    acceptsArgs: true,",
        "    requireAuth: true,",
        '    pluginId: "goal-monitor",',
        "    handler: async function(ctx) {",
        "      try {",
        '        console.log("[goal-monitor] handler called! args:", ctx.args, "channel:", ctx.channel);',
        '        var gm = await import("/app/goal-monitor.mjs");',
        "        return gm.handleGoalCommand(ctx);",
        "      } catch (err) {",
        '        console.error("[goal-monitor] handler error:", err);',
        '        return { text: "\\u26a0\\ufe0f Goal monitor error: " + (err.message || String(err)) };',
        "      }",
        "    }",
        "  });",
        '  console.log("[goal-monitor] Map size AFTER set:", pluginCommands.size, "has /goal:", pluginCommands.has("/goal"));',
        "  // Verify getPluginCommandSpecs sees our entry",
        '  if (typeof getPluginCommandSpecs === "function") {',
        "    var specs = getPluginCommandSpecs();",
        '    var goalSpec = specs.find(function(s) { return s.name === "goal"; });',
        '    console.log("[goal-monitor] getPluginCommandSpecs() count:", specs.length, "has goal:", !!goalSpec);',
        "  } else {",
        '    console.log("[goal-monitor] getPluginCommandSpecs is NOT accessible at this scope");',
        "  }",
        "  // Verify matchPluginCommand can find it",
        '  if (typeof matchPluginCommand === "function") {',
        '    var testMatch = matchPluginCommand("/goal test");',
        '    console.log("[goal-monitor] matchPluginCommand test:", testMatch ? "FOUND" : "NOT FOUND");',
        "  } else {",
        '    console.log("[goal-monitor] matchPluginCommand is NOT accessible at this scope");',
        "  }",
        '  console.log("[goal-monitor] /goal command registered in reply module");',
        "})();",
        "// --- END GOAL MONITOR: COMMAND REGISTRATION ---",
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
    if LIFECYCLE_MARKER in source or TEXT_CAPTURE_MARKER in source:
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

    # Verify both patches are present
    for marker, name in [
        (TEXT_CAPTURE_MARKER, "text capture"),
        (LIFECYCLE_MARKER, "lifecycle"),
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


# ── reply module patching ────────────────────────────────────────────


def patch_reply_module(filepath):
    """Append command registration patch to the reply module (reply-*.js).

    The reply module contains the authoritative pluginCommands Map that
    both the Telegram bot.command() dispatcher and the auto-reply chain's
    handlePluginCommand read from. Registering directly in this Map
    ensures /goal is visible to all dispatch paths.
    """
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

    # Verify this file has the pluginCommands Map
    if "pluginCommands" not in source:
        print(f"  [WARN] pluginCommands not found in {basename}")
        print(f"  Command registration skipped — /goal will not be available")
        return False

    # Verify this file has getPluginCommandSpecs (confirming it feeds the bot setup)
    if "getPluginCommandSpecs" not in source:
        print(f"  [WARN] getPluginCommandSpecs not found in {basename}")
        print(f"  This may not be the correct reply module")

    # Create backup
    docker_exec(f'cp "{filepath}" "{filepath}{BACKUP_SUFFIX}"')
    print(f"  Backup created: {filepath}{BACKUP_SUFFIX}")

    # Append command registration — runs at module load time, before
    # registerTelegramNativeCommands() calls getPluginCommandSpecs()
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
    if paths.get("reply_module"):
        all_files.append(paths["reply_module"])

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

    # Check gateway chunks (text capture + lifecycle only)
    for gf in paths["gateway_files"]:
        basename = os.path.basename(gf)
        for marker, name in [
            (TEXT_CAPTURE_MARKER, "text capture"),
            (LIFECYCLE_MARKER, "lifecycle"),
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

    # Check reply module (command registration)
    if paths.get("reply_module"):
        reply = paths["reply_module"]
        reply_base = os.path.basename(reply)
        count = docker_exec(
            f'grep -c "{CMD_REG_MARKER}" "{reply}" 2>/dev/null || echo 0',
            check=False,
        )
        c = count.strip().split("\n")[-1]
        if c and int(c) > 0:
            print(f"  [OK] command registration patch in {reply_base}")
        else:
            print(f"  [MISSING] command registration patch in {reply_base}")
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

    # Step 0: Revert any stale patches from previous deployments
    # Previous versions patched extensionAPI.js (wrong Map) and added init
    # trigger patches to gateway chunks. Revert everything cleanly first.
    print("\n[CLEANUP] Reverting any previous patches ...")
    stale_reverted = 0
    all_backup_candidates = list(paths["gateway_files"])
    if paths.get("reply_module"):
        all_backup_candidates.append(paths["reply_module"])
    # Also check extensionAPI.js (no longer patched, but may have stale patch)
    ext_api_check = docker_exec(
        'test -f /app/dist/extensionAPI.js.goal-monitor-backup && echo exists || echo missing',
        check=False,
    )
    if "exists" in ext_api_check:
        print("  Reverting stale extensionAPI.js patch ...")
        docker_exec(
            'cp /app/dist/extensionAPI.js.goal-monitor-backup /app/dist/extensionAPI.js',
            check=False,
        )
        docker_exec('chown node:node /app/dist/extensionAPI.js', check=False)
        docker_exec('rm -f /app/dist/extensionAPI.js.goal-monitor-backup', check=False)
        stale_reverted += 1

    for filepath in all_backup_candidates:
        backup = filepath + BACKUP_SUFFIX
        check = docker_exec(
            f'test -f "{backup}" && echo exists || echo missing', check=False
        )
        if "exists" in check:
            basename = os.path.basename(filepath)
            print(f"  Reverting {basename} from backup ...")
            docker_exec(f'cp "{backup}" "{filepath}"')
            docker_exec(f'chown node:node "{filepath}"')
            docker_exec(f'rm -f "{backup}"')
            stale_reverted += 1

    if stale_reverted:
        print(f"  Reverted {stale_reverted} file(s) to clean state")
    else:
        print("  No previous patches found — clean state")

    # Step 1: Patch gateway chunk(s) — text capture + lifecycle
    print("\n[PATCH] Patching gateway chunk(s) ...")
    for gf in paths["gateway_files"]:
        if patch_gateway_chunk(gf):
            any_patched = True

    # Step 2: Patch reply module — command registration in the correct Map
    if paths.get("reply_module"):
        print("\n[PATCH] Patching reply module for /goal command ...")
        if patch_reply_module(paths["reply_module"]):
            any_patched = True
    else:
        print("\n[SKIP] Reply module not found — /goal command registration skipped")

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
