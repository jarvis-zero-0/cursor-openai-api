export class AgentTurnQueue {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.queues.set(agentId, tail);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.queues.get(agentId) === tail) {
        this.queues.delete(agentId);
      }
    }
  }

  clear(): void {
    this.queues.clear();
  }
}
