export interface Service {
  name: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  health?(): Promise<ServiceHealth> | ServiceHealth;
}

export interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
}

export class ServiceBus {
  #services: Service[] = [];
  #started = new Set<string>();

  register(service: Service): void {
    if (this.#services.some((s) => s.name === service.name)) {
      throw new Error(`Service "${service.name}" is already registered`);
    }
    this.#services.push(service);
  }

  async startAll(): Promise<void> {
    for (const service of this.#services) {
      try {
        await service.start();
        this.#started.add(service.name);
      } catch (err) {
        console.error(`[ServiceBus] Failed to start "${service.name}": ${(err as Error).message}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const service of [...this.#services].reverse()) {
      try {
        await service.stop();
        this.#started.delete(service.name);
      } catch (err) {
        console.error(`[ServiceBus] Failed to stop "${service.name}": ${(err as Error).message}`);
      }
    }
  }

  async healthCheck(): Promise<Map<string, ServiceHealth>> {
    const results = new Map<string, ServiceHealth>();
    for (const service of this.#services) {
      if (service.health) {
        results.set(service.name, await service.health());
      } else {
        results.set(service.name, {
          status: this.#started.has(service.name) ? 'healthy' : 'unhealthy',
        });
      }
    }
    return results;
  }

  get size(): number {
    return this.#services.length;
  }
}

export function intervalService(
  name: string,
  fn: () => void,
  intervalMs: number,
): Service {
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    name,
    start() {
      timer = setInterval(fn, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

export function cronService(
  name: string,
  fn: () => void,
  cronExpression: string,
): Service {
  // Simple cron service placeholder - would use a cron library in production
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    name,
    start() {
      // Parse basic cron for common patterns
      const parts = cronExpression.split(' ');
      if (parts.length === 5 && parts[0] === '*/1' && parts[1] === '*' && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
        timer = setInterval(fn, 60_000);
      } else {
        console.warn(`[ServiceBus] cron expression "${cronExpression}" not yet supported for "${name}"`);
      }
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
