import { describe, expect, it } from 'vitest';
import { classifyLogLine } from '../../src/ui/log-classifier.js';

describe('classifyLogLine', () => {
  it('does not count zero failed items as an error', () => {
    expect(classifyLogLine('│ Items failed         │ 0 │')).toBe('neutral');
  });

  it('counts a positive failed-items metric as an error', () => {
    expect(classifyLogLine('│ Items failed         │ 2 │')).toBe('error');
  });

  it('treats normal dungeon deaths as warnings', () => {
    expect(classifyLogLine('[acc1] Умер — этаж 2 · комната 1')).toBe('warning');
    expect(classifyLogLine('Runs 4  0 OK · 4 died')).toBe('warning');
  });

  it('recognizes real account and HTTP failures', () => {
    expect(classifyLogLine('❌ Аккаунт упал с ошибкой:')).toBe('error');
    expect(classifyLogLine('HTTP 500')).toBe('error');
    expect(classifyLogLine('body: {"error":"INTERNAL_ERROR"}')).toBe('error');
  });

  it('keeps routine skips as warnings and separators styled separately', () => {
    expect(classifyLogLine('Blue Pot: пропуск — Recipe is on cooldown')).toBe('warning');
    expect(classifyLogLine('[acc1] ─────────────────────')).toBe('separator');
  });
});
