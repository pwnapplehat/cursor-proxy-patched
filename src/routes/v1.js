const express = require('express');
const router = express.Router();
const { fetch, ProxyAgent, Agent } = require('undici');
const { v4: uuidv4, v5: uuidv5 } = require('uuid');
const config = require('../config/config');
const $root = require('../proto/message.js');
const { generateCursorBody, chunkToUtf8String, generateHashed64Hex, generateCursorChecksum, IncrementalFrameParser, processSingleFrame, StreamingToolCallDetector, StreamingToolCallAccumulator, convertNativeToolCall, CURSOR_TOOL_NAMES, expandOcExecCalls } = require('../utils/utils.js');
const { parseToolCalls, hasToolCallTags, normalizeNearMissToolCalls, tryParseToolCallContent } = require('../utils/toolEmulation');
const { createBidiStream, findPendingStream, removePendingStream } = require('../utils/h2-bidi');

// ─── Write-related tool enums ─────────────────────────────────────────────
// Used for provisional ack construction, post-write verification, and error
// injection. Maintained as a Set for O(1) lookup and easy extension if
// Cursor adds new write-related tool types in the future.
const WRITE_TOOL_ENUMS = new Set([
  38, // EDIT_FILE_V2 (write/create file)
  7,  // EDIT_FILE (legacy edit)
  11, // DELETE_FILE (file deletion — also a filesystem mutation)
]);

// Filesystem error patterns that indicate a REAL write failure (not just
// OpenClaw's "no result from tool" default). Used for post-write verification.
const WRITE_FAILURE_PATTERNS = [
  /ENOENT/i, /EACCES/i, /EPERM/i, /ENOSPC/i, /EROFS/i, /EISDIR/i,
  /permission denied/i, /disk full/i, /read.only file system/i,
  /no such file or directory/i, /is a directory/i,
  /cannot create/i, /cannot write/i, /failed to write/i,
];

// ─── Tool Result Detection ───────────────────────────────────────────────
// Detects if incoming messages contain tool results that should be routed
// through an existing bidirectional H2 stream instead of creating a new one.
// Returns ALL tool results (OpenClaw may batch multiple parallel tool results).

function detectToolResults(messages) {
  if (!messages || !Array.isArray(messages)) return [];

  const results = [];
  // Scan from the end — tool results are at the tail of the messages array.
  // Stop when we hit a non-tool message (the assistant message with tool_calls
  // sits right before the tool results).
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'tool' && msg.tool_call_id) {
      results.push({
        toolCallId: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || ''),
        messageIndex: i,
      });
    } else if (msg.role !== 'tool') {
      break; // Stop at the first non-tool message
    }
  }
  return results; // may be empty
}

// ─── Provisional Message Builder ──────────────────────────────────────────
// Constructs the most accurate provisional acknowledgment message possible
// from the available (potentially incomplete) rawArgs. This message is what
// Cursor's model sees as the tool result (protocol constraint: Cursor only
// processes the first result per toolCallId).
//
// For write tools: extracts file_path and estimates content length.
// For other tools: returns a generic success message.
// All parsing is defensive — handles incomplete/malformed JSON gracefully.

function buildProvisionalMessage(toolEnum, rawArgs, toolName) {
  // For write/delete/edit tools, extract file_path and construct appropriate message
  if (WRITE_TOOL_ENUMS.has(toolEnum) && rawArgs) {
    try {
      // Try multiple patterns for file_path (handles both field names Cursor uses)
      const pathPatterns = [
        /"relative_workspace_path"\s*:\s*"([^"]+)"/,
        /"file_path"\s*:\s*"([^"]+)"/,
        /"path"\s*:\s*"([^"]+)"/,
        /"filePath"\s*:\s*"([^"]+)"/,
      ];
      let filePath = null;
      for (const pattern of pathPatterns) {
        const match = rawArgs.match(pattern);
        if (match) {
          filePath = match[1];
          break;
        }
      }

      if (filePath) {
        // DELETE_FILE — no content to measure, just confirm deletion
        if (toolEnum === 11) {
          return `Successfully deleted ${filePath}`;
        }

        // Determine operation type from tool name:
        // - search_replace / edit_file / str_replace → edit (old_string → new_string)
        // - write / edit_file_v2 with contents → create/write
        const EDIT_NAMES = new Set(['search_replace', 'edit_file', 'str_replace']);
        const isEditOp = EDIT_NAMES.has(toolName) ||
          rawArgs.includes('"old_string"') || rawArgs.includes('"new_string"');

        if (isEditOp) {
          return `The file ${filePath} has been edited successfully.`;
        }

        // Estimate content length from what we have so far.
        // Try multiple content field names Cursor might use.
        const contentPatterns = [
          /"contents"\s*:\s*"/,
          /"content"\s*:\s*"/,
          /"new_contents"\s*:\s*"/,
          /"contents_after_edit"\s*:\s*"/,
        ];
        let approxLen = 0;
        for (const pattern of contentPatterns) {
          const contentMatch = rawArgs.match(pattern);
          if (contentMatch) {
            const contentStart = contentMatch.index + contentMatch[0].length;
            approxLen = rawArgs.length - contentStart;
            break;
          }
        }

        let msg = `Successfully created ${filePath}`;
        if (approxLen > 0) msg += ` (${approxLen}+ bytes written)`;
        return msg;
      }
    } catch (e) {
      console.warn(`[h2-bidi] buildProvisionalMessage: parse error (non-fatal): ${e.message}`);
    }
  }

  // Fallback for non-write tools or when file_path couldn't be extracted
  return 'Operation completed successfully';
}

// ─── Write Verification ──────────────────────────────────────────────────
// After OpenClaw returns a tool result for a write operation, verify it.
// Returns { success: boolean, error?: string } so callers can decide
// whether to store a failure for injection into the next turn.

function verifyWriteResult(toolEnum, content) {
  if (!WRITE_TOOL_ENUMS.has(toolEnum)) return { success: true };

  // Empty or missing content — OpenClaw's framework returns "no result from
  // tool" when the handler returns null. This is NORMAL for successful writes
  // (OpenClaw's write handler doesn't return a string). NOT a failure.
  if (!content || content.trim() === '') {
    return { success: true };
  }

  // Check for the specific OpenClaw framework "no result" message.
  // This is the EXPECTED response for a successful write — the handler
  // returns null and the framework fills in this default. NOT a failure.
  if (content.includes('no result from tool')) {
    return { success: true };
  }

  // Check for REAL filesystem errors (ENOENT, EACCES, disk full, etc.)
  for (const pattern of WRITE_FAILURE_PATTERNS) {
    if (pattern.test(content)) {
      return { success: false, error: content };
    }
  }

  // No error patterns matched — treat as success
  return { success: true };
}

// ─── Bidirectional Stream Handler ──────────────────────────────────────────
// Processes a streaming response from a BidiStreamState (h2-bidi), streaming
// text to the Express response as SSE and collecting tool calls.
//
// When tool calls are found, they are registered as pending on the bidiState
// so a continuation request can send the result on the same H2 stream.
//
// Returns: { toolCallsEmitted: boolean } so the caller knows whether to end SSE.

