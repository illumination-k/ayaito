import type { RunEvent } from "./node.ts";

/**
 * An event as text for people: when, which node (name#item inside a forEach) and what happened.
 * For run's log (`log: (e) => console.log(formatEvent(e))`); `ayaito log` prints a run's events with it.
 * A text of several lines keeps them, indented under the first.
 */
export function formatEvent(event: RunEvent): string {
  const who = event.item === undefined ? event.node : `${event.node}#${event.item}`;
  return `${event.at} ${who} ${what(event)}`.replaceAll("\n", "\n    ");
}

function what(e: RunEvent): string {
  switch (e.type) {
    case "start":
      return "start";
    case "end":
      return `end (${(e.ms / 1000).toFixed(1)}s)`;
    case "skip":
      return `skip: ${e.reason}`;
    case "retry":
      return `retry after attempt ${e.attempt}: ${e.error}`;
    case "error":
      return `error: ${e.error}`;
    case "stop":
      return `stop: ${e.reason}`;
    case "wrapUp":
      return e.stopped ? "told to stop: asked for its answer" : "time is up: asked for its answer";
    case "session":
      return `session ${e.sessionId}`;
    case "prompt": {
      const how = [e.runtime, e.model, e.access, e.sessionId !== undefined && `resumes ${e.sessionId}`];
      return `prompt (${how.filter(Boolean).join(", ")}): ${e.text}`;
    }
    case "answer":
      return `answer: ${e.text}`;
    case "activity":
      return e.tool === undefined ? `says: ${e.text}` : `tool ${e.tool}: ${e.text}`;
    case "steer":
      return `steer: ${e.message}`;
    case "log":
      return `log: ${e.text}`;
    case "usage": {
      const tokens = Object.values(e.models).reduce((sum, t) => sum + t.input + t.output, 0);
      const usd = e.usd === undefined ? "" : `$${e.usd.toFixed(2)}, `;
      return `usage: ${usd}${tokens.toLocaleString("en-US")} tokens in and out`;
    }
  }
}
