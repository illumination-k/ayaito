/** What reaches an agent at work: a message to take into account, or the word to stop and answer. */
export type Sent = { message: string; stop?: undefined } | { stop: true };

/** Where agent nodes hear what is sent to them while they work (run's steer). */
export interface Steer {
  /** Calls listener with what is sent to the address, until the function it returns is called. */
  listen(address: string, listener: (sent: Sent) => void): () => void;
}

/**
 * A way into a run for whoever watches it (a person, a supervising agent): give it to run
 * as steer. send(node, message) reaches the agent of that node while it works: its turn is
 * interrupted and its session gets the message, then goes on with its task. stop(node) ends
 * the agent's work without failing the node: it is interrupted and asked for its answer from
 * what it has done so far, as when a timeout's wrapUp runs out. Both return false when no
 * agent is working there; nothing is kept for later then. To stop the whole run, abort run's
 * signal.
 *
 * node is the name of an agent node, which reaches every agent of it (several, in forEach);
 * name#item, which reaches the one of a forEach item ("fix#2"; nested, "fix#0.2"); or the id
 * of an agent's session (a session event has it).
 */
export function steering(): Steer & { send(node: string, message: string): boolean; stop(node: string): boolean } {
  const listeners = new Map<string, Set<(sent: Sent) => void>>();
  const tell = (node: string, sent: Sent) => {
    const set = listeners.get(node);
    if (!set) return false;
    for (const listener of set) listener(sent);
    return true;
  };
  return {
    listen(node, listener) {
      const set = listeners.get(node) ?? new Set();
      listeners.set(node, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(node);
      };
    },
    send: (node, message) => tell(node, { message }),
    stop: (node) => tell(node, { stop: true }),
  };
}
