/**
 * Goal Monitor for OpenClaw
 * =========================
 *
 * Two responsibilities:
 *
 * 1. /goal Telegram command — manages goals via the plugin command system.
 *    Registered at startup by registerGoalCommand().
 *
 * 2. onTurnEnd() — AI-gated auto-continuation when the agent finishes a turn.
 *    Called from the patched server-chat.js lifecycle handler.
 *
 *    Flow:
 *      a. server-chat.js captures the agent's response text before the buffer
 *         is cleared (stored in globalThis.__gmLastResponse)
 *      b. On lifecycle "end", onTurnEnd() is called with the response text
 *      c. If an active goal exists, the response is sent to Claude via the
 *         cursor proxy API for analysis
 *      d. Claude returns YES (continue) or NO (stop)
 *      e. Only YES triggers a continuation — NO is silently ignored
 *
 *    This prevents blind continuation on casual messages, greetings,
 *    or any response unrelated to the active goal.
 *
 * Safety:
 *   - AI analysis gate (primary filter — Claude decides YES/NO)
 *   - Max continuations per goal (configurable, default 200)
 *   - Cooldown between continuations (configurable, default 15s)
 *   - Silent error handling (never crashes the host process)
 *   - If AI call fails for any reason → don't continue (fail-safe)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const GOAL_FILE = "/home/node/.openclaw/goals.json";
const CONFIG_FILE = "/home/node/.openclaw/openclaw.json";
const LOG = "[goal-monitor]";

// AI analysis
const DEFAULT_ANALYSIS_MODEL = "claude-4.6-opus-max";
const ANALYSIS_TIMEOUT_MS = 60_000; // 60s timeout for AI call
const MAX_RESPONSE_CHARS = 12_000; // truncate very long responses

// Cooldown (minimum between continuations, also limits AI analysis calls)
const ABS_MIN_COOLDOWN_MS = 10_000; // 10s absolute minimum

// AI analysis system prompt
const ANALYSIS_SYSTEM_PROMPT = `You are a goal monitor for an AI coding agent. Your ONLY job is to decide whether the agent should automatically continue working based on its last response and the active goal.

Rules for YES (agent should continue):
- The agent's response is clearly related to the active goal
- The agent completed a step but the overall goal is NOT finished
- The agent is asking for user permission or confirmation to continue (it should be told to continue)
- The agent paused between phases or tasks described in the goal
- The agent mentioned next steps it plans to take

Rules for NO (agent should NOT continue):
- The agent's response is NOT related to the active goal (casual conversation, greeting, unrelated topic)
- The agent explicitly states ALL work described in the goal is genuinely complete and finished
- The agent hit an unrecoverable error it cannot fix on its own
- The response is a simple acknowledgment like "ok", "sure", "hello" not related to work
- The response is a heartbeat/status check not related to the goal

Output ONLY the single word YES or NO.
No explanation. No reasoning. No quotes. Just the word.`;

/* ------------------------------------------------------------------ */
/*  In-memory state                                                    */
/* ------------------------------------------------------------------ */

let lastTriggerTs = 0;

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
  const idx = parseInt(trimmed, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= goals.length) {
    return goals[idx - 1];
  }
  const lower = trimmed.toLowerCase();
  const matches = goals.filter((g) => g.id.toLowerCase().startsWith(lower));
  return matches.length === 1 ? matches[0] : null;
}

/* ------------------------------------------------------------------ */
/*  Proxy config discovery                                             */
/* ------------------------------------------------------------------ */

let cachedProxyConfig = null;
let proxyConfigReadAt = 0;

