const express = require('express');
const router = express.Router();
const { fetch, ProxyAgent, Agent } = require('undici');
const { v4: uuidv4, v5: uuidv5 } = require('uuid');
const config = require('../config/config');
const $root = require('../proto/message.js');
const { generateCursorBody, chunkToUtf8String, generateHashed64Hex, generateCursorChecksum, IncrementalFrameParser, processSingleFrame, StreamingToolCallDetector, convertNativeToolCall, CURSOR_TOOL_NAMES, expandOcExecCalls } = require('../utils/utils.js');
const { parseToolCalls, hasToolCallTags, normalizeNearMissToolCalls, tryParseToolCallContent } = require('../utils/toolEmulation');

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

              // Collect native tool calls (kept separate from text stream)
              for (const tc of frameTCs) {
                const cursorName = tc.name || CURSOR_TOOL_NAMES[tc.tool] || `cursor_tool_${tc.tool}`;
                console.log(`[streaming] Intercepted native tool call: ${cursorName} (enum=${tc.tool}, id=${tc.toolCallId}, rawArgs=${tc.rawArgs.substring(0, 200)})`);
                const mapped = convertNativeToolCall(tc);
                if (mapped) nativeToolCalls.push(mapped);
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
