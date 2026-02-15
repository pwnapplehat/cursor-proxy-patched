/**
 * Goal Monitor for OpenClaw
 * =========================
 *
 * Two responsibilities:
 *
 * 1. /goal Telegram command — manages goals via the plugin command system.
 *    Registered at startup by registerGoalCommand(). Supports:
 *      /goal <text>              — set a new goal (shortcut)
 *      /goal set <text>          — set a new goal with optional flags
 *      /goal list                — list all goals
 *      /goal status              — show active goal details
 *      /goal pause [ref]         — pause a goal
 *      /goal resume [ref]        — resume a goal
 *      /goal delete [ref]        — delete a goal
 *      /goal reset [ref]         — reset continuation count
 *      /goal clear               — delete all goals
 *      /goal help                — show usage
 *
 * 2. onTurnEnd() — auto-continuation when the agent finishes a turn.
 *    Called from the patched server-chat.js lifecycle handler.
 *
 * Safety features (auto-continuation):
 *   - Per-goal cooldown (configurable, default 15s)
 *   - Maximum continuation count per goal (configurable, default 200)
 *   - Rapid-fire loop detection (5 continuations < 30s apart → 2 min pause)
 *   - Main-session-only filtering (Cursor proxy sessions are ignored)
 *   - Silent error handling (never crashes the host process)
 *
 * Loaded by the patched server-chat.js via dynamic import().
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const GOAL_FILE = "/home/node/.openclaw/goals.json";
const LOG = "[goal-monitor]";

// Rapid-fire detection
const RAPID_WINDOW_MS = 30_000;   // 30 s window
const RAPID_MAX       = 5;        // max rapid continuations before pause
const EMERGENCY_MS    = 120_000;  // 2 min emergency cooldown

// Absolute minimum between any two continuations regardless of config
const ABS_MIN_COOLDOWN_MS = 10_000; // 10 s

/* ------------------------------------------------------------------ */
/*  In-memory state (lives for the lifetime of the OpenClaw process)   */
/* ------------------------------------------------------------------ */

let lastTriggerTs   = 0;
let rapidFireCount  = 0;
let emergencyUntil  = 0;

/* ------------------------------------------------------------------ */
/*  Goal store helpers                                                 */
/* ------------------------------------------------------------------ */

async function readGoalStore() {
  try {
    const raw = await readFile(GOAL_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      return { version: 1, goals: [] };
    }
    console.error(`${LOG} read error:`, err.message);
    return null;
  }
}

