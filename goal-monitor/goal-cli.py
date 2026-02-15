#!/usr/bin/env python3
"""
Goal CLI — SSH fallback for managing goals
===========================================

NOTE: The primary way to manage goals is via Telegram using /goal.
      This CLI is an optional fallback for SSH-based management.

Run on the DROPLET host. Uses docker exec to read/write goals
inside the OpenClaw container.

Usage:
  python3 goal-cli.py set "Continue reverse engineering till all phases complete"
  python3 goal-cli.py set "Do X" --max 50 --cooldown 30 --delay 10
  python3 goal-cli.py list
  python3 goal-cli.py status
  python3 goal-cli.py pause <id-or-index>
  python3 goal-cli.py resume <id-or-index>
  python3 goal-cli.py delete <id-or-index>
  python3 goal-cli.py reset-count <id-or-index>
  python3 goal-cli.py clear-all
"""

import json
import subprocess
import sys
import uuid
from datetime import datetime, timezone

CONTAINER = "openclaw"
GOAL_FILE = "/home/node/.openclaw/goals.json"


# ── docker helpers ───────────────────────────────────────────────────

def docker_read():
    """Read goals.json from the container."""
    result = subprocess.run(
        ["docker", "exec", CONTAINER, "cat", GOAL_FILE],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return {"version": 1, "goals": []}
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"version": 1, "goals": []}


