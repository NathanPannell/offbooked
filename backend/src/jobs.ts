import type { Log } from "./log.ts";

// Tracks in-process background work so shutdown and tests can wait for it.
export class Jobs {
  private running = new Set<Promise<void>>();
  private log: Log;

  constructor(log: Log) {
    this.log = log;
  }

  run(name: string, fn: () => Promise<void>): void {
    const p = fn()
      .catch((err) => this.log.error({ err, job: name }, "background job failed"))
      .finally(() => this.running.delete(p));
    this.running.add(p);
  }

  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }
}
