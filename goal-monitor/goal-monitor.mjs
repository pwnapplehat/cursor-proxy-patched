/**
 * Goal Monitor for OpenClaw — Lifecycle Handler Patch
 *
 * When an agent turn completes successfully (lifecycle phase "end")
 * and an active goal exists, this module automatically enqueues a
 * system-event continuation message and triggers a heartbeat run so
 * the agent picks up the goal and keeps working.
 *
 * Safety features:
 *   - Per-goal cooldown (configurable, default 15 s)
 *   - Maximum continuation count per goal (configurable, default 200)
 *   - Rapid-fire loop detection (5 continuations < 30 s apart → 2 min pause)
 *   - Main-session-only filtering (Cursor proxy sessions are ignored)
 *   - Silent error handling (never crashes the host process)
 *
 * Loaded by the patched server-chat.js via dynamic import().
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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

/* ------------------------------------------------------------------ */
/*  Exported entry point — called from patched server-chat.js          */
/* ------------------------------------------------------------------ */

/**
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
      console.log(`${LOG} emergency cooldown active — ${Math.round((emergencyUntil - now) / 1000)}s left`);
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
    const count   = goal.continuation_count || 0;
    if (count >= maxCont) {
      console.log(`${LOG} max continuations (${maxCont}) reached — deactivating goal`);
      goal.active = false;
      goal.deactivated_at     = new Date(now).toISOString();
      goal.deactivated_reason = "max_continuations_reached";
      await writeGoalStore(store);
      return;
    }

    /* ---- 6. Rapid-fire detection ---- */
    if (now - lastTriggerTs < RAPID_WINDOW_MS) {
      rapidFireCount++;
      if (rapidFireCount >= RAPID_MAX) {
        console.warn(`${LOG} rapid-fire detected (${rapidFireCount} in <30s) — emergency pause 120s`);
        emergencyUntil = now + EMERGENCY_MS;
        rapidFireCount = 0;
        return;
      }
    } else {
      rapidFireCount = 0;
    }

    /* ---- 7. Update goal store ---- */
    goal.continuation_count   = count + 1;
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
        // Use "cron:goal" prefix so the heartbeat runner uses
        // CRON_EVENT_PROMPT instead of the default heartbeat prompt.
        // This tells the agent to look at the system messages above.
        requestHeartbeatNow({ reason: "cron:goal-continuation" });
        console.log(
          `${LOG} continuation #${goal.continuation_count} triggered ` +
          `(session=${sessionKey}, delay=${delayMs}ms)`,
        );
      } catch (err) {
        console.error(`${LOG} heartbeat trigger error:`, err?.message || err);
      }
    }, delayMs);
  } catch (err) {
    // CRITICAL: never crash the host process
    console.error(`${LOG} onTurnEnd error:`, err?.message || String(err));
  }
}
