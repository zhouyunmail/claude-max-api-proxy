/**
 * Process Pool for Claude CLI Subprocesses
 *
 * Claude CLI 2.x has a 3-second stdin timeout in --print mode, making
 * pre-warming impossible (idle processes die before being used).
 * This module now acts as an on-demand factory: each request spawns a
 * fresh process and immediately pipes the prompt. spawn() takes ~1-2ms
 * so the overhead is negligible; real latency is the Claude API response.
 */

import { ClaudeSubprocess } from "./manager.js";
import type { EffortLevel } from "./manager.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";

export interface AcquireResult {
  subprocess: ClaudeSubprocess;
  /** Always "on-demand" now — no pre-warming */
  source: "on-demand";
  /** Time in ms to acquire the subprocess */
  acquireMs: number;
}

export class ProcessPool {
  private requests = 0;

  /**
   * No-op. Pre-warming is disabled because Claude CLI 2.x times out
   * after 3s without stdin data, causing an infinite spawn-die loop.
   */
  async warmUp(_model?: ClaudeModel): Promise<void> {
    console.log("[Pool] Pre-warming disabled (CLI stdin timeout incompatible)");
  }

  /**
   * Spawn a fresh subprocess on demand.
   * The caller must call subprocess.sendPrompt() after setting up event handlers.
   */
  async acquire(options: {
    model: ClaudeModel;
    sessionId?: string;
    cwd?: string;
    effort?: EffortLevel;
    tools?: string;
  }): Promise<AcquireResult> {
    const t0 = Date.now();
    const sub = new ClaudeSubprocess();
    await sub.spawn(options);
    const acquireMs = Date.now() - t0;
    this.requests++;
    console.log(`[Pool] Spawned ${options.model} in ${acquireMs}ms (request #${this.requests})`);
    return { subprocess: sub, source: "on-demand", acquireMs };
  }

  /**
   * No-op — no pooled processes to shut down.
   */
  shutdown(): void {
    console.log("[Pool] Shut down (no pooled processes)");
  }

  /**
   * Get pool statistics for the health endpoint.
   */
  stats(): { size: number; ready: Record<string, number>; requests: number } {
    return { size: 0, ready: {}, requests: this.requests };
  }
}

/** Singleton pool instance */
export const processPool = new ProcessPool();
