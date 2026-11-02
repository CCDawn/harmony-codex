export class EventBus {
  constructor() {
    this.listeners = new Map();
    this.observers = new Set();
  }

  subscribeAll(listener) {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }

  subscribe(taskId, listener) {
    const listeners = this.listeners.get(taskId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(taskId);
      }
    };
  }

  publish(taskId, event) {
    const listeners = this.listeners.get(taskId);
    for (const listener of listeners ?? []) {
      listener(event);
    }
    for (const observer of this.observers) observer(event);
  }
}
