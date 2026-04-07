/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type { ClaudeSubprocess } from "../subprocess/manager.js";
import { processPool } from "../subprocess/pool.js";
import type { AcquireResult } from "../subprocess/pool.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type { ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  const t0 = Date.now();

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // Convert to CLI input format and acquire a (possibly pre-warmed) subprocess
    const cliInput = openaiToCli(body);
    let acquired: AcquireResult | null = null;
    try {
      acquired = await processPool.acquire({
        model: cliInput.model,
        sessionId: cliInput.sessionId,
        effort: cliInput.effort,
        tools: cliInput.tools,
      });

      const mode = stream ? "stream" : "non-stream";
      const promptKB = (Buffer.byteLength(cliInput.prompt, "utf8") / 1024).toFixed(1);
      const extras = [
        cliInput.effort && `effort=${cliInput.effort}`,
        cliInput.tools !== undefined && `tools=${cliInput.tools || "none"}`,
      ].filter(Boolean).join(" ");
      console.log(
        `[Req ${requestId.slice(0, 8)}] ${mode} model=${cliInput.model} prompt=${promptKB}KB pool=${acquired.source} acquire=${acquired.acquireMs}ms${extras ? " " + extras : ""}`
      );

      if (stream) {
        await handleStreamingResponse(req, res, acquired.subprocess, cliInput, requestId, t0, acquired);
      } else {
        await handleNonStreamingResponse(res, acquired.subprocess, cliInput, requestId, t0, acquired);
      }
    } catch (innerError) {
      // Kill acquired subprocess if handler setup failed
      acquired?.subprocess.kill();
      throw innerError;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  t0: number,
  acquired: AcquireResult,
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;
    let hasEmittedText = false;
    let ttfbLogged = false;
    const rid = requestId.slice(0, 8);

    // Handle actual client disconnect (response stream closed)
    // Do NOT kill the subprocess — let it run to completion so the AI
    // response is always consumed (avoids wasting in-flight compute).
    res.on("close", () => {
      if (!isComplete) {
        console.log(`[Req ${requestId.slice(0, 8)}] Client disconnected (stream), subprocess continues`);
      }
      // Do not resolve here — wait for subprocess result/close to resolve
    });

    // When a new text content block starts after we've already emitted text,
    // insert a separator so text from different blocks doesn't run together
    subprocess.on("text_block_start", () => {
      if (hasEmittedText && !res.writableEnded) {
        const sepChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              content: "\n\n",
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(sepChunk)}\n\n`);
      }
    });

    // Handle streaming content deltas
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const delta = event.event.delta;
      const text = (delta?.type === "text_delta" && delta.text) || "";
      if (text && !res.writableEnded) {
        if (!ttfbLogged) {
          ttfbLogged = true;
          const ttfb = Date.now() - t0;
          console.log(
            `[Req ${rid}] TTFB=${ttfb}ms (pool=${acquired.source} acquire=${acquired.acquireMs}ms promptToToken=${ttfb - acquired.acquireMs}ms)`
          );
        }
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              role: isFirst ? "assistant" : undefined,
              content: text,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
        hasEmittedText = true;
      }
    });

    // Tool use events are forwarded as inline text (not tool_calls protocol)
    // to avoid agentic loops where OpenClaw tries to handle Claude Code's
    // internal tools (Read, Bash, etc.) as external tool calls.
    subprocess.on("tool_use_start", (event: ClaudeCliStreamEvent) => {
      if (res.writableEnded) return;
      const block = event.event.content_block;
      if (block?.type !== "tool_use") return;

      // Format tool invocation as readable inline text
      // Note: input arrives later via input_json_delta events, so we only
      // show the tool name at start time
      const toolText = `\n\n> **${block.name}**\n\n`;

      const chunk = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: lastModel,
        choices: [{
          index: 0,
          delta: {
            role: isFirst ? "assistant" : undefined,
            content: toolText,
          },
          finish_reason: null,
        }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      isFirst = false;
      hasEmittedText = true;
    });

    // Handle final assistant message (for model name)
    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      const totalMs = Date.now() - t0;
      const inputTokens = result.usage?.input_tokens || 0;
      const outputTokens = result.usage?.output_tokens || 0;
      console.log(
        `[Req ${rid}] DONE stream total=${totalMs}ms tokens=${inputTokens}+${outputTokens} pool=${acquired.source}`
      );
      if (!res.writableEnded) {
        // Send final done chunk with finish_reason and usage data
        const doneChunk = createDoneChunk(requestId, lastModel);
        if (result.usage) {
          doneChunk.usage = {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          };
        }
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      // Ensure subprocess + descendants are reaped after normal completion.
      // The CLI should exit on its own, but kill() guarantees cleanup of any
      // lingering children (claude-agent-acp, etc.).
      subprocess.kill();
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      subprocess.kill(); // Ensure subprocess + descendants are cleaned up
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      // Subprocess exited - ensure response is closed
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          // code 143 = SIGTERM (128+15), expected when we kill the process ourselves
          const isSigterm = code === 143;
          if (!isSigterm) {
            // Abnormal exit without result - send error
            res.write(`data: ${JSON.stringify({
              error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
            })}\n\n`);
          }
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    // Send prompt to the (already spawned) subprocess
    try {
      subprocess.sendPrompt(cliInput.prompt);
    } catch (err) {
      subprocess.kill();
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Streaming] sendPrompt error:", message);
      // Headers already flushed — cannot send a JSON 500. Write an SSE error
      // event instead so the client gets a readable failure message.
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message, type: "server_error", code: null } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    }
  });
}

/**
 * Handle non-streaming response
 *
 * Uses internal streaming to keep the HTTP connection alive (periodic
 * whitespace flushes) while Opus thinks. This prevents upstream gateways
 * from hitting their idle-timeout and aborting the request.
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  t0: number,
  acquired: AcquireResult,
): Promise<void> {
  const rid = requestId.slice(0, 8);

  // Keep-alive: send a single space every 10s so the gateway doesn't
  // consider the connection idle. The final JSON is written with
  // res.end() which flushes everything.
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(" ");
    }
  }, 10_000);

  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;
    let clientDisconnected = false;

    const cleanup = () => {
      clearInterval(keepAlive);
    };

    // Detect client disconnect — do NOT kill subprocess, let it run to completion
    // so the AI's response is always fully consumed (avoids wasted in-flight compute).
    res.on("close", () => {
      if (!finalResult) {
        clientDisconnected = true;
        console.log(`[Req ${rid}] Client disconnected (non-stream), subprocess continues`);
      }
      // Do not cleanup here — keepAlive and subprocess will be cleaned up on close/result
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      subprocess.kill(); // Ensure subprocess + descendants are cleaned up
      cleanup();
      // Guard: if result already arrived, let the close handler send the
      // success response instead of overwriting it with an error.
      if (!finalResult && !clientDisconnected) {
        if (!res.headersSent) {
          res.status(500).json({
            error: {
              message: error.message,
              type: "server_error",
              code: null,
            },
          });
        } else if (!res.writableEnded) {
          // Headers already sent (keep-alive wrote spaces) — must still
          // end the response so the client doesn't hang forever.
          res.end();
        }
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      cleanup();
      const totalMs = Date.now() - t0;
      if (clientDisconnected) {
        console.log(`[Req ${rid}] ABORT non-stream total=${totalMs}ms (client disconnected) pool=${acquired.source}`);
      } else if (finalResult) {
        const inputTokens = finalResult.usage?.input_tokens || 0;
        const outputTokens = finalResult.usage?.output_tokens || 0;
        console.log(
          `[Req ${rid}] DONE non-stream total=${totalMs}ms tokens=${inputTokens}+${outputTokens} pool=${acquired.source}`
        );
        // Use res.end() with the JSON payload so any buffered keep-alive
        // spaces + the actual body are flushed together.
        const payload = JSON.stringify(cliResultToOpenai(finalResult, requestId));
        if (!res.headersSent) {
          res.setHeader("Content-Type", "application/json");
        }
        res.end(payload);
      } else if (!res.headersSent) {
        console.log(`[Req ${rid}] FAIL non-stream total=${totalMs}ms exit=${code} pool=${acquired.source}`);
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      } else if (!res.writableEnded) {
        // Headers already sent by keep-alive writes but no result arrived — just close
        console.log(`[Req ${rid}] FAIL non-stream total=${totalMs}ms exit=${code} (headers already sent) pool=${acquired.source}`);
        res.end();
      }
      // Belt-and-suspenders: kill process group to reap lingering descendants
      subprocess.kill();
      resolve();
    });

    // Send prompt to the (already spawned) subprocess
    try {
      subprocess.sendPrompt(cliInput.prompt);
    } catch (error) {
      subprocess.kill();
      cleanup();
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[Req ${rid}] FAIL sendPrompt: ${message} pool=${acquired.source}`);
      if (!clientDisconnected && !res.headersSent) {
        res.status(500).json({
          error: {
            message,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    }
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  const now = Math.floor(Date.now() / 1000);
  const modelIds = [
    "claude-opus-4",
    "claude-opus-4-6",
    "claude-sonnet-4",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-haiku-4",
    "claude-haiku-4-5",
  ];
  res.json({
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      owned_by: "anthropic",
      created: now,
    })),
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
    pool: processPool.stats(),
  });
}
