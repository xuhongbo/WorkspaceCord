// Service Container — 统一管理子系统的启动/停止生命周期

export interface Service {
  name: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export class ServiceContainer {
  private services: Service[] = [];

  register(service: Service): void {
    this.services.push(service);
  }

  async startAll(): Promise<void> {
    const startCount = this.services.length;
    console.log(`[ServiceContainer] Starting ${startCount} services...`);
    for (const service of this.services) {
      try {
        await service.start();
        console.log(`[ServiceContainer] ✓ ${service.name}`);
      } catch (err) {
        console.error(`[ServiceContainer] ✗ ${service.name}: ${(err as Error).message}`);
      }
    }
    console.log(`[ServiceContainer] ${startCount} service(s) started`);
  }

  async stopAll(): Promise<void> {
    const stopCount = this.services.length;
    console.log(`[ServiceContainer] Stopping ${stopCount} services...`);
    for (const service of [...this.services].reverse()) {
      try {
        await service.stop();
      } catch (err) {
        console.error(`[ServiceContainer] Failed to stop "${service.name}": ${(err as Error).message}`);
      }
    }
    this.services = [];
    console.log(`[ServiceContainer] ${stopCount} service(s) stopped`);
  }

  get size(): number {
    return this.services.length;
  }
}

/** 创建定时器类型的 Service */
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
