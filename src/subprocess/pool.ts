/**
 * Process Pool for Claude CLI Subprocesses
 *
 * Pre-spawns Claude CLI processes that initialize and block on stdin.
 * When a request arrives, a warmed process is acquired and the prompt
 * is sent immediately — saving 2-4s of cold-start overhead.
 */

import { ClaudeSubprocess } from "./manager.js";
import type { EffortLevel } from "./manager.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";

interface PoolEntry {
  subprocess: ClaudeSubprocess;
  createdAt: number;
}

export interface AcquireResult {
  subprocess: ClaudeSubprocess;
  /** "hit" = from pool, "miss" = cold-started */
  source: "hit" | "miss" | "cold-session";
  /** Time in ms to acquire the subprocess */
  acquireMs: number;
}

/** Max time a pre-spawned process sits idle before being killed */
const MAX_IDLE_MS = 300_000; // 5 minutes

/** Default number of warm processes per model (override with POOL_SIZE env var) */
const DEFAULT_POOL_SIZE = parseInt(process.env.POOL_SIZE || "2", 10) || 3;

/** Only auto-refill the default model to avoid unbounded memory growth */
const DEFAULT_WARM_MODEL: ClaudeModel = (process.env.WARM_MODEL as ClaudeModel) || "opus";

/** Delay before refilling after an acquire */
const REFILL_DELAY_MS = 100;

export class ProcessPool {
  private pools = new Map<string, PoolEntry[]>();
  private poolSize: number;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private refilling = new Set<string>();
  private hits = 0;
  private misses = 0;

  constructor(poolSize = DEFAULT_POOL_SIZE) {
    this.poolSize = poolSize;
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  /**
   * Pre-warm the pool with processes for the given model.
   * Fills up to poolSize processes.
   */
  async warmUp(model: ClaudeModel = "opus"): Promise<void> {
    const pool = this.getPool(model);

    const needed = this.poolSize - pool.length;
    if (needed <= 0) return;

    const results = await Promise.allSettled(
      Array.from({ length: needed }, () => this.spawnOne(model))
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        pool.push(r.value);
      }
    }

    console.log(`[Pool] Warmed ${model}: ${pool.length}/${this.poolSize}`);
  }

  /**
   * Acquire a ready-to-use subprocess.
   * Returns a pre-warmed process if available, otherwise cold-starts one.
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

    // sessionId / effort / tools require specific args at spawn time — must cold-start
    const needsColdStart = options.sessionId || options.effort || options.tools !== undefined;
    if (needsColdStart) {
      const reason = options.sessionId
        ? `sessionId: ${options.sessionId.slice(0, 8)}…`
        : options.effort
          ? `effort: ${options.effort}`
          : `tools: ${options.tools || "none"}`;
      console.log(`[Pool] Cold start (${reason})`);
      const sub = new ClaudeSubprocess();
      await sub.spawn(options);
      return { subprocess: sub, source: "cold-session", acquireMs: Date.now() - t0 };
    }

    const pool = this.getPool(options.model);
    let discarded = 0;

    // Try to find a live pre-warmed process with a writable stdin
    while (pool.length > 0) {
      const entry = pool.shift()!;
      if (entry.subprocess.isReady()) {
        const acquireMs = Date.now() - t0;
        const idleMs = Date.now() - entry.createdAt;
        console.log(
          `[Pool] HIT ${options.model} | acquire=${acquireMs}ms idle=${idleMs}ms remaining=${pool.length} discarded=${discarded}`
        );
        this.hits++;
        // Only refill the default warm model to prevent unbounded pool growth
        if (options.model === DEFAULT_WARM_MODEL) {
          this.scheduleRefill(options.model);
        }
        return { subprocess: entry.subprocess, source: "hit", acquireMs };
      }
      // Dead or broken process — discard
      discarded++;
      entry.subprocess.kill();
    }

    // Pool miss — cold start
    if (discarded > 0) {
      console.log(`[Pool] MISS ${options.model} (discarded ${discarded} dead entries), cold start`);
    } else {
      console.log(`[Pool] MISS ${options.model} (pool empty), cold start`);
    }
    const sub = new ClaudeSubprocess();
    await sub.spawn({ model: options.model, cwd: options.cwd });
    const acquireMs = Date.now() - t0;
    this.misses++;
    console.log(`[Pool] Cold spawn took ${acquireMs}ms`);
    // Only refill the default warm model to prevent unbounded pool growth
    if (options.model === DEFAULT_WARM_MODEL) {
      this.scheduleRefill(options.model);
    }
    return { subprocess: sub, source: "miss", acquireMs };
  }

  /**
   * Gracefully shut down all pooled processes.
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const pool of this.pools.values()) {
      for (const entry of pool) {
        entry.subprocess.kill();
      }
    }
    this.pools.clear();
    console.log("[Pool] Shut down");
  }

  /**
   * Get pool statistics for the health endpoint.
   */
  stats(): { size: number; ready: Record<string, number>; hits: number; misses: number; hitRate: string } {
    const ready: Record<string, number> = {};
    for (const [model, pool] of this.pools) {
      ready[model] = pool.filter((e) => e.subprocess.isReady()).length;
    }
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? `${((this.hits / total) * 100).toFixed(1)}%` : "n/a";
    return { size: this.poolSize, ready, hits: this.hits, misses: this.misses, hitRate };
  }

  // --- Internal ---

  private getPool(model: string): PoolEntry[] {
    let pool = this.pools.get(model);
    if (!pool) {
      pool = [];
      this.pools.set(model, pool);
    }
    return pool;
  }

  private async spawnOne(model: ClaudeModel): Promise<PoolEntry | null> {
    const sub = new ClaudeSubprocess();
    const t0 = Date.now();
    try {
      await sub.spawn({ model });
      const elapsed = Date.now() - t0;
      // In --print mode the CLI blocks on stdin immediately after spawn.
      // The init message is only emitted after a prompt is piped in,
      // so we can't waitForInit() here. Instead, verify the process
      // spawned and stdin is writable — that's sufficient for the pool.
      if (sub.isReady()) {
        console.log(`[Pool] Process spawned for ${model} in ${elapsed}ms (stdin writable)`);
        return { subprocess: sub, createdAt: Date.now() };
      }
      console.warn(`[Pool] Process spawned but not ready for ${model} after ${elapsed}ms`);
      sub.kill();
    } catch (err) {
      console.error(`[Pool] Spawn failed for ${model}:`, err);
      sub.kill();
    }
    return null;
  }

  private scheduleRefill(model: ClaudeModel): void {
    if (this.refilling.has(model)) return;
    this.refilling.add(model);

    setTimeout(async () => {
      try {
        await this.warmUp(model);
      } catch {
        // Logged in warmUp
      } finally {
        this.refilling.delete(model);
      }
    }, REFILL_DELAY_MS);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [model, pool] of this.pools) {
      const kept: PoolEntry[] = [];
      for (const entry of pool) {
        if (
          now - entry.createdAt > MAX_IDLE_MS ||
          !entry.subprocess.isRunning()
        ) {
          entry.subprocess.kill();
        } else {
          kept.push(entry);
        }
      }
      this.pools.set(model, kept);
      // Only refill the default warm model
      if (model === DEFAULT_WARM_MODEL && kept.length < this.poolSize) {
        this.scheduleRefill(model as ClaudeModel);
      }
    }
  }
}

/** Singleton pool instance */
export const processPool = new ProcessPool();
