import { named, type Middleware } from "./edge.ts";
import type { Context, RunEvent, Tokens } from "./node.ts";

/**
 * A limit on what agents may spend. tokens counts input, output and cache writes, not cache
 * reads, which cost a tenth as much and would make the count grow with every turn.
 */
export interface Budget {
  usd?: number;
  tokens?: number;
}

export interface Spent {
  usd: number;
  tokens: number;
}

/** What was spent passed the budget. The calls in progress were aborted. */
export class BudgetError extends Error {
  override name = "BudgetError";
  readonly spent: Spent;
  readonly budget: Budget;

  constructor(spent: Spent, budget: Budget, where: string) {
    const shown = {
      usd: budget.usd === undefined ? undefined : spent.usd,
      tokens: budget.tokens === undefined ? undefined : spent.tokens,
    };
    super(`${where}: over budget (spent ${describeBudget(shown)} of ${describeBudget(budget)})`);
    this.spent = spent;
    this.budget = budget;
  }
}

/** The node ran longer than its timeout. It was aborted. */
export class TimeoutError extends Error {
  override name = "TimeoutError";
}

/**
 * Limits what the node spends each time it runs, retries and loop rounds inside it included:
 * once the usage its agents report passes the budget, its signal aborts and it throws
 * BudgetError. A call reports usage when it ends, so the last call can go past the budget.
 * For the run as a whole, give run a budget instead.
 */
export function budget(limits: Budget): Middleware {
  return named(`budget ${describeBudget(limits)}`, (node, next) => async (input, ctx) => {
    const limited = limitSpend(ctx, limits, node.name);
    try {
      return await next(input, limited.ctx);
    } catch (error) {
      throw limited.exceeded() ?? error;
    }
  });
}

/**
 * Aborts the node after ms, and throws TimeoutError right away, without waiting for a node
 * that ignores the signal. Inside retry, it limits each attempt; around retry, all of them.
 */
export function timeout(ms: number): Middleware {
  return named(`timeout ${duration(ms)}`, (node, next) => async (input, ctx) => {
    const abort = new AbortController();
    const error = new TimeoutError(`${node.name}: timed out after ${duration(ms)}`);
    const timedOut = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(error), { once: true });
    });
    const timer = setTimeout(() => abort.abort(error), ms);
    try {
      const signal = AbortSignal.any([ctx.signal, abort.signal]);
      return await Promise.race([next(input, { ...ctx, signal }), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  });
}

/** A context whose signal aborts with BudgetError once the usage emitted through it passes limits. */
export function limitSpend(
  ctx: Context,
  limits: Budget,
  where: string,
  spent: Spent = { usd: 0, tokens: 0 },
): { ctx: Context; exceeded: () => BudgetError | undefined } {
  const abort = new AbortController();
  let exceeded: BudgetError | undefined;
  const check = () => {
    if (exceeded || (spent.usd <= (limits.usd ?? Infinity) && spent.tokens <= (limits.tokens ?? Infinity))) return;
    exceeded = new BudgetError({ ...spent }, limits, where);
    abort.abort(exceeded);
  };
  // What a resumed run spent before can already be over.
  check();
  return {
    exceeded: () => exceeded,
    ctx: {
      ...ctx,
      signal: AbortSignal.any([ctx.signal, abort.signal]),
      emit: (event) => {
        ctx.emit(event);
        if (event.type !== "usage") return;
        add(spent, event);
        check();
      },
    },
  };
}

/** What the usage events spent. */
export function spentIn(events: RunEvent[]): Spent {
  const spent = { usd: 0, tokens: 0 };
  for (const e of events) if (e.type === "usage") add(spent, e);
  return spent;
}

function add(spent: Spent, usage: { usd?: number; models: Record<string, Tokens> }) {
  spent.usd += usage.usd ?? 0;
  for (const t of Object.values(usage.models)) spent.tokens += t.input + t.output + t.cacheCreation;
}

function describeBudget({ usd, tokens }: Budget): string {
  const parts = [];
  if (usd !== undefined) parts.push(`$${Number(usd.toFixed(4))}`);
  if (tokens !== undefined) parts.push(`${tokens} tokens`);
  return parts.join(", ");
}

function duration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}