async function streamBidiResponse(bidiState, res, model, responseId, hasTools, tools) {
  return new Promise((resolve, reject) => {
    const seenToolCallIds = new Set();
    const toolCallDetector = new StreamingToolCallDetector();
    // Share flushedIds across all streamBidiResponse calls on the same bidi stream
    // to prevent duplicate tool calls when isLastMessage=true arrives after flushIfComplete
    const toolCallAccumulator = new StreamingToolCallAccumulator(bidiState.flushedStreamingIds);
    const nativeToolCalls = [];
    let allTextAccumulated = '';
    let allThinking = '';
    let firstChunkSent = false;
    let toolCallsEmitted = false;
    let cursorApiError = null; // Cursor API error detected from ConnectRPC error frames

    // ─── Write failure injection ──────────────────────────────────────
    // If the PREVIOUS turn's write operation failed (detected by post-write
    // verification), inject a warning into THIS turn's text output so the
    // model discovers the error and can take corrective action (retry, use
    // exec fallback, etc.). The provisional ack already told the model the
    // write succeeded — this corrects that if it was wrong.
    //
    // We inject ONCE at the start, before any model text, so the warning
    // appears at the beginning of the response.
    let writeFailureWarning = null;
    if (bidiState._writeFailures && bidiState._writeFailures.length > 0) {
      const failures = bidiState._writeFailures;
      const warnings = failures.map(f =>
        `[System: Previous write operation (enum=${f.toolEnum}) FAILED. ` +
        `Error: "${f.error.substring(0, 300)}". ` +
        `The file may not have been created/modified. Please verify and retry.]`
      );
      writeFailureWarning = warnings.join('\n');
      console.warn(`[h2-bidi] Injecting ${failures.length} write failure warning(s) into response`);
      bidiState._writeFailures = []; // Clear after injection
    }

    function sendTextChunk(text) {
      if (!text || res.writableEnded) return;

      // Inject write failure warning before the first text chunk
      if (writeFailureWarning && !firstChunkSent) {
        text = writeFailureWarning + '\n\n' + text;
        writeFailureWarning = null; // Only inject once
      }

      const delta = !firstChunkSent
        ? { role: 'assistant', content: text }
        : { content: text };
      firstChunkSent = true;
      res.write(`data: ${JSON.stringify({
        id: responseId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ index: 0, delta, finish_reason: null }]
      })}\n\n`);
    }

    // Handles a fully-assembled tool call (after streaming accumulation)
    function handleCompletedToolCall(tc) {
      const cursorName = tc.name || CURSOR_TOOL_NAMES[tc.tool] || `cursor_tool_${tc.tool}`;
      console.log(`[h2-bidi] Completed native tool call: ${cursorName} (enum=${tc.tool}, id=${tc.toolCallId}, rawArgs=${tc.rawArgs.length} chars)` +
        (tc.isDuplicate ? ' [DUPLICATE — auto-acking]' : ''));

      // DUPLICATE HANDLING: This tool call was already flushed (either by
      // flushIfComplete after provisional ack, or by force-flush) and emitted
      // to OpenClaw. Cursor continued streaming continuation/isLastMessage
      // frames on the bidi stream. We MUST send a result back to Cursor so it
      // can proceed, but we do NOT forward it to OpenClaw (would cause double
      // execution).
      if (tc.isDuplicate) {
        console.log(`[h2-bidi] Auto-acking duplicate tool call: ${cursorName} (enum=${tc.tool}, id=${tc.toolCallId})`);
        bidiState.sendToolResult(tc.tool, tc.toolCallId, 'OK');
        return;
      }

      const mapped = convertNativeToolCall(tc);
      if (mapped) {
        nativeToolCalls.push({ mapped, original: tc });
      } else {
        // Tool call that convertNativeToolCall couldn't map (e.g., APPLY_AGENT_DIFF).
        // Cursor is WAITING for a result on the H2 stream. If we don't send one,
        // the stream hangs forever. Auto-acknowledge with a minimal success result.
        console.warn(`[h2-bidi] Auto-acking unsupported tool: ${cursorName} (enum=${tc.tool}, id=${tc.toolCallId})`);
        bidiState.sendToolResult(tc.tool, tc.toolCallId, `Tool ${cursorName} acknowledged (proxied)`);
      }
    }

    // ─── Turn inactivity timer ───────────────────────────────────────
    // In bidi mode, Cursor does NOT close the stream after sending a tool
    // call — it keeps the stream open waiting for the result. Without this
    // timer, finalize() only fires on the 5-minute safety timeout, making
    // every tool call round-trip take 5 minutes of dead waiting.
    //
    // This timer fires after the last frame. If we've detected tool calls,
    // that means Cursor is done with its turn → finalize now.
    //
    // OPTIMIZATION (2026-02-06): Reduced from 1500ms to 800ms to cut proxy
    // latency contribution to tool call round-trips. For non-streaming tool
    // calls (ripgrep, web_search, read_file, etc.), FAST_FINALIZE_MS (250ms)
    // is used instead — just enough to catch parallel tool calls in a burst.
    // This reduces the proxy's latency overhead from ~1500ms to ~250ms for
    // the common case, making ERROR_USER_ABORTED_REQUEST much less likely.
    let turnTimer = null;
    let stallCheckCount = 0;
    let provisionalAckSent = false;
    const TURN_INACTIVITY_MS = 800;
    const FAST_FINALIZE_MS = 250;

    // CONFIRMED ROOT CAUSE (diagnostic logs 2026-02-13):
    // Cursor's server sends streaming tool call frames ONLY in response to
    // proper tool result messages. PING, empty ConnectRPC envelopes, and
    // stream.resume() do NOT trigger more frames.
    //
    // SOLUTION: Instead of force-flushing incomplete JSON (which triggers a
    // truncation fallback to exec/heredoc), we send a provisional "OK" result
    // directly to Cursor to trigger the next batch of streaming frames. Those
    // frames contain the COMPLETE JSON, which we then emit as a real tool call
    // to OpenClaw. This lets the native write tool work end-to-end.
    //
    // Flow: 0.8s check → 1.6s provisional ack → continuation arrives → complete
    // JSON detected by flushIfComplete → real tool call emitted → finalize.
    // stallCheckCount resets to 0 on every streaming frame, so force-flush
    // only triggers after 15s of CONSECUTIVE silence (no frames at all) —
    // making it safe for files of any size, no matter how long streaming takes.

    function resetTurnTimer(overrideMs) {
      if (turnTimer) clearTimeout(turnTimer);
      turnTimer = setTimeout(() => {
        if (toolCallsEmitted) return; // Already finalized

        // Try to flush streaming calls with complete JSON (e.g., web_search)
        if (toolCallAccumulator.hasPending()) {
          const completeFlushed = toolCallAccumulator.flushIfComplete();
          if (completeFlushed.length > 0) {
            console.log(`[h2-bidi] Turn inactivity (${TURN_INACTIVITY_MS}ms) — flushing ${completeFlushed.length} complete streaming tool call(s)`);
            for (const tc of completeFlushed) {
              handleCompletedToolCall(tc);
            }
          }
        }

        if (nativeToolCalls.length > 0) {
          console.log(`[h2-bidi] Turn inactivity (${TURN_INACTIVITY_MS}ms) — ${nativeToolCalls.length} tool call(s) detected, finalizing turn`);
          finalize();
        } else if (toolCallAccumulator.hasPending()) {
          stallCheckCount++;

          if (!provisionalAckSent && stallCheckCount >= 2) {
            // 3s total: Cursor paused after first streaming batch (incomplete JSON).
            // Send a provisional result directly to Cursor to trigger the next batch.
            // Do NOT flush to OpenClaw — wait for the complete JSON to arrive.
            //
            // WHY THIS IS NECESSARY (protocol constraint, not a workaround):
            // Cursor's server will NOT release continuation frames until it receives
            // a ClientSideToolV2Result. This was verified with diagnostic logs —
            // PINGs, empty envelopes, and stream.resume() do NOT trigger frames.
            // Only a proper tool result does. Additionally, Cursor only processes
            // the FIRST result for a given toolCallId — subsequent results satisfy
            // the isLastMessage handshake but are NOT shown to the model. Therefore
            // this provisional message IS the tool result the model sees.
            //
            // STRATEGY: Construct the most accurate message possible from the
            // available (even incomplete) rawArgs. For write tools, extract the
            // file_path and estimate content size. For other tools, use a generic
            // success message. This is an "optimistic acknowledgment" — the write
            // WILL execute via OpenClaw once continuation completes the JSON.
            const pendingEntries = toolCallAccumulator.getPendingEntries();
            for (const { toolCallId, tool, name: toolName, rawArgs } of pendingEntries) {
              const provisionalMsg = buildProvisionalMessage(tool, rawArgs, toolName);
              console.log(`[h2-bidi] Sending provisional ack to trigger continuation: ${toolCallId} (enum=${tool}, name=${toolName}) msg="${provisionalMsg}"`);
              bidiState.sendToolResult(tool, toolCallId, provisionalMsg);
            }
            provisionalAckSent = true;
            stallCheckCount = 0; // Reset — give time for continuation frames to arrive
          } else if (provisionalAckSent && stallCheckCount >= 10) {
            // ~8s of CONSECUTIVE silence (no streaming frames at all) after
            // provisional ack — stream is genuinely dead. stallCheckCount resets
            // to 0 on every streaming frame, so this only fires when data has
            // truly stopped. Safe for large files that stream for minutes.
            console.warn(`[h2-bidi] No streaming frames for ${stallCheckCount * TURN_INACTIVITY_MS}ms after provisional ack — force-flushing`);
            const forceFlushed = toolCallAccumulator.flush();
            for (const tc of forceFlushed) {
              handleCompletedToolCall(tc);
            }
            if (nativeToolCalls.length > 0) {
              finalize();
              return;
            }
          } else {
            console.log(`[h2-bidi] Turn inactivity — incomplete streaming call(s) pending, check #${stallCheckCount}` +
              (provisionalAckSent ? ' (waiting for continuation after provisional ack)' : ''));
          }
          resetTurnTimer();
        }
      }, overrideMs || TURN_INACTIVITY_MS);
    }

    function onFrame({ magic, data }) {
      // NOTE: resetTurnTimer() is called at the END of onFrame (not here)
      // with smart timeout selection — see bottom of this function.
      resetSafetyTimeout(); // Keep safety timeout alive while data is flowing

      const { text, thinking, nativeToolCalls: frameTCs, error: frameError } =
        processSingleFrame(magic, data, seenToolCallIds);

      // Capture Cursor API errors (e.g., ERROR_CONVERSATION_TOO_LONG) so
      // finalize() can send them as proper OpenAI-format errors that trigger
      // OpenClaw's auto-compaction (summarization) instead of silently failing.
      if (frameError && !cursorApiError) {
        cursorApiError = frameError;
        console.warn(`[h2-bidi:onFrame] Captured Cursor API error: type=${frameError.type} code=${frameError.code}`);
      }

      // Feed each frame's tool calls through the streaming accumulator.
      // Non-streaming calls pass through immediately. Streaming calls are
      // accumulated until is_last_message=true, then emitted as complete.
      if (frameTCs.length > 0) {
        console.log(`[DIAG:bidi:onFrame] Processing ${frameTCs.length} tool call(s) from frame (magic=${magic})`);
      }
      for (const tc of frameTCs) {
        if (tc.isStreaming || tc.isLastMessage) {
          // DYNAMIC STALL DETECTION: Any new streaming frame proves data is
          // still flowing. Reset the stall counter so force-flush only triggers
          // after consecutive silent periods with ZERO frames — not after a
          // cumulative count that ignores active streaming. This makes the
          // approach work for ANY file size, no matter how long streaming takes.
          stallCheckCount = 0;
          console.log(`[DIAG:bidi:onFrame] Feeding STREAMING tc to accumulator: id=${tc.toolCallId.substring(0, 20)} isStreaming=${tc.isStreaming} isLastMessage=${tc.isLastMessage}`);
          const completed = toolCallAccumulator.feed(tc);
          if (completed) {
            console.log(`[DIAG:bidi:onFrame] Accumulator RETURNED completed tc: id=${completed.toolCallId.substring(0, 20)} rawArgs.len=${completed.rawArgs.length}`);
            handleCompletedToolCall(completed);
          } else {
            console.log(`[DIAG:bidi:onFrame] Accumulator returned null — still accumulating`);
          }
        } else {
          // Non-streaming — handle immediately
          console.log(`[DIAG:bidi:onFrame] Non-streaming tc — handling immediately: id=${tc.toolCallId.substring(0, 20)}`);
          handleCompletedToolCall(tc);
        }
      }

      if (thinking) allThinking += thinking;

      if (text) {
        allTextAccumulated += text;
        const safeText = toolCallDetector.addText(text);
        if (safeText) {
          if (allThinking && !firstChunkSent) {
            sendTextChunk('<thinking> ' + allThinking + ' </thinking> ' + safeText);
            allThinking = '';
          } else {
            sendTextChunk(safeText);
          }
        }
      }

      // Smart turn timer: use FAST_FINALIZE_MS (250ms) when we have completed
      // non-streaming tool calls and no streaming calls are still accumulating.
      // This reduces latency for common tool calls (ripgrep, web_search, read)
      // from 800ms to ~250ms. The 250ms buffer catches parallel tool calls
      // in the same response burst. For streaming calls (edit_file_v2 writes),
      // use the full 800ms timer which feeds into the provisional ack and
      // force-flush logic.
      if (nativeToolCalls.length > 0 && !toolCallAccumulator.hasPending()) {
        resetTurnTimer(FAST_FINALIZE_MS);
      } else {
        resetTurnTimer();
      }
    }

    function finalize() {
      // Start buffering BEFORE removing listeners to prevent frame loss.
      // Any frames arriving between now and the next streamBidiResponse()
      // call will be safely buffered rather than emitted to nobody.
      bidiState._waitingForToolResult = true;

      bidiState.removeListener('frame', onFrame);
      bidiState.removeListener('end', onEnd);
      bidiState.removeListener('error', onError);

      const { remainingText, toolCallBlocks } = toolCallDetector.finish();

      if (allThinking && !firstChunkSent) {
        sendTextChunk('<thinking> ' + allThinking + ' </thinking> ');
      }
      if (remainingText) sendTextChunk(remainingText);

      // Flush any streaming tool calls that were still accumulating when the
      // stream ended. These are incomplete but we process them best-effort.
      const flushed = toolCallAccumulator.flush();
      for (const tc of flushed) {
        handleCompletedToolCall(tc);
      }

      console.log(`[h2-bidi] Response: ${allTextAccumulated.length} chars, preview: ${allTextAccumulated.substring(0, 300).replace(/\n/g, '\\n')}`);

      // ─── Collect all tool calls ─────────────────────────────────────
      const allToolCalls = [];

      for (const { mapped, original } of nativeToolCalls) {
        if (mapped.truncated) {
          sendTextChunk(`\n${mapped.hint}\n`);
          const safeFilePath = (mapped.filePath || 'file').replace(/'/g, "'\\''");
          const callId = `call_${uuidv4()}`;
          allToolCalls.push({
            id: callId,
            type: 'function',
            function: { name: 'exec', arguments: JSON.stringify({ command: `echo "Ready for chunked heredoc write to: ${safeFilePath}"` }) },
            _cursorToolCallId: original.toolCallId,
            _toolEnum: original.tool,
          });
        } else {
          const callId = `call_${uuidv4()}`;
          allToolCalls.push({
            id: callId,
            type: 'function',
            function: { name: mapped.name, arguments: JSON.stringify(mapped.arguments) },
            _cursorToolCallId: original.toolCallId,
            _toolEnum: original.tool,
          });
        }
      }

      for (const block of toolCallBlocks) {
        const parsed = tryParseToolCallContent(block, tools);
        if (parsed) allToolCalls.push(parsed);
      }

      if (allToolCalls.length === 0 && allTextAccumulated.length > 0) {
        const normalized = normalizeNearMissToolCalls(allTextAccumulated);
        if (hasToolCallTags(normalized)) {
          const { toolCalls: fallbackCalls } = parseToolCalls(normalized, tools);
          for (const tc of fallbackCalls) allToolCalls.push(tc);
        }
      }

      const finalToolCalls = expandOcExecCalls(allToolCalls);

      // ─── Emit tool calls or stop ─────────────────────────────────────
      if (finalToolCalls.length > 0) {
        console.log(`[h2-bidi] Emitting ${finalToolCalls.length} tool call(s): ${finalToolCalls.map(tc => tc.function.name).join(', ')}`);

        // Register pending tool calls on the bidiState for continuation
        bidiState.startBuffering();
        for (const tc of finalToolCalls) {
          if (tc._cursorToolCallId) {
            bidiState.registerPendingToolCall(tc.id, tc._cursorToolCallId, tc._toolEnum);
          }
        }

        for (let i = 0; i < finalToolCalls.length; i++) {
          const tc = finalToolCalls[i];
          res.write(`data: ${JSON.stringify({
            id: responseId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.function.name, arguments: tc.function.arguments }
                }]
              },
              finish_reason: null
            }]
          })}\n\n`);
        }

        res.write(`data: ${JSON.stringify({
          id: responseId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
        })}\n\n`);

        toolCallsEmitted = true;
      } else {
        // ─── Cursor API error handling ──────────────────────────────────
        // If we detected a Cursor-specific error (e.g., ERROR_CONVERSATION_TOO_LONG),
        // send it as a proper OpenAI-format error that OpenClaw/pi-ai can parse.
        // This is CRITICAL for context overflow errors: OpenClaw's isContextOverflowError()
        // matches patterns like "context length exceeded" and "prompt is too long", and
        // when matched, triggers auto-compaction (summarization) to shrink the context.
        // Without this, context overflow silently appears as an empty response.
        if (cursorApiError && cursorApiError.type === 'context_overflow') {
          console.error(`[h2-bidi] CONTEXT OVERFLOW detected — sending OpenAI-format error to trigger compaction`);
          console.error(`[h2-bidi]   Error: ${cursorApiError.message}`);

          // Send the error as an OpenAI-format SSE error that pi-ai will parse
          // as an API error, allowing OpenClaw to detect it and trigger compaction.
          // The message text is specifically crafted to match OpenClaw's
          // isContextOverflowError() patterns (from errors.ts):
          //   - "context length exceeded" ✓
          //   - "prompt is too long" ✓
          //   - "exceeds model context window" ✓ (in the message)
          res.write(`data: ${JSON.stringify({
            error: {
              message: cursorApiError.message,
              type: 'invalid_request_error',
              code: cursorApiError.code,
            }
          })}\n\n`);

          bidiState.close();
        } else if (cursorApiError && cursorApiError.type === 'user_aborted') {
          // ERROR_USER_ABORTED_REQUEST — Cursor's server aborted the stream.
          // This is a SERVER-SIDE timeout (not our proxy). Cursor's backend has
          // a deadline for receiving tool results; if the full round-trip
          // (proxy → OpenClaw → VPS tool execution → OpenClaw → proxy → Cursor)
          // exceeds that deadline, Cursor aborts with this error.
          //
          // CRITICAL FIX (2026-02-14): The old approach injected a TEXT message
          // with finish_reason:'stop'. OpenClaw treated this as a normal final
          // response, sent it to the user, and STOPPED the agent loop. The agent
          // died every time Cursor aborted.
          //
          // NEW APPROACH: Inject a SYNTHETIC TOOL CALL with finish_reason:'tool_calls'.
          // This forces OpenClaw to continue the agent loop:
          //   1. OpenClaw sees a tool call → executes it (harmless exec echo)
          //   2. OpenClaw sends the result back as a new API request
          //   3. The proxy finds no pending stream (old one is closed)
          //   4. Falls through to create a NEW bidi stream with full context
          //   5. Cursor processes it as a fresh request → agent continues
          //
          // This makes the agent survive Cursor server-side aborts automatically.
          const responseIsEmpty = !allTextAccumulated || allTextAccumulated.trim().length === 0;

          if (responseIsEmpty && hasTools) {
            console.warn('[h2-bidi] User aborted with EMPTY response — injecting synthetic tool call to keep agent alive');

            // Synthetic exec tool call — harmless echo that keeps the loop alive
            const syntheticCallId = `call_${uuidv4()}`;
            const syntheticArgs = JSON.stringify({
              command: 'echo "[proxy-recovery] Cursor API interrupted this request. The agent is resuming automatically. No action needed."'
            });

            // Send the tool call chunk (same format as real tool calls at line 529-548)
            res.write(`data: ${JSON.stringify({
              id: responseId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: syntheticCallId,
                    type: 'function',
                    function: { name: 'exec', arguments: syntheticArgs }
                  }]
                },
                finish_reason: null
              }]
            })}\n\n`);

            // Send finish_reason: tool_calls (forces OpenClaw to execute and continue)
            res.write(`data: ${JSON.stringify({
              id: responseId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
            })}\n\n`);

            toolCallsEmitted = true;
            bidiState.close();
          } else {
            // Response had content (text was already streamed) — send stop
            if (hasTools) {
              console.warn('[h2-bidi] WARNING: User aborted request — response had content but no tool calls emitted.');
            }
            res.write(`data: ${JSON.stringify({
              id: responseId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            })}\n\n`);

            bidiState.close();
          }
        } else {
          if (hasTools) {
            console.warn('[h2-bidi] WARNING: Tools provided but model did not output any tool calls.');
          }
          res.write(`data: ${JSON.stringify({
            id: responseId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`);

          // No tool calls — stream is done, close it
          bidiState.close();
        }
      }

      resolve({ toolCallsEmitted });
    }

    function onEnd() {
      finalize();
    }

    function onError(err) {
      console.error(`[h2-bidi] Stream error during response: ${err.message}`);
      finalize();
    }

    // DYNAMIC safety timeout: resets on every frame so large files that stream
    // for minutes (or even hours) are never killed. Only fires after 5 minutes
    // of ZERO activity (no frames at all), which means the stream is truly dead.
    // This replaces the old fixed 5-minute timer that would kill long-running
    // streaming responses regardless of whether data was still flowing.
    //
    // IMPORTANT: Must be declared BEFORE attaching listeners / processing
    // buffered frames, because onFrame() calls resetSafetyTimeout().
    const SAFETY_TIMEOUT_MS = 5 * 60 * 1000;
    let safetyTimeout = setTimeout(() => {
      console.warn('[h2-bidi] Safety timeout (5 min no frames) — finalizing response');
      finalize();
    }, SAFETY_TIMEOUT_MS);

    function resetSafetyTimeout() {
      clearTimeout(safetyTimeout);
      safetyTimeout = setTimeout(() => {
        console.warn('[h2-bidi] Safety timeout (5 min no frames) — finalizing response');
        finalize();
      }, SAFETY_TIMEOUT_MS);
    }

    // Override finalize to clear all timers (must be before any code that
    // might call finalize, including buffered frame processing below).
    const originalFinalize = finalize;
    let finalized = false;
    // eslint-disable-next-line no-func-assign
    finalize = function() {
      if (finalized) return;
      finalized = true;
      clearTimeout(safetyTimeout);
      if (turnTimer) clearTimeout(turnTimer);
      originalFinalize();
    };

    // Attach listeners
    bidiState.on('frame', onFrame);
    bidiState.on('end', onEnd);
    bidiState.on('error', onError);

    // If the bidiState already has frames buffered (from continuation), process them
    const buffered = bidiState.flushBufferedFrames();
    for (const frame of buffered) {
      onFrame(frame);
    }

    // CRITICAL: If the H2 stream already ended (e.g., Cursor responded while
    // we were waiting for OpenClaw's tool result), the 'end' event was already
    // emitted and won't re-fire. Detect this and finalize immediately.
    if (bidiState.ended) {
      console.log('[h2-bidi] Stream already ended — finalizing immediately');
      finalize();
      return; // Don't set up safety/turn timers — we're done
    }

    // If buffered frames already contained tool calls, start the turn timer
    // so we finalize quickly once Cursor stops sending more frames.
    if (nativeToolCalls.length > 0) {
      resetTurnTimer();
    }
  });
}

router.get("/models", async (req, res) => {
  try{
    let bearerToken = req.headers.authorization?.replace('Bearer ', '');
    let authToken = bearerToken.split(',').map((key) => key.trim())[0];

    if (authToken && authToken.includes('%3A%3A')) {
      authToken = authToken.split('%3A%3A')[1];
    } else if (authToken && authToken.includes('::')) {
      authToken = authToken.split('::')[1];
    }

    const cursorChecksum = req.headers['x-cursor-checksum'] ?? generateCursorChecksum(authToken.trim());
    const cursorClientVersion = "2.4.28"

    const availableModelsResponse = await fetch("https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels", {
      method: 'POST',
      headers: {
        'accept-encoding': 'gzip',
        'authorization': `Bearer ${authToken}`,
        'connect-protocol-version': '1',
        'content-type': 'application/proto',
        'user-agent': 'connect-es/1.6.1',
        'x-cursor-checksum': cursorChecksum,
        'x-cursor-client-version': cursorClientVersion,
        'x-cursor-config-version': uuidv4(),
        'x-cursor-timezone': 'Asia/Shanghai',
        'x-ghost-mode': 'true',
        'Host': 'api2.cursor.sh',
      },
    })

    const data = await availableModelsResponse.arrayBuffer();
    const buffer = Buffer.from(data);

    try{
      const models = $root.AvailableModelsResponse.decode(buffer).models;
      return res.json({
        object: "list",
        data: models.map(model => ({
          id: model.name,
          created: Date.now(),
          object: 'model',
          owned_by: 'cursor'
        }))
      })
    } catch (error) {
      const text = buffer.toString('utf-8');
      throw new Error(text);
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: 'Internal server error',
    });
  }
})

