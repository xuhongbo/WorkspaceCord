import { describe, it, expect } from 'vitest';
import { agents, getAgent, listAgents } from '../src/agents.ts';

describe('agents', () => {
  describe('agents array', () => {
    it('is a non-empty array', () => {
      expect(agents.length).toBeGreaterThan(0);
    });

    it('every agent has required fields', () => {
      for (const agent of agents) {
        expect(agent).toHaveProperty('name');
        expect(agent).toHaveProperty('emoji');
        expect(agent).toHaveProperty('description');
        expect(agent).toHaveProperty('systemPrompt');
        expect(typeof agent.name).toBe('string');
        expect(typeof agent.emoji).toBe('string');
        expect(typeof agent.description).toBe('string');
        expect(typeof agent.systemPrompt).toBe('string');
      }
    });

    it('contains expected well-known agents', () => {
      const names = agents.map((a) => a.name);
      expect(names).toContain('code-reviewer');
      expect(names).toContain('architect');
      expect(names).toContain('debugger');
      expect(names).toContain('security');
      expect(names).toContain('performance');
      expect(names).toContain('devops');
      expect(names).toContain('general');
    });

    it('has unique agent names', () => {
      const names = agents.map((a) => a.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  describe('getAgent', () => {
    it('returns the agent matching the name', () => {
      const agent = getAgent('debugger');
      expect(agent).toBeDefined();
      expect(agent!.name).toBe('debugger');
    });

    it('returns undefined for unknown agent name', () => {
      expect(getAgent('nonexistent-agent')).toBeUndefined();
    });

    it('returns the general agent', () => {
      const agent = getAgent('general');
      expect(agent).toBeDefined();
      expect(agent!.systemPrompt).toBe('');
    });
  });

  describe('listAgents', () => {
    it('returns the same array as the exported agents', () => {
      expect(listAgents()).toBe(agents);
    });

    it('returns all agents', () => {
      expect(listAgents().length).toBe(agents.length);
    });
  });
});
