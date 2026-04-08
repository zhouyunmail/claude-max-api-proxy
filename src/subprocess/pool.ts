/**
 * Process Pool for Claude CLI Subprocesses
 *
 * Claude CLI 2.x has a 3-second stdin timeout in --print mode, making
 * pre-warming impossible (idle processes die before being used).
 * This module now acts as an on-demand factory: each request spawns a
 * fresh process and immediately pipes the prompt. spawn() takes ~1-2ms
 * so the overhead is negligible; real latency is the Claude API response.
 */

import fs from "fs";
import { ClaudeSubprocess } from "./manager.js";
import type { EffortLevel } from "./manager.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";

/**
 * Check if a process is in D-state (uninterruptible sleep) via /proc.
 * Returns true only on Linux when the process state is "D".
 * Returns false on non-Linux or if /proc is unreadable.
 */
function isProcessInDState(pid: number | undefined): boolean {
  if (!pid || process.platform !== "linux") return false;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^State:\s+(\S)/m);
    return match?.[1] === "D";
  } catch {
    // ENOENT = process already exited, EACCES = no permission — both fine
    return false;
  }
}

export interface AcquireResult {
  subprocess: ClaudeSubprocess;
  /** Always "on-demand" now — no pre-warming */
  source: "on-demand";
  /** Time in ms to acquire the subprocess */
  acquireMs: number;
}

interface ActiveProcess {
  subprocess: ClaudeSubprocess;
  pid: number | undefined;
  model: string;
  spawnedAt: number;
  timer: ReturnType<typeof setTimeout>;
  /** Timestamp when D-state was first observed (0 = not in D-state) */
  dStateSince: number;
}

export class ProcessPool {
  private requests = 0;
  private activeCount = 0;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly sessionTimeoutMs: number;
  private waitQueue: Array<() => void> = [];
  private rejected = 0;
  private timedOut = 0;
  private forceReleased = 0;
  private activeProcesses = new Map<ClaudeSubprocess, ActiveProcess>();
  private reaperInterval: ReturnType<typeof setInterval> | null = null;

  /** Grace period after sessionTimeout before the reaper force-releases a slot */
  private static readonly REAPER_GRACE_MS = 30_000;
  /** How often the reaper scans for stuck processes */
  private static readonly REAPER_INTERVAL_MS = 30_000;
  /** How long a process must be in D-state before early force-release */
  private static readonly D_STATE_THRESHOLD_MS = 60_000;