router.post('/chat/completions', async (req, res) => {
  try {
    const { model, messages, stream = false, tools, tool_choice } = req.body;

    // === DEBUG LOGGING: what OpenClaw actually sends ===
    const toolNames = (tools && Array.isArray(tools))
      ? tools.map(t => t?.function?.name || 'unknown').join(', ')
      : 'NONE';
    const roleBreakdown = messages
      ? messages.map(m => m.role).reduce((acc, r) => { acc[r] = (acc[r] || 0) + 1; return acc; }, {})
      : {};
    console.log(`[chat/completions] model=${model} stream=${stream} tools=[${toolNames}] tool_choice=${JSON.stringify(tool_choice || null)} messages=${JSON.stringify(roleBreakdown)}`);
    // === END DEBUG LOGGING ===

    let bearerToken = req.headers.authorization?.replace('Bearer ', '');
    const keys = bearerToken.split(',').map((key) => key.trim());
    let authToken = keys[Math.floor(Math.random() * keys.length)]

    if (!messages || !Array.isArray(messages) || messages.length === 0 || !authToken) {
      return res.status(400).json({
        error: 'Invalid request. Messages should be a non-empty array and authorization is required',
      });
    }

    if (authToken && authToken.includes('%3A%3A')) {
      authToken = authToken.split('%3A%3A')[1];
    } else if (authToken && authToken.includes('::')) {
      authToken = authToken.split('::')[1];
    }

    const hasTools = tools && Array.isArray(tools) && tools.length > 0;
    const cursorChecksum = req.headers['x-cursor-checksum'] ?? generateCursorChecksum(authToken.trim());
    const sessionid = uuidv5(authToken, uuidv5.DNS);
    const clientKey = generateHashed64Hex(authToken)
    const cursorClientVersion = "2.4.28"
    const cursorConfigVersion = uuidv4();

    // Request the AvailableModels before StreamChat.
    const availableModelsResponse = fetch("https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels", {
      method: 'POST',
      headers: {
        'accept-encoding': 'gzip',
        'authorization': `Bearer ${authToken}`,
        'connect-protocol-version': '1',
        'content-type': 'application/proto',
        'user-agent': 'connect-es/1.6.1',
        'x-amzn-trace-id': `Root=${uuidv4()}`,
        'x-client-key': clientKey,
        'x-cursor-checksum': cursorChecksum,
        'x-cursor-client-version': cursorClientVersion,
        'x-cursor-config-version': cursorConfigVersion,
        'x-cursor-timezone': 'Asia/Shanghai',
        'x-ghost-mode': 'true',
        "x-request-id": uuidv4(),
        "x-session-id": sessionid,
        'Host': 'api2.cursor.sh',
      },
    })

    // Pass tools + tool_choice to generateCursorBody for injection
    const cursorBody = generateCursorBody(messages, model, tools, tool_choice);

    // ─── BIDIRECTIONAL STREAMING PATH ─────────────────────────────────────
    // Attempts to use HTTP/2 bidirectional streaming for tool call support.
    // If this succeeds, the handler returns early — no fetch() needed.
    // If it fails (or is inapplicable), execution falls through to the
    // existing fetch-based path below.
    if (stream) {
      let bidiHandled = false;

      // --- Case 1: Tool result continuation ---
      // Check if the incoming messages contain tool results that map to
      // an existing open H2 stream. If so, send ALL results on that stream
      // and continue receiving the AI response.
      const toolResults = detectToolResults(messages);
      if (toolResults.length > 0) {
        // Find the bidiState from ANY of the tool results
        let bidiState = null;
        for (const tr of toolResults) {
          bidiState = findPendingStream(tr.toolCallId);
          if (bidiState && !bidiState.ended) break;
          bidiState = null;
        }

        if (bidiState) {
          let allMapped = true;
          const mappings = [];
          for (const tr of toolResults) {
            const mapping = bidiState.pendingToolCalls.get(tr.toolCallId);
            if (mapping) {
              mappings.push({ ...mapping, toolCallId: tr.toolCallId, content: tr.content });
            } else {
              // This tool result has no Cursor-side mapping (e.g., text-based tool call)
              // — we can't route it through the H2 stream
              allMapped = false;
            }
          }

          if (mappings.length > 0) {
            console.log(`[h2-bidi] ▸ Routing ${mappings.length} tool result(s) on existing H2 stream`);

            // Send ALL tool results on the stream + verify write operations
            for (const m of mappings) {
              console.log(`[h2-bidi]   → ${m.toolCallId} → cursor:${m.cursorToolCallId} (enum=${m.toolEnum})`);
              bidiState.sendToolResult(m.toolEnum, m.cursorToolCallId, m.content);

              // POST-WRITE VERIFICATION: Check if OpenClaw's result indicates
              // a real filesystem error. "no result from tool" is NORMAL (success).
              // Only ENOENT, EACCES, ENOSPC, etc. are real failures.
              if (WRITE_TOOL_ENUMS.has(m.toolEnum)) {
                const verification = verifyWriteResult(m.toolEnum, m.content);
                if (verification.success) {
                  console.log(`[h2-bidi] ✓ WRITE VERIFIED OK: ${m.toolCallId} (enum=${m.toolEnum}) — ` +
                    `OpenClaw result: "${(m.content || '').substring(0, 200)}"`);
                } else {
                  console.error(`[h2-bidi] ✗ WRITE VERIFICATION FAILED: ${m.toolCallId} (enum=${m.toolEnum}) — ` +
                    `error: "${verification.error.substring(0, 300)}"`);
                  // Store failure on bidiState for injection into the next turn.
                  // The model was already told (via provisional ack) that the write
                  // succeeded. If it actually failed, we MUST correct this by
                  // injecting a warning into the next response the model generates.
                  if (!bidiState._writeFailures) bidiState._writeFailures = [];
                  bidiState._writeFailures.push({
                    toolCallId: m.toolCallId,
                    toolEnum: m.toolEnum,
                    error: verification.error,
                    timestamp: Date.now(),
                  });
                }
              }

              removePendingStream(m.toolCallId);
            }

            // Set up SSE response
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            const responseId = `chatcmpl-${uuidv4()}`;

            try {
              await streamBidiResponse(bidiState, res, model, responseId, hasTools, tools);
            } catch (contErr) {
              console.error(`[h2-bidi] Continuation error: ${contErr.message}`);
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ error: `Continuation error: ${contErr.message}` })}\n\n`);
              }
            } finally {
              if (!res.writableEnded) {
                res.write('data: [DONE]\n\n');
                res.end();
              }
            }
            return; // Handled — do not fall through
          }
        }
        console.log(`[h2-bidi] No pending stream for tool results [${toolResults.map(r => r.toolCallId).join(', ')}] — falling back to fetch`);
      }

      // --- Case 2: Fresh request — try H2 bidirectional stream ---
      // Only when streaming is requested and no HTTP proxy is configured
      // (HTTP proxies cannot relay H2 bidirectional streams).
      if (!config.proxy.enabled) {
        try {
          const bidiHeaders = {
            'x-amzn-trace-id': `Root=${uuidv4()}`,
            'x-client-key': clientKey,
            'x-cursor-checksum': cursorChecksum,
            'x-cursor-client-version': cursorClientVersion,
            'x-cursor-config-version': cursorConfigVersion,
            'x-cursor-timezone': 'Asia/Shanghai',
            'x-request-id': uuidv4(),
            'x-session-id': sessionid,
          };

          const bidiState = await createBidiStream(authToken, bidiHeaders, cursorBody);
          console.log(`[h2-bidi] ▸ Bidirectional stream opened for fresh request`);

          // Set up SSE response
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          const responseId = `chatcmpl-${uuidv4()}`;

          try {
            await streamBidiResponse(bidiState, res, model, responseId, hasTools, tools);
            bidiHandled = true;
          } catch (bidiStreamErr) {
            console.error(`[h2-bidi] Stream processing error: ${bidiStreamErr.message}`);
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ error: `Stream error: ${bidiStreamErr.message}` })}\n\n`);
            }
            bidiHandled = true; // Still handled — error was sent
          } finally {
            if (!res.writableEnded) {
              res.write('data: [DONE]\n\n');
              res.end();
            }
          }

          if (bidiHandled) return; // Success — skip fetch path
        } catch (bidiConnectErr) {
          console.warn(`[h2-bidi] Failed to create bidirectional stream: ${bidiConnectErr.message} — falling back to fetch`);
          // Fall through to fetch path
        }
      }
    }
    // ─── END BIDIRECTIONAL STREAMING PATH ─────────────────────────────────

    // ─── FETCH-BASED FALLBACK PATH ───────────────────────────────────────
    // Used when: (1) H2 bidi fails, (2) HTTP proxy is configured, (3) non-streaming.
    // Disable all undici-level timeouts on the dispatcher so large-context
    // requests to Cursor are never killed.  bodyTimeout=0 and headersTimeout=0
    // mean "wait forever" — the connection stays open until Cursor responds.
    const dispatcherOpts = {
      allowH2: true,
      bodyTimeout: 0,
      headersTimeout: 0,
      keepAliveTimeout: 600000,
      keepAliveMaxTimeout: 600000,
    };
    const dispatcher = config.proxy.enabled
      ? new ProxyAgent(config.proxy.url, dispatcherOpts)
      : new Agent(dispatcherOpts);

    const response = await fetch('https://api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${authToken}`,
        'connect-accept-encoding': 'gzip',
        'connect-content-encoding': 'gzip',
        'connect-protocol-version': '1',
        'content-type': 'application/connect+proto',
        'user-agent': 'connect-es/1.6.1',
        'x-amzn-trace-id': `Root=${uuidv4()}`,
        'x-client-key': clientKey,
        'x-cursor-checksum': cursorChecksum,
        'x-cursor-client-version': cursorClientVersion,
        'x-cursor-config-version': cursorConfigVersion,
        'x-cursor-timezone': 'Asia/Shanghai',
        'x-ghost-mode': 'true',
        'x-request-id': uuidv4(),
        'x-session-id': sessionid,
        'Host': 'api2.cursor.sh'
      },
      body: cursorBody,
      dispatcher: dispatcher,
      // Disable all fetch-level timeouts so overnight 24h agent runs
      // are never killed by the proxy.  Cursor can take minutes to
      // respond when context is large (400+ messages).  Setting 0
      // means "no timeout" for undici — the connection stays open
      // indefinitely until Cursor finishes or the TCP socket dies.
      timeout: {
        connect: 0,
        read: 0
      }
    });

    if (response.status !== 200) {
      return res.status(response.status).json({ error: response.statusText });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const responseId = `chatcmpl-${uuidv4()}`;

      // ─── Real-time Streaming with Tool Call Detection ─────────────────
      // Process protobuf frames incrementally as they arrive from Cursor.
      // Text content → streamed to OpenClaw immediately via SSE delta chunks.
      // Native tool calls (protobuf) → collected separately, emitted at end.
      // Text-based <tool_call> tags → detected by StreamingToolCallDetector,
      //   held back from the text stream, parsed and emitted at end.
      //
      // This enables OpenClaw's Telegram draft streaming (streamMode: "partial")
      // which edits messages in real-time as tokens arrive (300ms throttle).
      // Previously, the proxy buffered the ENTIRE response (5-70+ seconds)
      // before sending ANY SSE chunks, blocking all real-time feedback.
      const frameParser = new IncrementalFrameParser();
      const toolCallDetector = new StreamingToolCallDetector();
      const toolCallAccumulator = new StreamingToolCallAccumulator();
      const nativeToolCalls = [];
      const seenToolCallIds = new Set();
      let allTextAccumulated = '';
      let allThinking = '';
      let firstChunkSent = false;

      /** Send a text content SSE chunk to OpenClaw */
      function sendTextChunk(text) {
        if (!text || res.writableEnded) return;
        const delta = !firstChunkSent
          ? { role: 'assistant', content: text }
          : { content: text };
        firstChunkSent = true;
        res.write(`data: ${JSON.stringify({
          id: responseId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{ index: 0, delta, finish_reason: null }]
        })}\n\n`);
      }

      try {
        // Process protobuf frames as they arrive from Cursor's streaming response.
        // Each frame is decoded immediately — text is streamed, tool calls collected.
        let chunksReceived = 0;
        try {
          for await (const chunk of response.body) {
            chunksReceived++;
            const frames = frameParser.addChunk(Buffer.from(chunk));

            for (const frame of frames) {
              const { text, thinking, nativeToolCalls: frameTCs } =
                processSingleFrame(frame.magic, frame.data, seenToolCallIds);

              // Feed tool calls through the streaming accumulator.
              // Streaming calls (e.g., EDIT_FILE_V2 with large rawArgs) are
              // accumulated across frames until is_last_message=true.
              if (frameTCs.length > 0) {
                console.log(`[DIAG:fetch:onFrame] Processing ${frameTCs.length} tool call(s) from frame`);
              }
              for (const tc of frameTCs) {
                let completed;
                if (tc.isStreaming || tc.isLastMessage) {
                  console.log(`[DIAG:fetch:onFrame] Feeding STREAMING tc to accumulator: id=${tc.toolCallId.substring(0, 20)} isStreaming=${tc.isStreaming} isLastMessage=${tc.isLastMessage}`);
                  completed = toolCallAccumulator.feed(tc);
                  if (completed) {
                    console.log(`[DIAG:fetch:onFrame] Accumulator RETURNED completed: id=${completed.toolCallId.substring(0, 20)} rawArgs.len=${completed.rawArgs.length}`);
                  } else {
                    console.log(`[DIAG:fetch:onFrame] Accumulator returned null — still accumulating`);
                  }
                } else {
                  console.log(`[DIAG:fetch:onFrame] Non-streaming tc — using directly: id=${tc.toolCallId.substring(0, 20)}`);
                  completed = tc; // Non-streaming — already complete
                }
                if (completed) {
                  const cursorName = completed.name || CURSOR_TOOL_NAMES[completed.tool] || `cursor_tool_${completed.tool}`;
                  console.log(`[streaming] Completed native tool call: ${cursorName} (enum=${completed.tool}, id=${completed.toolCallId}, rawArgs=${completed.rawArgs.length} chars)`);
                  const mapped = convertNativeToolCall(completed);
                  if (mapped) nativeToolCalls.push(mapped);
                }
              }

              // Accumulate thinking content
              if (thinking) allThinking += thinking;

              // Stream text content in real-time with <tool_call> tag detection.
              // Safe text (not part of a tool call) is sent immediately.
              // Tool call blocks are held back by the detector and parsed at the end.
              if (text) {
                allTextAccumulated += text;
                const safeText = toolCallDetector.addText(text);
                if (safeText) {
                  // Prepend thinking on the very first text chunk if present
                  if (allThinking && !firstChunkSent) {
                    sendTextChunk('<thinking> ' + allThinking + ' </thinking> ' + safeText);
                    allThinking = '';
                  } else {
                    sendTextChunk(safeText);
                  }
                }
              }
            }
          }
        } catch (streamReadError) {
          console.warn(`[streaming] Stream terminated early (${chunksReceived} chunks received): ${streamReadError.message || streamReadError}`);
          // Continue processing whatever frames we received — don't throw.
          // This commonly happens due to ERROR_USER_ABORTED_REQUEST when
          // Cursor expects native tool results that the proxy doesn't provide.
        }

        // Safety check: if zero data was received, the connection failed entirely
        if (chunksReceived === 0) {
          throw new Error('No data received from Cursor API');
        }

        // ─── Finalize: flush remaining text + collect all tool calls ──────
        const { remainingText, toolCallBlocks } = toolCallDetector.finish();

        // Flush any streaming tool calls still accumulating when stream ended
        const flushedTCs = toolCallAccumulator.flush();
        for (const tc of flushedTCs) {
          const cursorName = tc.name || CURSOR_TOOL_NAMES[tc.tool] || `cursor_tool_${tc.tool}`;
          console.log(`[streaming] Flushed incomplete streaming tool call: ${cursorName} (enum=${tc.tool}, id=${tc.toolCallId}, rawArgs=${tc.rawArgs.length} chars)`);
          const mapped = convertNativeToolCall(tc);
          if (mapped) nativeToolCalls.push(mapped);
        }

        // Send any unsent thinking content
        if (allThinking && !firstChunkSent) {
          sendTextChunk('<thinking> ' + allThinking + ' </thinking> ');
        }

        // Flush remaining clean text held back by the tag detector
        if (remainingText) {
          sendTextChunk(remainingText);
        }

        // Log response summary
        console.log(`[streaming] Response: ${allTextAccumulated.length} chars, preview: ${allTextAccumulated.substring(0, 500).replace(/\n/g, '\\n')}`);

        // ─── Collect all tool calls from all sources ──────────────────────
        const allToolCalls = [];

        // 1. Native protobuf tool calls (already converted by convertNativeToolCall)
        for (const mapped of nativeToolCalls) {
          if (mapped.truncated) {
            // Truncated file write — send hint text + fallback exec tool call
            sendTextChunk(`\n${mapped.hint}\n`);
            const safeFilePath = (mapped.filePath || 'file').replace(/'/g, "'\\''");
            allToolCalls.push({
              id: `call_${uuidv4()}`,
              type: 'function',
              function: {
                name: 'exec',
                arguments: JSON.stringify({ command: `echo "Ready for chunked heredoc write to: ${safeFilePath}"` })
              }
            });
          } else {
            allToolCalls.push({
              id: `call_${uuidv4()}`,
              type: 'function',
              function: {
                name: mapped.name,
                arguments: JSON.stringify(mapped.arguments)
              }
            });
          }
        }

        // 2. Text-based <tool_call> blocks (detected by StreamingToolCallDetector)
        for (const block of toolCallBlocks) {
          const parsed = tryParseToolCallContent(block, tools);
          if (parsed) {
            allToolCalls.push(parsed);
          }
        }

        // 3. Fallback: check accumulated text for near-miss formats
        //    Only if no tool calls found through primary detection paths
        if (allToolCalls.length === 0 && allTextAccumulated.length > 0) {
          const normalized = normalizeNearMissToolCalls(allTextAccumulated);
          if (hasToolCallTags(normalized)) {
            const { toolCalls: fallbackCalls } = parseToolCalls(normalized, tools);
            for (const tc of fallbackCalls) allToolCalls.push(tc);
            if (fallbackCalls.length > 0) {
              console.log(`[streaming] Near-miss fallback found ${fallbackCalls.length} tool call(s)`);
            }
          }
        }

        // ─── Expand __oc exec calls into real OpenClaw tool calls ───────
        const finalToolCalls = expandOcExecCalls(allToolCalls);

        // ─── Emit tool calls or stop ─────────────────────────────────────
        if (finalToolCalls.length > 0) {
          console.log(`[streaming] Emitting ${finalToolCalls.length} tool call(s): ${finalToolCalls.map(tc => tc.function.name).join(', ')}`);

          for (let i = 0; i < finalToolCalls.length; i++) {
            const tc = finalToolCalls[i];
            res.write(`data: ${JSON.stringify({
              id: responseId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: i,
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.function.name,
                      arguments: tc.function.arguments
                    }
                  }]
                },
                finish_reason: null
              }]
            })}\n\n`);
          }

          // Final chunk with finish_reason = tool_calls
          res.write(`data: ${JSON.stringify({
            id: responseId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
          })}\n\n`);
        } else {
          // No tool calls — send stop
          if (hasTools) {
            console.warn('[streaming] WARNING: Tools were provided but model did not output any tool calls. The model may have described the action instead of calling a tool.');
          }
          res.write(`data: ${JSON.stringify({
            id: responseId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`);
        }
      } catch (streamError) {
        console.error('[streaming] Processing error:', streamError.message || streamError);
        const errMsg = String(streamError.message || streamError);
        try {
          if (!res.writableEnded) {
            if (streamError.name === 'TimeoutError' || errMsg.includes('timeout') || errMsg.includes('terminated')) {
              res.write(`data: ${JSON.stringify({ error: 'Cursor API stream timeout — the response was too large or took too long. Try a simpler request.' })}\n\n`);
            } else {
              res.write(`data: ${JSON.stringify({ error: `Stream processing error: ${errMsg.substring(0, 200)}` })}\n\n`);
            }
          }
        } catch (_writeErr) {
          // Client already disconnected — nothing we can do
        }
      } finally {
        try {
          if (!res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
        } catch (_finalErr) {
          // Client already disconnected — nothing we can do
        }
      }
    } else {
      // Non-streaming response — always check for tool calls regardless of hasTools
      try {
        // Accumulate ALL raw chunks before parsing (same Z_BUF_ERROR fix as streaming)
        const rawChunksNS = [];
        try {
          for await (const chunk of response.body) {
            rawChunksNS.push(Buffer.from(chunk));
          }
        } catch (nsStreamErr) {
          console.warn(`[chat/completions] Non-stream terminated early (${rawChunksNS.length} chunks): ${nsStreamErr.message || nsStreamErr}`);
        }
        if (rawChunksNS.length === 0) {
          throw new Error('No data received from Cursor API (non-stream)');
        }
        const fullBufferNS = Buffer.concat(rawChunksNS);
        const { thinking: thinkNS, text: textNS } = chunkToUtf8String(fullBufferNS);

        let content = '';
        if (thinkNS) {
          content += '<thinking> ' + thinkNS + ' </thinking> ';
        }
        content += textNS;

        // Normalize near-miss tool call formats before detection
        content = normalizeNearMissToolCalls(content);

        // Check for tool calls (regardless of whether tools was in the request)
        if (hasToolCallTags(content)) {
          const { textContent, toolCalls } = parseToolCalls(content, tools);
          // Expand __oc exec calls into real OpenClaw tool calls
          const expandedToolCalls = expandOcExecCalls(toolCalls);
          console.log(`[chat/completions] Non-stream response contains ${expandedToolCalls.length} tool call(s), hasTools=${hasTools}`);

          const message = {
            role: 'assistant',
            content: textContent || null,
          };

          if (expandedToolCalls.length > 0) {
            message.tool_calls = expandedToolCalls;
          }

          return res.json({
            id: `chatcmpl-${uuidv4()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              message: message,
              finish_reason: expandedToolCalls.length > 0 ? 'tool_calls' : 'stop',
            }],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
          });
        }

        // No tool calls detected
        if (hasTools) {
          console.warn(`[chat/completions] WARNING: Tools were provided but model did not output any <tool_call> tags (non-stream).`);
        }

        // Normal text response
        return res.json({
          id: `chatcmpl-${uuidv4()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: content,
            },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        });
      } catch (error) {
        console.error('Non-stream error:', error);
        if (error.name === 'TimeoutError') {
          return res.status(408).json({ error: 'Server response timeout' });
        }
        throw error;
      }
    }
  } catch (error) {
    console.error('Error:', error);
    if (!res.headersSent) {
      const errorMessage = {
        error: error.name === 'TimeoutError' ? 'Request timeout' : 'Internal server error'
      };
      if (req.body.stream) {
        res.write(`data: ${JSON.stringify(errorMessage)}\n\n`);
        return res.end();
      } else {
        return res.status(error.name === 'TimeoutError' ? 408 : 500).json(errorMessage);
      }
    }
  }
});

module.exports = router;
