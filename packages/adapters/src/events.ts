/**
 * A small typed event source, so an adapter's events are checked at compile time.
 *
 * Handlers run synchronously, in subscription order, on the adapter's own call stack. A handler that
 * throws stops the remaining handlers for that event and the error reaches whatever emitted it, which
 * for a replay adapter is the replay loop. The engine wraps its handlers, so a bug in one shows up as a
 * halt with a stack trace and never as a silently skipped event.
 */

export type Unsubscribe = () => void;

export interface EventSource<Events extends Record<string, unknown>> {
  /** Subscribes a handler and returns the function that removes it. Adding the same handler twice adds it once. */
  on<Name extends keyof Events & string>(event: Name, handler: (payload: Events[Name]) => void): Unsubscribe;
}

export class Emitter<Events extends Record<string, unknown>> implements EventSource<Events> {
  readonly #handlers = new Map<string, Set<(payload: never) => void>>();

  on<Name extends keyof Events & string>(event: Name, handler: (payload: Events[Name]) => void): Unsubscribe {
    let set = this.#handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => {
      set.delete(handler as (payload: never) => void);
    };
  }

  emit<Name extends keyof Events & string>(event: Name, payload: Events[Name]): void {
    const set = this.#handlers.get(event);
    if (set === undefined) {
      return;
    }
    for (const handler of [...set]) {
      (handler as (payload: Events[Name]) => void)(payload);
    }
  }

  /** How many handlers an event has. For tests and health reporting. */
  listenerCount(event: keyof Events & string): number {
    return this.#handlers.get(event)?.size ?? 0;
  }
}