async function getProxyConfig() {
  // Cache for 60s to avoid reading config on every call
  if (cachedProxyConfig && Date.now() - proxyConfigReadAt < 60_000) {
    return cachedProxyConfig;
  }

  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    const cfg = JSON.parse(raw);

    const providers = cfg?.ai?.providers;
    if (!providers) return null;

    let found = null;

    // Array format: [{ name, type, baseUrl, apiKey }]
    if (Array.isArray(providers)) {
      // Prefer provider with cursor-proxy in URL
      found = providers.find(
        (p) =>
          p.baseUrl &&
          p.apiKey &&
          (p.baseUrl.includes("cursor-proxy") ||
            p.baseUrl.includes(":3010")),
      );
      // Fallback: first provider with baseUrl + apiKey
      if (!found) {
        found = providers.find((p) => p.baseUrl && p.apiKey);
      }
    }

    // Object format: { "name": { baseUrl, apiKey } }
    if (!found && typeof providers === "object" && !Array.isArray(providers)) {
      for (const key of Object.keys(providers)) {
        const p = providers[key];
        if (p?.baseUrl && p?.apiKey) {
          if (
            p.baseUrl.includes("cursor-proxy") ||
            p.baseUrl.includes(":3010")
          ) {
            found = p;
            break;
          }
          if (!found) found = p;
        }
      }
    }

    if (found) {
      cachedProxyConfig = {
        baseUrl: found.baseUrl.replace(/\/+$/, ""),
        apiKey: found.apiKey,
      };
      proxyConfigReadAt = Date.now();
      return cachedProxyConfig;
    }
  } catch (err) {
    console.error(`${LOG} config read error:`, err?.message || err);
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  AI Analysis Gate                                                   */
/* ------------------------------------------------------------------ */

/**
 * Parse YES/NO from AI response, handling quotes, whitespace, periods.
 */
function parseYesNo(text) {
  if (!text || typeof text !== "string") return false;
  const cleaned = text
    .trim()
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim()
    .toUpperCase();
  return cleaned === "YES";
}

/**
 * Call Claude via the cursor proxy to analyze if the agent should continue.
 *
 * @param {string} responseText — the agent's last response
 * @param {string} goalText — the active goal description
 * @param {string} model — model name to use for analysis
 * @returns {Promise<boolean>} — true if agent should continue
 */
async function analyzeWithAI(responseText, goalText, model) {
  const config = await getProxyConfig();
  if (!config) {
    console.error(`${LOG} cannot reach proxy — no provider config found`);
    return false; // fail-safe: don't continue
  }

  // Truncate very long responses (keep the end which has conclusions)
  let truncatedResponse = responseText;
  if (responseText.length > MAX_RESPONSE_CHARS) {
    truncatedResponse =
      "[...truncated...]\n" +
      responseText.slice(responseText.length - MAX_RESPONSE_CHARS);
  }

  const userPrompt = [
    `ACTIVE GOAL: "${goalText}"`,
    "",
    "AGENT'S LAST RESPONSE:",
    "---",
    truncatedResponse,
    "---",
    "",
    "Based on the goal and the agent's response above, should the agent automatically continue working? Reply YES or NO.",
  ].join("\n");

  const url = `${config.baseUrl}/chat/completions`;
  const body = JSON.stringify({
    model: model || DEFAULT_ANALYSIS_MODEL,
    messages: [
      { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 10,
    stream: false,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(
        `${LOG} AI analysis HTTP ${response.status}: ${errText.slice(0, 200)}`,
      );
      return false; // fail-safe
    }

    const data = await response.json();
    const answer = data?.choices?.[0]?.message?.content || "";
    const decision = parseYesNo(answer);

    console.log(
      `${LOG} AI analysis: raw="${answer.trim()}" → ${decision ? "YES (continue)" : "NO (stop)"}`,
    );
    return decision;
  } catch (err) {
    if (err?.name === "AbortError") {
      console.error(`${LOG} AI analysis timed out after ${ANALYSIS_TIMEOUT_MS}ms`);
    } else {
      console.error(`${LOG} AI analysis error:`, err?.message || String(err));
    }
    return false; // fail-safe: don't continue on error
  } finally {
    clearTimeout(timeout);
  }
}

/* ================================================================== */
/*  PART 1: /goal Telegram Command                                     */
/* ================================================================== */

/**
 * Register /goal as a plugin command for Telegram.
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

async function handleGoalCommand(ctx) {
  try {
    const args = (ctx.args || "").trim();
    if (!args || args.toLowerCase() === "help") {
      return { text: formatHelp() };
    }

    const spaceIdx = args.indexOf(" ");
    const sub =
      spaceIdx === -1
        ? args.toLowerCase()
        : args.slice(0, spaceIdx).toLowerCase();
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
        return await cmdSet(args);
    }
  } catch (err) {
    console.error(`${LOG} command error:`, err?.message || err);
    return { text: "Command failed. Check container logs." };
  }
}

function formatHelp() {
  return [
    "Goal Monitor Commands",
    "",
    "/goal <text> — Set a new goal (shortcut)",
    "/goal set <text> — Set a new goal",
    "/goal set <text> --max N — With max continuations",
    "/goal set <text> --cooldown N — With cooldown (seconds)",
    "/goal set <text> --delay N — With heartbeat delay (seconds)",
    "/goal set <text> --model NAME — Analysis model (default: claude-4.6-opus-max)",
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

async function cmdSet(text) {
  if (!text) {
    return {
      text:
        "Usage: /goal set <description>\n" +
        "Example: /goal set Continue RE till all phases done",
    };
  }

  let maxCont = 200;
  let cooldown = 15;
  let delay = 5;
  let model = DEFAULT_ANALYSIS_MODEL;
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

  const modelMatch = goalText.match(/--model\s+(\S+)/i);
  if (modelMatch) {
    model = modelMatch[1];
    goalText = goalText.replace(modelMatch[0], "").trim();
  }

  if (!goalText) {
    return { text: "Goal text cannot be empty after parsing flags." };
  }

  const store = await readGoalStore();
  if (!store) return { text: "Failed to read goal store." };

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
    analysis_model: model,
    continuation_count: 0,
    last_continuation_at: null,
  };

  store.goals.push(newGoal);
  await writeGoalStore(store);

  lastTriggerTs = 0;

  return {
    text: [
      "Goal set!",
      "",
      `Goal: ${goalText}`,
      `Max: ${maxCont} continuations`,
      `Cooldown: ${cooldown}s`,
      `Delay: ${delay}s`,
      `Model: ${model}`,
      `ID: ${newGoal.id}`,
      "",
      "Agent will auto-continue when AI analysis confirms relevance.",
    ].join("\n"),
  };
}

async function cmdList() {
  const store = await readGoalStore();
  if (!store) return { text: "Failed to read goal store." };

  if (!store.goals.length) {
    return { text: "No goals. Use /goal <text> to create one." };
  }

  const lines = ["Goals:", ""];
  store.goals.forEach((g, i) => {
    const status = g.active ? "[Active]" : "[Paused]";
    const count = g.continuation_count || 0;
    const max = g.max_continuations || 200;
    lines.push(`${i + 1}. ${status} ${g.text}`);
    lines.push(`   ID: ${g.id} | Progress: ${count}/${max}`);
  });

  return { text: lines.join("\n") };
}

async function cmdStatus() {
  const store = await readGoalStore();
  if (!store) return { text: "Failed to read goal store." };

  const active = store.goals.find((g) => g.active);
  if (!active) {
    return { text: "No active goal. Use /goal <text> to set one." };
  }

  const count = active.continuation_count || 0;
  const max = active.max_continuations || 200;
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;

  const lines = [
    "Active Goal",
    "",
    `Goal: ${active.text}`,
    `Progress: ${count}/${max} (${pct}%)`,
    `Cooldown: ${active.cooldown_seconds || 15}s`,
    `Delay: ${active.delay_seconds || 5}s`,
    `Model: ${active.analysis_model || DEFAULT_ANALYSIS_MODEL}`,
    `Created: ${active.created_at || "unknown"}`,
    `Last continuation: ${active.last_continuation_at || "never"}`,
    `ID: ${active.id}`,
  ];

  return { text: lines.join("\n") };
}

async function cmdPause(ref) {
  const store = await readGoalStore();
  if (!store) return { text: "Failed to read goal store." };

  let goal;
  if (!ref) {
    goal = store.goals.find((g) => g.active);
    if (!goal) return { text: "No active goal to pause." };
  } else {
    goal = findGoal(store.goals, ref);
    if (!goal) return { text: `Goal not found: "${ref}"` };
  }

  if (!goal.active) {
    return { text: `Already paused: "${goal.text}"` };
  }

  goal.active = false;
  goal.deactivated_at = new Date().toISOString();
  goal.deactivated_reason = "paused_by_user";
  await writeGoalStore(store);

  return { text: `Paused: "${goal.text}"` };
}

async function cmdResume(ref) {
  const store = await readGoalStore();
  if (!store) return { text: "Failed to read goal store." };

  let goal;
  if (!ref) {
    const inactive = store.goals.filter((g) => !g.active);
    goal = inactive.length ? inactive[inactive.length - 1] : null;
    if (!goal) return { text: "No paused goal to resume." };
  } else {
    goal = findGoal(store.goals, ref);
    if (!goal) return { text: `Goal not found: "${ref}"` };
  }

  if (goal.active) {
    return { text: `Already active: "${goal.text}"` };
  }

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

  lastTriggerTs = 0;

  return { text: `Resumed: "${goal.text}"` };
}

async function cmdDelete(ref) {
  const store = await readGoalStore();
  if (!store) return { text: "Failed to read goal store." };

  let goal;
  if (!ref) {
    goal = store.goals.find((g) => g.active);
    if (!goal) {
      goal = store.goals.length ? store.goals[store.goals.length - 1] : null;
    }
    if (!goal) return { text: "No goals to delete." };
  } else {
    goal = findGoal(store.goals, ref);
    if (!goal) return { text: `Goal not found: "${ref}"` };
  }

  const goalText = goal.text;
  store.goals = store.goals.filter((g) => g.id !== goal.id);
  await writeGoalStore(store);

  return { text: `Deleted: "${goalText}"` };
}

async function cmdReset(ref) {
  const store = await readGoalStore();
  if (!store) return { text: "Failed to read goal store." };

  let goal;
  if (!ref) {
    goal = store.goals.find((g) => g.active);
    if (!goal) return { text: "No active goal to reset." };
  } else {
    goal = findGoal(store.goals, ref);
    if (!goal) return { text: `Goal not found: "${ref}"` };
  }

  goal.continuation_count = 0;
  goal.last_continuation_at = null;
  await writeGoalStore(store);

  lastTriggerTs = 0;

  return { text: `Count reset for: "${goal.text}"` };
}

async function cmdClear() {
  const store = { version: 1, goals: [] };
  await writeGoalStore(store);
  lastTriggerTs = 0;
  return { text: "All goals deleted." };
}

/* ================================================================== */
/*  PART 2: Auto-Continuation with AI Analysis Gate                    */
/* ================================================================== */

/**
 * Called from patched server-chat.js when an agent lifecycle "end" fires.
 *
 * @param {string} sessionKey — session that just finished
 * @param {string} responseText — the agent's full response from this turn
 * @param {object} deps
 * @param {function} deps.enqueueSystemEvent
 * @param {function} deps.requestHeartbeatNow
 */
export async function onTurnEnd(sessionKey, responseText, deps) {
  try {
    const { enqueueSystemEvent, requestHeartbeatNow } = deps;

    /* ---- 1. Read goal store ---- */
    const store = await readGoalStore();
    if (!store) return;

    const goal = (store.goals || []).find((g) => g.active === true);
    if (!goal) return; // no active goal → nothing to do

    const now = Date.now();

    /* ---- 2. Cooldown check ---- */
    const cooldownMs = Math.max(
      (goal.cooldown_seconds || 15) * 1000,
      ABS_MIN_COOLDOWN_MS,
    );
    if (now - lastTriggerTs < cooldownMs) {
      console.log(`${LOG} cooldown active — skipping`);
      return;
    }

    /* ---- 3. Max continuations check ---- */
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

    /* ---- 4. AI Analysis Gate ---- */
    if (!responseText || responseText.trim().length === 0) {
      console.log(`${LOG} empty response — skipping analysis`);
      return;
    }

    console.log(
      `${LOG} analyzing response (${responseText.length} chars) against goal: "${goal.text.slice(0, 80)}"`,
    );

    const shouldContinue = await analyzeWithAI(
      responseText,
      goal.text,
      goal.analysis_model || DEFAULT_ANALYSIS_MODEL,
    );

    if (!shouldContinue) {
      console.log(`${LOG} AI said NO — not continuing`);
      return;
    }

    /* ---- 5. Update goal store ---- */
    goal.continuation_count = count + 1;
    goal.last_continuation_at = new Date(now).toISOString();
    await writeGoalStore(store);

    /* ---- 6. Update in-memory state ---- */
    lastTriggerTs = now;

    /* ---- 7. Enqueue continuation system-event ---- */
    const continuationText = [
      `[GOAL AUTO-CONTINUE #${goal.continuation_count}/${maxCont}]`,
      `Active goal: "${goal.text}"`,
      ``,
      `INSTRUCTION: Continue your work from where you left off.`,
      `Do NOT reply with HEARTBEAT_OK.`,
      `Do NOT ask for permission or confirmation.`,
      `Proceed to the next step immediately.`,
      `If ALL tasks described in the goal are genuinely complete, respond with exactly: GOAL_COMPLETE`,
    ].join("\n");

    enqueueSystemEvent(continuationText, { sessionKey });

    /* ---- 8. Schedule heartbeat after settle delay ---- */
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
