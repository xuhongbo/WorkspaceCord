import { describe, it, expect, beforeEach } from 'vitest';
import { Container, createToken, type Token } from '../di-container.ts';

interface TestService {
  name: string;
  getValue(): number;
}

const TestServiceToken = createToken<TestService>('TestService');
const TransientToken = createToken<{ counter: number }>('Transient');
const DependentToken = createToken<{ serviceName: string }>('Dependent');

describe('Container', () => {
  let container: Container;

  beforeEach(() => {
    container = new Container();
  });

  describe('register / resolve', () => {
    it('throws when resolving unregistered token', () => {
      expect(() => container.resolve(TestServiceToken)).toThrow(
        'No registration for token "TestService"',
      );
    });

    it('resolves a registered singleton factory', () => {
      container.register(TestServiceToken, () => ({
        name: 'test',
        getValue: () => 42,
      }), { singleton: true });

      const service = container.resolve(TestServiceToken);
      expect(service.name).toBe('test');
      expect(service.getValue()).toBe(42);
    });

    it('returns same instance for singleton', () => {
      container.register(TestServiceToken, () => ({
        name: 'singleton',
        getValue: () => 1,
      }), { singleton: true });

      const a = container.resolve(TestServiceToken);
      const b = container.resolve(TestServiceToken);
      expect(a).toBe(b);
    });

    it('returns new instance for transient', () => {
      let counter = 0;
      container.register(TransientToken, () => {
        counter++;
        return { counter };
      });

      const a = container.resolve(TransientToken);
      const b = container.resolve(TransientToken);
      expect(a.counter).toBe(1);
      expect(b.counter).toBe(2);
      expect(a).not.toBe(b);
    });

    it('defaults to transient when no options given', () => {
      container.register(TransientToken, () => ({ counter: 0 }));

      const a = container.resolve(TransientToken);
      const b = container.resolve(TransientToken);
      expect(a).not.toBe(b);
    });
  });

  describe('dependency injection', () => {
    it('injects resolved dependencies via container', () => {
      container.register(TestServiceToken, () => ({
        name: 'injected',
        getValue: () => 99,
      }), { singleton: true });

      container.register(DependentToken, (c) => {
        const svc = c.resolve(TestServiceToken);
        return { serviceName: svc.name };
      });

      const dep = container.resolve(DependentToken);
      expect(dep.serviceName).toBe('injected');
    });
  });

  describe('snapshot', () => {
    it('shows registered tokens with lifecycle info', () => {
      container.register(TestServiceToken, () => ({ name: 'x', getValue: () => 0 }), { singleton: true });
      container.register(TransientToken, () => ({ counter: 0 }));

      const snap = container.snapshot();

      expect(snap.has('TestService')).toBe(true);
      expect(snap.has('Transient')).toBe(true);
      expect(snap.get('TestService')?.lifecycle).toBe('singleton');
      expect(snap.get('Transient')?.lifecycle).toBe('transient');
    });

    it('tracks whether singleton was resolved', () => {
      container.register(TestServiceToken, () => ({ name: 'x', getValue: () => 0 }), { singleton: true });

      const before = container.snapshot();
      expect(before.get('TestService')?.resolved).toBe(false);

      container.resolve(TestServiceToken);

      const after = container.snapshot();
      expect(after.get('TestService')?.resolved).toBe(true);
    });
  });

  describe('createToken', () => {
    it('creates unique tokens', () => {
      const a = createToken<string>('A');
      const b = createToken<string>('A');
      const c = createToken<string>('C');

      // Same name → same Symbol.for → same token
      expect(a.symbol).toBe(b.symbol);
      expect(a.symbol).not.toBe(c.symbol);
    });
  });
});
