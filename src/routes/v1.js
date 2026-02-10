const express = require('express');
const router = express.Router();
const { fetch, ProxyAgent, Agent } = require('undici');
const { v4: uuidv4, v5: uuidv5 } = require('uuid');
const config = require('../config/config');
const $root = require('../proto/message.js');
const { generateCursorBody, chunkToUtf8String, generateHashed64Hex, generateCursorChecksum } = require('../utils/utils.js');
const { parseToolCalls, hasToolCallTags, normalizeNearMissToolCalls } = require('../utils/toolEmulation');

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

    const dispatcher = config.proxy.enabled
      ? new ProxyAgent(config.proxy.url, { allowH2: true })
      : new Agent({ allowH2: true });

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
      timeout: {
        connect: 5000,
        read: 30000
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

      // ALWAYS buffer the full response to check for <tool_call> tags.
      // Why? Two scenarios where tool calls can appear:
      //   1. OpenClaw sends tools param → we inject into system prompt → model outputs <tool_call>
      //   2. OpenClaw embeds tools in system prompt directly (bug #1866) → model outputs <tool_call>
      // In both cases, we need the full text to detect and convert them.
      // Trade-off: no real-time streaming, but tool calling works reliably.
      try {
        // Accumulate ALL raw chunks before parsing to prevent Z_BUF_ERROR.
        // Cursor's streaming sometimes splits gzip frames across TCP packets.
        // Since we buffer the full response for tool call detection anyway,
        // there is zero downside to parsing the complete buffer at once.
        //
        // IMPORTANT: The stream may terminate early due to:
        //   - HTTP/2 timeout (300s) when Cursor waits for native tool results
        //   - ERROR_USER_ABORTED_REQUEST from native tool dispatch
        // In both cases, we still process whatever chunks arrived so far.
        const rawChunks = [];
        let streamTerminated = false;
        try {
          for await (const chunk of response.body) {
            rawChunks.push(Buffer.from(chunk));
          }
        } catch (streamReadError) {
          streamTerminated = true;
          console.warn(`[chat/completions] Stream terminated early (${rawChunks.length} chunks accumulated): ${streamReadError.message || streamReadError}`);
          // Continue processing whatever we have — don't throw
        }
        if (rawChunks.length === 0) {
          throw new Error('No data received from Cursor API');
        }
        const fullBuffer = Buffer.concat(rawChunks);
        const { thinking, text } = chunkToUtf8String(fullBuffer);

        let fullContent = '';
        if (thinking) {
          fullContent += '<thinking> ' + thinking + ' </thinking> ';
        }
        fullContent += text;

        // Log first 500 chars of response for debugging
        console.log(`[chat/completions] Response preview (${fullContent.length} chars): ${fullContent.substring(0, 500).replace(/\n/g, '\\n')}`);

        // Normalize near-miss tool call formats before detection
        fullContent = normalizeNearMissToolCalls(fullContent);

        // Check if response contains <tool_call> tags (regardless of hasTools)
        if (hasToolCallTags(fullContent)) {
          const { textContent, toolCalls } = parseToolCalls(fullContent, tools);
          console.log(`[chat/completions] Response contains ${toolCalls.length} tool call(s), hasTools=${hasTools}`);

          // Send text content first if any
          if (textContent) {
            res.write(
              `data: ${JSON.stringify({
                id: responseId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                  index: 0,
                  delta: { role: 'assistant', content: textContent },
                  finish_reason: null
                }]
              })}\n\n`
            );
          }

          // Send tool calls as proper OpenAI tool_calls stream chunks
          if (toolCalls.length > 0) {
            for (let i = 0; i < toolCalls.length; i++) {
              const tc = toolCalls[i];
              res.write(
                `data: ${JSON.stringify({
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
                })}\n\n`
              );
            }

            // Final chunk with finish_reason = tool_calls
            res.write(
              `data: ${JSON.stringify({
                id: responseId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'tool_calls'
                }]
              })}\n\n`
            );
          }
        } else {
          // No tool calls detected
          if (hasTools) {
            console.warn(`[chat/completions] WARNING: Tools were provided but model did not output any <tool_call> tags. The model may have described the action instead of calling a tool.`);
          }
          if (fullContent.length > 0) {
            res.write(
              `data: ${JSON.stringify({
                id: responseId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                  index: 0,
                  delta: { content: fullContent },
                  finish_reason: null
                }]
              })}\n\n`
            );
          }
          res.write(
            `data: ${JSON.stringify({
              id: responseId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: 'stop'
              }]
            })}\n\n`
          );
        }
      } catch (streamError) {
        console.error('[chat/completions] Stream processing error:', streamError.message || streamError);
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
          console.log(`[chat/completions] Non-stream response contains ${toolCalls.length} tool call(s), hasTools=${hasTools}`);

          const message = {
            role: 'assistant',
            content: textContent || null,
          };

          if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
          }

          return res.json({
            id: `chatcmpl-${uuidv4()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              message: message,
              finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
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