  constructor(maxConcurrent = 5, maxQueue = 10, sessionTimeoutMs = 30 * 60 * 1000) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.sessionTimeoutMs = sessionTimeoutMs;
    this.startReaper();
  }

  /**
   * Periodic reaper that runs every 30s with two responsibilities:
   *
   * 1. **D-state early detection** (Linux only): reads /proc/<pid>/status
   *    to find processes stuck in uninterruptible sleep. If a process stays
   *    in D-state for > D_STATE_THRESHOLD_MS (60s), the slot is force-released
   *    immediately — no need to wait for the full 30-min session timeout.
   *
   * 2. **Deadline safety net**: any process alive beyond sessionTimeout + grace
   *    is force-released regardless of state (catches event leaks, etc).
   */
  private startReaper(): void {
    this.reaperInterval = setInterval(() => {
      const now = Date.now();
      const deadline = this.sessionTimeoutMs + ProcessPool.REAPER_GRACE_MS;

      for (const [sub, entry] of this.activeProcesses) {
        const elapsed = now - entry.spawnedAt;

        // --- Check 1: D-state early release ---
        if (isProcessInDState(entry.pid)) {
          if (entry.dStateSince === 0) {
            entry.dStateSince = now;
            console.log(
              `[Pool] Reaper: D-state detected for ${entry.model} pid=${entry.pid} (alive ${(elapsed / 1000).toFixed(0)}s) — watching`
            );
          } else if (now - entry.dStateSince >= ProcessPool.D_STATE_THRESHOLD_MS) {
            this.forceReleased++;
            const dSec = ((now - entry.dStateSince) / 1000).toFixed(0);
            console.log(
              `[Pool] Reaper: force-releasing D-state ${entry.model} pid=${entry.pid} (D-state for ${dSec}s)`
            );
            clearTimeout(entry.timer);
            this.activeProcesses.delete(sub);
            sub.kill(); // best-effort
            this.release();
            continue;
          }
        } else {
          // Clear D-state tracker if process recovered
          entry.dStateSince = 0;
        }

        // --- Check 2: absolute deadline ---
        if (elapsed > deadline) {
          this.forceReleased++;
          console.log(
            `[Pool] Reaper: force-releasing stuck ${entry.model} slot (alive ${(elapsed / 60000).toFixed(1)}min, limit=${(deadline / 60000).toFixed(1)}min)`
          );
          clearTimeout(entry.timer);
          this.activeProcesses.delete(sub);
          sub.kill();
          this.release();
        }
      }
    }, ProcessPool.REAPER_INTERVAL_MS);
    this.reaperInterval.unref();
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

    if (this.waitQueue.length >= this.maxQueue) {
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

    // Session timeout — kill subprocess if it runs longer than sessionTimeoutMs
    // If the process is in D-state (uninterruptible sleep, e.g. NFS), kill()
    // has no effect and the "close" event never fires. A secondary timer
    // force-releases the slot so the pool doesn't leak permanently.
    const FORCE_RELEASE_GRACE_MS = 10_000;
    const timer = setTimeout(() => {
      this.timedOut++;
      const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
      console.log(
        `[Pool] TIMEOUT after ${elapsed}min — killing ${options.model} subprocess (limit=${this.sessionTimeoutMs / 60000}min)`
      );
      sub.kill();

      // Fallback: if close event doesn't fire within grace period,
      // force-release the slot to prevent permanent pool leak (D-state processes).
      const fallback = setTimeout(() => {
        if (this.activeProcesses.has(sub)) {
          this.forceReleased++;
          console.log(
            `[Pool] Force-releasing stuck slot for ${options.model} (D-state / unkillable after ${FORCE_RELEASE_GRACE_MS / 1000}s)`
          );
          this.activeProcesses.delete(sub);
          this.release();
        }
      }, FORCE_RELEASE_GRACE_MS);
      fallback.unref();
    }, this.sessionTimeoutMs);

    // Track active process
    const entry: ActiveProcess = {
      subprocess: sub,
      pid: sub.pid,
      model: options.model,
      spawnedAt: t0,
      timer,
      dStateSince: 0,
    };
    this.activeProcesses.set(sub, entry);

    // Auto-release slot and cleanup when subprocess exits
    sub.once("close", () => {
      clearTimeout(timer);
      this.activeProcesses.delete(sub);
      this.release();
    });

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
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }

    // Clear all session timers and kill active subprocesses
    for (const entry of this.activeProcesses.values()) {
      clearTimeout(entry.timer);
      entry.subprocess.kill();
    }
    this.activeProcesses.clear();

    for (const resolve of this.waitQueue) {
      resolve(); // unblock — acquire will fail because pool is shutting down
    }
    this.waitQueue = [];
    console.log("[Pool] Shut down");
  }

  /**
   * Get pool statistics for the health endpoint.
   */
  stats() {
    const now = Date.now();
    const activeDetails = Array.from(this.activeProcesses.values()).map((entry) => ({
      model: entry.model,
      pid: entry.pid,
      runningMs: now - entry.spawnedAt,
      runningMin: +((now - entry.spawnedAt) / 60000).toFixed(1),
      dState: entry.dStateSince > 0 ? {
        since: new Date(entry.dStateSince).toISOString(),
        durationMs: now - entry.dStateSince,
      } : null,
    }));

    return {
      size: 0,
      ready: {},
      requests: this.requests,
      active: this.activeCount,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue,
      sessionTimeoutMin: this.sessionTimeoutMs / 60000,
      queued: this.waitQueue.length,
      rejected: this.rejected,
      timedOut: this.timedOut,
      forceReleased: this.forceReleased,
      activeDetails,
    };
  }
}

/** Singleton pool instance */
export const processPool = new ProcessPool();