async function writeGoalStore(store) {
  try {
    await mkdir(dirname(GOAL_FILE), { recursive: true });
    await writeFile(GOAL_FILE, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error(`${LOG} write error:`, err.message);
  }
}

function generateId() {
  return randomBytes(4).toString("hex");
}

function findGoal(goals, ref) {
  if (!ref) return null;
  const trimmed = ref.trim();
  // Try 1-based index
  const idx = parseInt(trimmed, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= goals.length) {
    return goals[idx - 1];
  }
  // Try ID prefix
  const lower = trimmed.toLowerCase();
  const matches = goals.filter((g) => g.id.toLowerCase().startsWith(lower));
  return matches.length === 1 ? matches[0] : null;
}

/* ================================================================== */
/*  PART 1: /goal Telegram Command                                     */
/* ================================================================== */

/**
 * Register the /goal command via OpenClaw's plugin command system.
 * Called from the command registration patch in server-chat.js.
 *
 * @param {function} registerPluginCommand — from plugins/commands.js
 */
export function registerGoalCommand(registerPluginCommand) {
  const result = registerPluginCommand("goal-monitor", {
    name: "goal",
    description: "Manage autonomous continuation goals",
    acceptsArgs: true,
    requireAuth: true,
    handler: handleGoalCommand,
  });
  if (result.ok) {
    console.log(`${LOG} /goal command registered`);
  } else {
    console.error(`${LOG} /goal registration failed: ${result.error}`);
  }
}

/**
 * Handle /goal command from Telegram.
 * @param {object} ctx — PluginCommandContext
 * @returns {Promise<{text: string}>}
 */
async function handleGoalCommand(ctx) {
  try {
    const args = (ctx.args || "").trim();
    if (!args || args.toLowerCase() === "help") {
      return { text: formatHelp() };
    }

    const spaceIdx = args.indexOf(" ");
    const sub =
      spaceIdx === -1 ? args.toLowerCase() : args.slice(0, spaceIdx).toLowerCase();
    const rest = spaceIdx === -1 ? "" : args.slice(spaceIdx + 1).trim();

    switch (sub) {
      case "set":
        return await cmdSet(rest);
      case "list":
        return await cmdList();
      case "status":
        return await cmdStatus();
      case "pause":
        return await cmdPause(rest);
      case "resume":
        return await cmdResume(rest);
      case "delete":
        return await cmdDelete(rest);
      case "reset":
        return await cmdReset(rest);
      case "clear":
        return await cmdClear();
      default:
        // Treat entire args as goal text (shortcut for "set")
        return await cmdSet(args);
    }
  } catch (err) {
    console.error(`${LOG} command error:`, err?.message || err);
    return { text: "⚠️ Goal command failed. Check container logs." };
  }
}

/* ---- Help ---- */

function formatHelp() {
  return [
    "🎯 Goal Monitor Commands",
    "",
    "/goal <text> — Set a new goal (shortcut)",
    "/goal set <text> — Set a new goal",
    "/goal set <text> --max N — With max continuations",
    "/goal set <text> --cooldown N — With cooldown (seconds)",
    "/goal set <text> --delay N — With heartbeat delay (seconds)",
    "/goal list — List all goals",
    "/goal status — Show active goal details",
    "/goal pause [#] — Pause (default: active goal)",
    "/goal resume [#] — Resume a paused goal",
    "/goal delete [#] — Delete a goal",
    "/goal reset [#] — Reset continuation count",
    "/goal clear — Delete ALL goals",
    "/goal help — Show this message",
    "",
    "# = goal number (1-based) or ID prefix",
    "",
    "Examples:",
    "/goal Continue RE till all phases done",
    "/goal set Analyze the APK --max 50 --cooldown 30",
    "/goal pause",
    "/goal resume 1",
  ].join("\n");
}

/* ---- Set ---- */

async function cmdSet(text) {
  if (!text) {
    return {
      text:
        "⚠️ Usage: /goal set <description>\n" +
        "Example: /goal set Continue RE till all phases done",
    };
  }

  // Parse optional flags: --max N, --cooldown N, --delay N
  let maxCont = 200;
  let cooldown = 15;
  let delay = 5;
  let goalText = text;

  const maxMatch = goalText.match(/--max\s+(\d+)/i);
  if (maxMatch) {
    maxCont = Math.max(1, Math.min(10000, parseInt(maxMatch[1], 10)));
    goalText = goalText.replace(maxMatch[0], "").trim();
  }

  const cdMatch = goalText.match(/--cooldown\s+(\d+)/i);
  if (cdMatch) {
    cooldown = Math.max(5, parseInt(cdMatch[1], 10));
    goalText = goalText.replace(cdMatch[0], "").trim();
  }

  const delayMatch = goalText.match(/--delay\s+(\d+)/i);
  if (delayMatch) {
    delay = Math.max(3, parseInt(delayMatch[1], 10));
    goalText = goalText.replace(delayMatch[0], "").trim();
  }

  if (!goalText) {
    return { text: "⚠️ Goal text cannot be empty after parsing flags." };
  }

  const store = await readGoalStore();
  if (!store) return { text: "⚠️ Failed to read goal store." };

  // Deactivate any currently active goal
  for (const g of store.goals) {
    if (g.active) {
      g.active = false;
      g.deactivated_at = new Date().toISOString();
      g.deactivated_reason = "replaced_by_new_goal";
    }
  }

  const newGoal = {
    id: generateId(),
    text: goalText,
    active: true,
    created_at: new Date().toISOString(),
    max_continuations: maxCont,
    cooldown_seconds: cooldown,
    delay_seconds: delay,
    continuation_count: 0,
    last_continuation_at: null,
  };

  store.goals.push(newGoal);
  await writeGoalStore(store);

  // Reset in-memory safety state
  lastTriggerTs = 0;
  rapidFireCount = 0;
  emergencyUntil = 0;

  return {
    text: [
      "🎯 Goal set!",
      "",
      `📝 ${goalText}`,
      `🔄 Max: ${maxCont} continuations`,
      `⏱ Cooldown: ${cooldown}s`,
      `⏳ Delay: ${delay}s`,
      `🆔 ${newGoal.id}`,
      "",
      "Agent will auto-continue towards this goal.",
    ].join("\n"),
  };
}

/* ---- List ---- */

async function cmdList() {
  const store = await readGoalStore();
  if (!store) return { text: "⚠️ Failed to read goal store." };

  if (!store.goals.length) {
    return { text: "📋 No goals. Use /goal <text> to create one." };
  }

  const lines = ["📋 Goals:", ""];
  store.goals.forEach((g, i) => {
    const status = g.active ? "🟢 Active" : "⏸ Inactive";
    const count = g.continuation_count || 0;
    const max = g.max_continuations || 200;
    lines.push(`${i + 1}. [${status}] ${g.text}`);
    lines.push(`   ID: ${g.id} | Progress: ${count}/${max}`);
  });

  return { text: lines.join("\n") };
}

/* ---- Status ---- */

async function cmdStatus() {
  const store = await readGoalStore();
  if (!store) return { text: "⚠️ Failed to read goal store." };

  const active = store.goals.find((g) => g.active);
  if (!active) {
    return { text: "ℹ️ No active goal. Use /goal <text> to set one." };
  }

  const count = active.continuation_count || 0;
  const max = active.max_continuations || 200;
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;

  const lines = [
    "🎯 Active Goal",
    "",
    `📝 ${active.text}`,
    `📊 Progress: ${count}/${max} (${pct}%)`,
    `⏱ Cooldown: ${active.cooldown_seconds || 15}s`,
    `⏳ Delay: ${active.delay_seconds || 5}s`,
    `📅 Created: ${active.created_at || "unknown"}`,
    `🕐 Last continuation: ${active.last_continuation_at || "never"}`,
    `🆔 ${active.id}`,
  ];

  const now = Date.now();
  if (now < emergencyUntil) {
    lines.push("");
    lines.push(
      `⚠️ Emergency cooldown: ${Math.round((emergencyUntil - now) / 1000)}s remaining`,
    );
  }

  return { text: lines.join("\n") };
}

/* ---- Pause ---- */

async function cmdPause(ref) {
  const store = await readGoalStore();
  if (!store) return { text: "⚠️ Failed to read goal store." };

  let goal;
  if (!ref) {
    goal = store.goals.find((g) => g.active);
    if (!goal) return { text: "ℹ️ No active goal to pause." };
  } else {
    goal = findGoal(store.goals, ref);
    if (!goal) return { text: `⚠️ Goal not found: "${ref}"` };
  }

  if (!goal.active) {
    return { text: `ℹ️ Already paused: "${goal.text}"` };
  }

  goal.active = false;
  goal.deactivated_at = new Date().toISOString();
  goal.deactivated_reason = "paused_by_user";
  await writeGoalStore(store);

  return { text: `⏸ Goal paused: "${goal.text}"` };
}

/* ---- Resume ---- */

async function cmdResume(ref) {
  const store = await readGoalStore();
  if (!store) return { text: "⚠️ Failed to read goal store." };

  let goal;
  if (!ref) {
    // Find most recent inactive goal
    const inactive = store.goals.filter((g) => !g.active);
    goal = inactive.length ? inactive[inactive.length - 1] : null;
    if (!goal) return { text: "ℹ️ No paused goal to resume." };
  } else {
    goal = findGoal(store.goals, ref);
    if (!goal) return { text: `⚠️ Goal not found: "${ref}"` };
  }

  if (goal.active) {
    return { text: `ℹ️ Already active: "${goal.text}"` };
  }

  // Deactivate any currently active goal first
  for (const g of store.goals) {
    if (g.active) {
      g.active = false;
      g.deactivated_at = new Date().toISOString();
      g.deactivated_reason = "replaced_on_resume";
    }
  }

  goal.active = true;
  delete goal.deactivated_at;
  delete goal.deactivated_reason;
  await writeGoalStore(store);

  // Reset in-memory state
  lastTriggerTs = 0;
  rapidFireCount = 0;
  emergencyUntil = 0;

  return { text: `▶️ Goal resumed: "${goal.text}"` };
}

/* ---- Delete ---- */

async function cmdDelete(ref) {
  const store = await readGoalStore();
  if (!store) return { text: "⚠️ Failed to read goal store." };

  let goal;
  if (!ref) {
    goal = store.goals.find((g) => g.active);
    if (!goal) {
      goal = store.goals.length ? store.goals[store.goals.length - 1] : null;
    }
    if (!goal) return { text: "ℹ️ No goals to delete." };
  } else {
    goal = findGoal(store.goals, ref);
    if (!goal) return { text: `⚠️ Goal not found: "${ref}"` };
  }

  const text = goal.text;
  store.goals = store.goals.filter((g) => g.id !== goal.id);
  await writeGoalStore(store);

  return { text: `🗑 Deleted: "${text}"` };
}

/* ---- Reset Count ---- */

async function cmdReset(ref) {
  const store = await readGoalStore();
  if (!store) return { text: "⚠️ Failed to read goal store." };

  let goal;
  if (!ref) {
    goal = store.goals.find((g) => g.active);
    if (!goal) return { text: "ℹ️ No active goal to reset." };
  } else {
    goal = findGoal(store.goals, ref);
    if (!goal) return { text: `⚠️ Goal not found: "${ref}"` };
  }

  goal.continuation_count = 0;
  goal.last_continuation_at = null;
  await writeGoalStore(store);

  // Reset in-memory state
  lastTriggerTs = 0;
  rapidFireCount = 0;
  emergencyUntil = 0;

  return { text: `🔄 Count reset for: "${goal.text}"` };
}

/* ---- Clear All ---- */

async function cmdClear() {
  const store = { version: 1, goals: [] };
  await writeGoalStore(store);

  lastTriggerTs = 0;
  rapidFireCount = 0;
  emergencyUntil = 0;

  return { text: "🗑 All goals deleted." };
}

/* ================================================================== */
/*  PART 2: Auto-Continuation (onTurnEnd)                              */
/* ================================================================== */

/**
 * Called from patched server-chat.js when an agent lifecycle "end" fires.
 *
 * @param {string} sessionKey  — session that just finished its turn
 * @param {object} deps
 * @param {function} deps.enqueueSystemEvent
 * @param {function} deps.requestHeartbeatNow
 * @param {function} deps.resolveMainSessionKeyFromConfig
 */
export async function onTurnEnd(sessionKey, deps) {
  try {
    const {
      enqueueSystemEvent,
      requestHeartbeatNow,
      resolveMainSessionKeyFromConfig,
    } = deps;

    /* ---- 1. Only continue for the MAIN session ---- */
    let mainKey;
    try {
      mainKey = resolveMainSessionKeyFromConfig();
    } catch {
      return; // can't resolve → skip silently
    }
    if (sessionKey !== mainKey) {
      return; // Cursor proxy / isolated sessions are unaffected
    }

    /* ---- 2. Read goal store ---- */
    const store = await readGoalStore();
    if (!store) return;

    const goal = (store.goals || []).find((g) => g.active === true);
    if (!goal) return;

    const now = Date.now();

    /* ---- 3. Emergency cooldown (rapid-fire protection) ---- */
    if (now < emergencyUntil) {
      console.log(
        `${LOG} emergency cooldown active — ${Math.round((emergencyUntil - now) / 1000)}s left`,
      );
      return;
    }

    /* ---- 4. Per-goal cooldown ---- */
    const cooldownMs = Math.max(
      (goal.cooldown_seconds || 15) * 1000,
      ABS_MIN_COOLDOWN_MS,
    );
    if (now - lastTriggerTs < cooldownMs) {
      return; // still in cooldown
    }

    /* ---- 5. Max continuations ---- */
    const maxCont = goal.max_continuations || 200;
    const count = goal.continuation_count || 0;
    if (count >= maxCont) {
      console.log(
        `${LOG} max continuations (${maxCont}) reached — deactivating goal`,
      );
      goal.active = false;
      goal.deactivated_at = new Date(now).toISOString();
      goal.deactivated_reason = "max_continuations_reached";
      await writeGoalStore(store);
      return;
    }

    /* ---- 6. Rapid-fire detection ---- */
    if (now - lastTriggerTs < RAPID_WINDOW_MS) {
      rapidFireCount++;
      if (rapidFireCount >= RAPID_MAX) {
        console.warn(
          `${LOG} rapid-fire detected (${rapidFireCount} in <30s) — emergency pause 120s`,
        );
        emergencyUntil = now + EMERGENCY_MS;
        rapidFireCount = 0;
        return;
      }
    } else {
      rapidFireCount = 0;
    }

    /* ---- 7. Update goal store ---- */
    goal.continuation_count = count + 1;
    goal.last_continuation_at = new Date(now).toISOString();
    await writeGoalStore(store);

    /* ---- 8. Update in-memory state ---- */
    lastTriggerTs = now;

    /* ---- 9. Enqueue continuation system-event ---- */
    const text = [
      `[GOAL AUTO-CONTINUE #${goal.continuation_count}/${maxCont}]`,
      `Active goal: "${goal.text}"`,
      ``,
      `INSTRUCTION: Continue your work from where you left off.`,
      `Do NOT reply with HEARTBEAT_OK.`,
      `Do NOT ask for permission or confirmation.`,
      `Proceed to the next step immediately.`,
      `If ALL tasks described in the goal are genuinely complete, respond with exactly: GOAL_COMPLETE`,
    ].join("\n");

    enqueueSystemEvent(text, { sessionKey });

    /* ---- 10. Schedule heartbeat after a short settle delay ---- */
    const delayMs = Math.max(5000, (goal.delay_seconds || 5) * 1000);
    setTimeout(() => {
      try {
        requestHeartbeatNow({ reason: "cron:goal-continuation" });
        console.log(
          `${LOG} continuation #${goal.continuation_count} triggered ` +
            `(session=${sessionKey}, delay=${delayMs}ms)`,
        );
      } catch (err) {
        console.error(
          `${LOG} heartbeat trigger error:`,
          err?.message || err,
        );
      }
    }, delayMs);
  } catch (err) {
    // CRITICAL: never crash the host process
    console.error(`${LOG} onTurnEnd error:`, err?.message || String(err));
  }
}
