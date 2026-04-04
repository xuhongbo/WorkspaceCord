export interface Token<T> {
  readonly symbol: symbol;
}

export interface ContainerSnapshotEntry {
  lifecycle: 'singleton' | 'transient';
  resolved: boolean;
  instance: unknown;
}

export type ContainerSnapshot = Map<string, ContainerSnapshotEntry>;

export interface RegistrationOptions {
  singleton?: boolean;
}

export class Container {
  #factories = new Map<symbol, (c: Container) => unknown>();
  #singletons = new Map<symbol, unknown>();
  #lifecycles = new Map<symbol, 'singleton' | 'transient'>();

  register<T>(
    token: Token<T>,
    factory: (c: Container) => T,
    options?: RegistrationOptions,
  ): void {
    const key = token.symbol;
    this.#factories.set(key, factory);
    this.#lifecycles.set(key, options?.singleton ? 'singleton' : 'transient');
  }

  resolve<T>(token: Token<T>): T {
    const key = token.symbol;
    const factory = this.#factories.get(key);
    if (!factory) {
      throw new Error(`No registration for token "${token.symbol.description}"`);
    }

    const lifecycle = this.#lifecycles.get(key);
    if (lifecycle === 'singleton') {
      if (!this.#singletons.has(key)) {
        this.#singletons.set(key, factory(this));
      }
      return this.#singletons.get(key) as T;
    }

    return factory(this) as T;
  }

  snapshot(): ContainerSnapshot {
    const result = new Map<string, ContainerSnapshotEntry>();
    for (const [key, factory] of this.#factories) {
      const lifecycle = this.#lifecycles.get(key)!;
      const hasInstance = this.#singletons.has(key);
      result.set(key.description ?? String(key), {
        lifecycle,
        resolved: hasInstance,
        instance: hasInstance ? this.#singletons.get(key) : undefined,
      });
    }
    return result;
  }
}

export function createToken<T>(name: string): Token<T> {
  return { symbol: Symbol.for(name) };
}

export function bindFactory<T>(token: Token<T>, factory: (c: Container) => T): (c: Container) => T {
  return (c: Container) => factory(c);
}

export function bindInstance<T>(token: Token<T>, instance: T): (c: Container) => T {
  return () => instance;
}
