import { context, type Span, SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";

import type { Node, RunEvent } from "./node.ts";
import { run, type RunResult } from "./run.ts";

export interface TraceOptions {
  /** Where spans go. Defaults to the tracer "ayaito" of the global provider. */
  tracer?: Tracer;
  /**
   * Also records what agents said, the inputs of their tools and the messages steered to them.
   * Off by default: a trace often goes to a service that events.jsonl never reaches.
   */
  content?: boolean;
}

/** A run's trace while it runs. */
export interface Tracing {
  /** run's log: turns each event into a span, or an event or attributes of one. */
  log: (event: RunEvent) => void;
  /** Ends the run's span, and those of nodes that never ended (a Stop passed through them). With error, the run failed. */
  end: (error?: unknown) => void;
  /** The span of the whole run, for attributes of your own. */
  root: Span;
}

/** What is known of a node's name from the flow: its kind, and the names of the nodes around it. */
interface Known {
  kind: string;
  within: Set<string>;
}

/** Events say which node they are for, but not what it is in: that comes from the flow's shape. */
function survey(root: Node<never, unknown>): Map<string, Known> {
  const known = new Map<string, Known>();
  const visit = (node: Node<never, unknown>, within: string[]): void => {
    const shape = node.shape ?? { kind: "fn" };
    // assign and worktree keep the name of their node: both are one span.
    if (shape.kind === "assign" || shape.kind === "worktree") return visit(shape.node, within);
    const entry = known.get(node.name) ?? { kind: shape.kind, within: new Set() };
    for (const name of within) entry.within.add(name);
    known.set(node.name, entry);
    const inside = [...within, node.name];
    switch (shape.kind) {
      case "fn":
      case "agent":
        return;
      case "flow":
        for (const step of shape.steps) visit(step.node, inside);
        return;
      case "parallel":
        for (const branch of Object.values(shape.branches)) visit(branch, inside);
        return;
      case "branch":
        for (const node of Object.values(shape.cases)) visit(node, inside);
        return;
      case "forEach":
      case "until":
        return visit(shape.body, inside);
    }
  };
  visit(root, []);
  return known;
}

/** Whether what happens for item `inner` is inside what runs for item `outer` ("0.2" is inside "0", and all inside none). */
const covers = (outer: string | undefined, inner: string | undefined) =>
  outer === undefined || outer === inner || inner?.startsWith(`${outer}.`) === true;

/** A span and what its agent calls used so far: each usage event adds to it. */
interface Entry {
  span: Span;
  node: string;
  item?: string;
  usd?: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  models: Set<string>;
}

const entry = (span: Span, node: string, item?: string): Entry => ({
  span,
  node,
  item,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  models: new Set(),
});

function addUsage(e: Entry, event: RunEvent & { type: "usage" }) {
  if (event.usd !== undefined) e.usd = (e.usd ?? 0) + event.usd;
  for (const [model, t] of Object.entries(event.models)) {
    e.models.add(model);
    e.input += t.input;
    e.output += t.output;
    e.cacheRead += t.cacheRead;
    e.cacheCreation += t.cacheCreation;
  }
  e.span.setAttributes({
    // The convention counts cached tokens as input tokens; ayaito keeps them apart.
    "gen_ai.usage.input_tokens": e.input + e.cacheRead + e.cacheCreation,
    "gen_ai.usage.output_tokens": e.output,
    "gen_ai.usage.cache_read.input_tokens": e.cacheRead,
    "gen_ai.usage.cache_creation.input_tokens": e.cacheCreation,
    ...(e.models.size > 0 && { "ayaito.usage.models": [...e.models] }),
    ...(e.usd !== undefined && { "ayaito.usage.cost_usd": e.usd }),
  });
}

/** Ends a span. An attribute cannot be taken back, so the model is set here, once it is known to be the only one. */
function finish(e: Entry, at?: Date) {
  const [model, ...others] = e.models;
  if (model !== undefined && others.length === 0) e.span.setAttribute("gen_ai.response.model", model);
  e.span.end(at);
}

/**
 * Traces a run with OpenTelemetry: pass log as run's log, and call end when the run is over
 * (runTraced does both). The run is one span and each node that starts is a span inside the
 * node it runs in, timed by its events. Agents follow the GenAI conventions (invoke_agent,
 * gen_ai.usage.*); what else happens to a node (a retry, a checkpoint hit, a tool call, a
 * wrap-up) is an event of its span. The run's span is a child of the span active when this is
 * called, and it carries the usage of the whole run.
 *
 * Only @opentelemetry/api is used: without an SDK registered in the process, nothing is recorded.
 */
export function tracing(
  node: Node<never, unknown>,
  { runId, tracer = trace.getTracer("ayaito"), content = false }: TraceOptions & { runId: string },
): Tracing {
  const known = survey(node);
  const root = entry(
    tracer.startSpan(`invoke_workflow ${node.name}`, {
      attributes: {
        "gen_ai.operation.name": "invoke_workflow",
        "gen_ai.workflow.name": node.name,
        "ayaito.run.id": runId,
      },
    }),
    node.name,
  );
  const rootContext = trace.setSpan(context.active(), root.span);
  /** Spans that started and have not ended, in the order they started. */
  const open: Entry[] = [];

  /** The span a node's events belong to: its own, or else that of the nearest node around it. */
  const find = (name: string, item: string | undefined): Entry =>
    open.findLast((e) => e.node === name && e.item === item) ?? around(name, item);
  const around = (name: string, item: string | undefined): Entry => {
    const within = known.get(name)?.within;
    return open.findLast((e) => within?.has(e.node) === true && covers(e.item, item)) ?? root;
  };
  const close = (name: string, item: string | undefined, at: Date, mark?: (span: Span) => void) => {
    const i = open.findLastIndex((e) => e.node === name && e.item === item);
    if (i === -1) return;
    const [e] = open.splice(i, 1);
    mark?.(e.span);
    finish(e, at);
  };

  const log = (event: RunEvent) => {
    const at = new Date(event.at);
    const { node: name, item } = event;
    switch (event.type) {
      case "start": {
        const kind = known.get(name)?.kind ?? "fn";
        const isAgent = kind === "agent";
        const span = tracer.startSpan(
          isAgent ? `invoke_agent ${name}` : name,
          {
            startTime: at,
            attributes: {
              "ayaito.run.id": runId,
              "ayaito.node": name,
              "ayaito.node.kind": kind,
              ...(item !== undefined && { "ayaito.item": item }),
              ...(isAgent && { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": name }),
            },
          },
          trace.setSpan(rootContext, around(name, item).span),
        );
        open.push(entry(span, name, item));
        return;
      }
      case "end":
        return close(name, item, at);
      case "error":
        return close(name, item, at, (span) => {
          span.addEvent("exception", { "exception.message": event.error }, at);
          span.setStatus({ code: SpanStatusCode.ERROR, message: event.error });
        });
      case "stop":
        return close(name, item, at, (span) => span.addEvent("stop", { reason: event.reason }, at));
      case "skip":
        find(name, item).span.addEvent("skip", { reason: event.reason }, at);
        return;
      case "retry":
        find(name, item).span.addEvent("retry", { attempt: event.attempt, error: event.error }, at);
        return;
      case "wrapUp":
        find(name, item).span.addEvent("wrapUp", { stopped: event.stopped === true }, at);
        return;
      case "session":
        find(name, item).span.setAttribute("gen_ai.conversation.id", event.sessionId);
        return;
      case "steer":
        find(name, item).span.addEvent("steer", content ? { message: event.message } : {}, at);
        return;
      case "prompt": {
        const { runtime, model, access, sessionId, text } = event;
        const how = {
          runtime,
          ...(model !== undefined && { "gen_ai.request.model": model }),
          ...(access !== undefined && { access }),
          ...(sessionId !== undefined && { resumes: sessionId }),
        };
        find(name, item).span.addEvent("prompt", { ...how, ...(content && { text }) }, at);
        return;
      }
      case "answer":
        find(name, item).span.addEvent("answer", content ? { text: event.text } : {}, at);
        return;
      case "log":
        find(name, item).span.addEvent("log", content ? { text: event.text } : {}, at);
        return;
      case "activity": {
        const { span } = find(name, item);
        if (event.tool !== undefined) {
          span.addEvent("tool", { "gen_ai.tool.name": event.tool, ...(content && { input: event.text }) }, at);
        } else if (content) span.addEvent("message", { text: event.text }, at);
        return;
      }
      case "usage": {
        const e = find(name, item);
        addUsage(e, event);
        if (e !== root) addUsage(root, event);
      }
    }
  };

  const end = (error?: unknown) => {
    for (const e of open.splice(0).toReversed()) finish(e);
    if (error !== undefined) {
      const failure =
        error instanceof Error ? error : new Error(typeof error === "string" ? error : JSON.stringify(error));
      root.span.recordException(failure);
      root.span.setStatus({ code: SpanStatusCode.ERROR, message: String(failure) });
    }
    finish(root);
  };

  return { log, end, root: root.span };
}

/** run, traced with OpenTelemetry (see tracing): the run's span ends with the run, as an error when it throws. */
export async function runTraced<I, O>(
  node: Node<I, O>,
  input: I,
  opts: Parameters<typeof run>[2] & TraceOptions,
): Promise<RunResult<O>> {
  const { tracer, content, ...rest } = opts;
  const traced = tracing(node, { runId: opts.runId, tracer, content });
  try {
    const result = await run(node, input, {
      ...rest,
      log: (event) => {
        traced.log(event);
        rest.log?.(event);
      },
    });
    traced.root.setAttribute("ayaito.run.status", result.status);
    traced.end();
    return result;
  } catch (error) {
    traced.end(error);
    throw error;
  }
}
