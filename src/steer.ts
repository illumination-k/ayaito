/** Where agent nodes hear what is sent to them while they work (run's steer). */
export interface Steer {
  /** Calls listener with each message sent to the node, until the function it returns is called. */
  listen(node: string, listener: (message: string) => void): () => void;
}

/**
 * A way into a run for whoever watches it (a person, a supervising agent): give it to run
 * as steer, and send(node, message) reaches the agent of that node while it works. The agent's
 * turn is interrupted and its session gets the message, then goes on with its task. send
 * returns false when no agent of the node is working; the message is dropped then. Several
 * agents of one node (in forEach) all get it.
 */
export function steering(): Steer & { send(node: string, message: string): boolean } {
  const listeners = new Map<string, Set<(message: string) => void>>();
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
    send(node, message) {
      const set = listeners.get(node);
      if (!set) return false;
      for (const listener of set) listener(message);
      return true;
    },
  };
}