def docker_write(store):
    """Write goals.json to the container via python3 inside the container."""
    data = json.dumps(store, indent=2)
    # Use a heredoc-style approach through bash
    proc = subprocess.run(
        [
            "docker", "exec", "-i", "-u", "root", CONTAINER,
            "bash", "-c", f"cat > {GOAL_FILE} && chown node:node {GOAL_FILE}",
        ],
        input=data,
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(f"[ERROR] Failed to write goals: {proc.stderr.strip()}")
        sys.exit(1)


def resolve_goal(store, ref):
    """Resolve a goal by ID prefix or 1-based index."""
    goals = store.get("goals", [])
    if not goals:
        print("[ERROR] No goals found.")
        sys.exit(1)

    # Try as 1-based index
    try:
        idx = int(ref) - 1
        if 0 <= idx < len(goals):
            return idx, goals[idx]
    except ValueError:
        pass

    # Try as ID prefix
    ref_lower = ref.lower()
    matches = [(i, g) for i, g in enumerate(goals) if g.get("id", "").lower().startswith(ref_lower)]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        print(f"[ERROR] Ambiguous ID prefix '{ref}' — matches {len(matches)} goals.")
        sys.exit(1)

    print(f"[ERROR] No goal found matching '{ref}'.")
    sys.exit(1)


# ── commands ─────────────────────────────────────────────────────────

def cmd_set(args):
    """Set a new active goal (deactivates any existing active goal)."""
    text = " ".join(args.text)
    if not text.strip():
        print("[ERROR] Goal text is required.")
        sys.exit(1)

    store = docker_read()
    goals = store.setdefault("goals", [])

    # Deactivate any currently active goals
    for g in goals:
        if g.get("active"):
            g["active"] = False
            g["deactivated_at"] = datetime.now(timezone.utc).isoformat()
            g["deactivated_reason"] = "replaced_by_new_goal"

    # Create new goal
    goal = {
        "id": str(uuid.uuid4())[:8],
        "text": text.strip(),
        "active": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "max_continuations": args.max,
        "cooldown_seconds": args.cooldown,
        "delay_seconds": args.delay,
        "continuation_count": 0,
        "last_continuation_at": None,
    }
    goals.append(goal)
    docker_write(store)

    print(f"[OK] Goal set (id={goal['id']}):")
    print(f"  Text: {goal['text']}")
    print(f"  Max continuations: {goal['max_continuations']}")
    print(f"  Cooldown: {goal['cooldown_seconds']}s")
    print(f"  Heartbeat delay: {goal['delay_seconds']}s")


def cmd_list(_args):
    """List all goals."""
    store = docker_read()
    goals = store.get("goals", [])

    if not goals:
        print("No goals configured.")
        return

    print(f"{'#':<4} {'ID':<10} {'Status':<12} {'Count':<8} {'Text'}")
    print("-" * 80)
    for i, g in enumerate(goals, 1):
        status = "ACTIVE" if g.get("active") else "inactive"
        count = g.get("continuation_count", 0)
        max_c = g.get("max_continuations", 200)
        text = g.get("text", "")[:45]
        print(f"{i:<4} {g.get('id','?'):<10} {status:<12} {count}/{max_c:<5} {text}")


def cmd_status(_args):
    """Show detailed status of the active goal."""
    store = docker_read()
    goals = store.get("goals", [])
    active = next((g for g in goals if g.get("active")), None)

    if not active:
        print("No active goal.")
        return

    print("Active Goal:")
    print(f"  ID:                 {active.get('id', '?')}")
    print(f"  Text:               {active.get('text', '')}")
    print(f"  Created:            {active.get('created_at', '?')}")
    print(f"  Continuations:      {active.get('continuation_count', 0)} / {active.get('max_continuations', 200)}")
    print(f"  Cooldown:           {active.get('cooldown_seconds', 15)}s")
    print(f"  Heartbeat delay:    {active.get('delay_seconds', 5)}s")
    print(f"  Last continuation:  {active.get('last_continuation_at', 'never')}")


def cmd_pause(args):
    """Pause (deactivate) a goal."""
    store = docker_read()
    idx, goal = resolve_goal(store, args.ref)
    if not goal.get("active"):
        print(f"Goal '{goal.get('id')}' is already inactive.")
        return
    goal["active"] = False
    goal["deactivated_at"] = datetime.now(timezone.utc).isoformat()
    goal["deactivated_reason"] = "manually_paused"
    docker_write(store)
    print(f"[OK] Goal '{goal.get('id')}' paused.")


def cmd_resume(args):
    """Resume (reactivate) a goal — deactivates any other active goal."""
    store = docker_read()
    idx, goal = resolve_goal(store, args.ref)

    # Deactivate others
    for g in store.get("goals", []):
        if g.get("active") and g.get("id") != goal.get("id"):
            g["active"] = False
            g["deactivated_at"] = datetime.now(timezone.utc).isoformat()
            g["deactivated_reason"] = "replaced_by_resume"

    goal["active"] = True
    goal.pop("deactivated_at", None)
    goal.pop("deactivated_reason", None)
    docker_write(store)
    print(f"[OK] Goal '{goal.get('id')}' resumed.")


def cmd_delete(args):
    """Delete a goal."""
    store = docker_read()
    idx, goal = resolve_goal(store, args.ref)
    gid = goal.get("id", "?")
    store["goals"].pop(idx)
    docker_write(store)
    print(f"[OK] Goal '{gid}' deleted.")


def cmd_reset_count(args):
    """Reset the continuation count for a goal."""
    store = docker_read()
    idx, goal = resolve_goal(store, args.ref)
    old_count = goal.get("continuation_count", 0)
    goal["continuation_count"] = 0
    goal["last_continuation_at"] = None
    docker_write(store)
    print(f"[OK] Goal '{goal.get('id')}' count reset (was {old_count}).")


def cmd_clear_all(_args):
    """Delete ALL goals."""
    store = {"version": 1, "goals": []}
    docker_write(store)
    print("[OK] All goals cleared.")


# ── main ─────────────────────────────────────────────────────────────

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Goal CLI for OpenClaw Goal Monitor",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 goal-cli.py set "Continue RE work till all phases done"
  python3 goal-cli.py set "Analyze the APK" --max 50 --cooldown 30
  python3 goal-cli.py list
  python3 goal-cli.py status
  python3 goal-cli.py pause 1
  python3 goal-cli.py resume 1
  python3 goal-cli.py delete 1
  python3 goal-cli.py reset-count 1
  python3 goal-cli.py clear-all
""",
    )
    sub = parser.add_subparsers(dest="command")

    # set
    p_set = sub.add_parser("set", help="Set a new active goal")
    p_set.add_argument("text", nargs="+", help="Goal description text")
    p_set.add_argument("--max", type=int, default=200, help="Max continuations (default: 200)")
    p_set.add_argument("--cooldown", type=int, default=15, help="Cooldown seconds (default: 15)")
    p_set.add_argument("--delay", type=int, default=5, help="Heartbeat delay seconds (default: 5)")

    # list
    sub.add_parser("list", help="List all goals")

    # status
    sub.add_parser("status", help="Show active goal details")

    # pause
    p_pause = sub.add_parser("pause", help="Pause a goal")
    p_pause.add_argument("ref", help="Goal ID prefix or 1-based index")

    # resume
    p_resume = sub.add_parser("resume", help="Resume a goal")
    p_resume.add_argument("ref", help="Goal ID prefix or 1-based index")

    # delete
    p_del = sub.add_parser("delete", help="Delete a goal")
    p_del.add_argument("ref", help="Goal ID prefix or 1-based index")

    # reset-count
    p_reset = sub.add_parser("reset-count", help="Reset continuation count")
    p_reset.add_argument("ref", help="Goal ID prefix or 1-based index")

    # clear-all
    sub.add_parser("clear-all", help="Delete ALL goals")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    commands = {
        "set": cmd_set,
        "list": cmd_list,
        "status": cmd_status,
        "pause": cmd_pause,
        "resume": cmd_resume,
        "delete": cmd_delete,
        "reset-count": cmd_reset_count,
        "clear-all": cmd_clear_all,
    }

    fn = commands.get(args.command)
    if fn:
        fn(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
