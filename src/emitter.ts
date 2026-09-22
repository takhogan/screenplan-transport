/**
 * A 30-line typed emitter so this package keeps zero runtime dependencies and
 * needs no `events` polyfill in the browser bundle. Callers bridge it to
 * whatever they use — script-studio wraps it in rxjs Subjects, the controller
 * logs off it.
 */
export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
    private listeners = new Map<keyof Events, Set<Listener<never>>>();

    on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(listener as Listener<never>);
        return () => {
            this.listeners.get(event)?.delete(listener as Listener<never>);
        };
    }

    emit<K extends keyof Events>(event: K, payload: Events[K]): void {
        const set = this.listeners.get(event);
        if (!set) {
            return;
        }
        // Copy first: a listener is allowed to unsubscribe itself.
        for (const listener of Array.from(set)) {
            try {
                (listener as Listener<Events[K]>)(payload);
            } catch {
                // A subscriber's failure is not the transport's failure. There is
                // nowhere useful to report it from here — the logger belongs to
                // the adapter that installed the listener.
            }
        }
    }

    removeAll(): void {
        this.listeners.clear();
    }
}
