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
  private activeCount = 0;
  private readonly maxConcurrent: number;
  private waitQueue: Array<() => void> = [];
  private rejected = 0;

  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * No-op. Pre-warming is disabled because Claude CLI 2.x times out
   * after 3s without stdin data, causing an infinite spawn-die loop.
   */
  async warmUp(_model?: ClaudeModel): Promise<void> {
    console.log("[Pool] Pre-warming disabled (CLI stdin timeout incompatible)");
  }

  /**
   * Acquire a concurrency slot. Queues if all slots are busy.
   * Rejects if queue is too deep (2x maxConcurrent).
   * On return, activeCount has been incremented.
   */
  private async acquireSlot(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      return;
    }

    if (this.waitQueue.length >= this.maxConcurrent * 2) {
      this.rejected++;
      throw new Error(
        `Server overloaded: ${this.activeCount} active, ${this.waitQueue.length} queued (max ${this.maxConcurrent})`
      );
    }

    console.log(
      `[Pool] Queued request (active=${this.activeCount}/${this.maxConcurrent}, queue=${this.waitQueue.length + 1})`
    );
    // Slot is handed over by release() which increments activeCount before resolving
    await new Promise<void>((resolve) => this.waitQueue.push(resolve));
  }

  /**
   * Release a concurrency slot and wake the next queued request.
   */
  private release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      // Transfer the slot directly to the next waiter (activeCount stays the same)
      next();
    } else {
      this.activeCount--;
    }
    console.log(
      `[Pool] Released slot (active=${this.activeCount}/${this.maxConcurrent}, queue=${this.waitQueue.length})`
    );
  }

  /**
   * Spawn a fresh subprocess on demand, respecting concurrency limits.
   * The caller must call subprocess.sendPrompt() after setting up event handlers.
   */
  async acquire(options: {
    model: ClaudeModel;
    sessionId?: string;
    cwd?: string;
    effort?: EffortLevel;
    tools?: string;
  }): Promise<AcquireResult> {
    await this.acquireSlot();

    const t0 = Date.now();
    const sub = new ClaudeSubprocess();
    try {
      await sub.spawn(options);
    } catch (err) {
      this.release();
      throw err;
    }

    // Auto-release slot when subprocess exits
    sub.once("close", () => this.release());

    const acquireMs = Date.now() - t0;
    this.requests++;
    console.log(
      `[Pool] Spawned ${options.model} in ${acquireMs}ms (request #${this.requests}, active=${this.activeCount}/${this.maxConcurrent})`
    );
    return { subprocess: sub, source: "on-demand", acquireMs };
  }

  /**
   * Kill any queued waiters and log shutdown.
   */
  shutdown(): void {
    for (const resolve of this.waitQueue) {
      resolve(); // unblock — acquire will fail because pool is shutting down
    }
    this.waitQueue = [];
    console.log("[Pool] Shut down");
  }

  /**
   * Get pool statistics for the health endpoint.
   */
  stats(): {
    size: number;
    ready: Record<string, number>;
    requests: number;
    active: number;
    maxConcurrent: number;
    queued: number;
    rejected: number;
  } {
    return {
      size: 0,
      ready: {},
      requests: this.requests,
      active: this.activeCount,
      maxConcurrent: this.maxConcurrent,
      queued: this.waitQueue.length,
      rejected: this.rejected,
    };
  }
}

/** Singleton pool instance */
export const processPool = new ProcessPool();
