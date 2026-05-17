import { describe, it, expect, afterEach } from 'vitest';
import {
  visibleLength,
  stripAnsi,
  truncateChars,
  tailText,
  getTruncationBudget,
  lowerFirstWord,
  formatModelLabel,
  formatCountdownRemaining,
  formatContextLabel,
} from '../src/tui/render-utils.js';

describe('visibleLength', () => {
  it('counts plain text correctly', () => {
    expect(visibleLength('hello')).toBe(5);
  });

  it('ignores ANSI SGR codes', () => {
    expect(visibleLength('\x1b[32mhello\x1b[0m')).toBe(5);
  });

  it('handles empty string', () => {
    expect(visibleLength('')).toBe(0);
  });

  it('handles multiple ANSI codes', () => {
    expect(visibleLength('\x1b[1m\x1b[31mred\x1b[0m')).toBe(3);
  });
});

describe('stripAnsi', () => {
  it('removes ANSI codes', () => {
    expect(stripAnsi('\x1b[32mhello\x1b[0m')).toBe('hello');
  });

  it('returns plain text unchanged', () => {
    expect(stripAnsi('hello')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});

describe('truncateChars', () => {
  it('returns short text unchanged', () => {
    expect(truncateChars('hello', 10)).toBe('hello');
  });

  it('truncates long text with ellipsis', () => {
    const result = truncateChars('hello world', 8);
    expect(result).toContain('...');
    expect(visibleLength(result)).toBe(8);
  });

  it('handles empty string', () => {
    expect(truncateChars('', 5)).toBe('');
  });

  it('preserves ANSI in kept portion', () => {
    const text = '\x1b[32mhello world\x1b[0m';
    const result = truncateChars(text, 8);
    expect(result).toContain('\x1b[32m');
    expect(visibleLength(result)).toBe(8);
  });

  it('handles max < 3 without ellipsis', () => {
    expect(truncateChars('hello', 2)).toBe('he');
  });

  it('normalizes newlines and tabs', () => {
    expect(truncateChars('hello\nworld', 20)).toBe('hello world');
  });
});

describe('tailText', () => {
  it('returns short text unchanged', () => {
    expect(tailText('hello', 10)).toBe('hello');
  });

  it('takes last N visible chars', () => {
    expect(tailText('hello world', 5)).toBe('world');
  });

  it('handles empty string', () => {
    expect(tailText('', 5)).toBe('');
  });

  it('preserves trailing ANSI codes', () => {
    const text = '\x1b[32mhello world\x1b[0m';
    const result = tailText(text, 5);
    expect(visibleLength(result)).toBe(5);
    expect(result).toContain('world');
  });
});

describe('getTruncationBudget', () => {
  const originalColumns = process.stdout.columns;

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, writable: true, configurable: true });
  });

  it('defaults to 80 when columns is undefined', () => {
    Object.defineProperty(process.stdout, 'columns', { value: undefined, writable: true, configurable: true });
    expect(getTruncationBudget(0)).toBe(77); // 80 - 0 - 3
  });

  it('respects narrow terminals', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 30, writable: true, configurable: true });
    expect(getTruncationBudget(10)).toBe(17); // 30 - 10 - 3
  });

  it('respects very narrow terminals above floor', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 10, writable: true, configurable: true });
    expect(getTruncationBudget(0)).toBe(17);
  });

  it('floors columns at 20', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 15, writable: true, configurable: true });
    // width = max(15, 20) = 20, budget = 20 - 0 - 3 = 17
    expect(getTruncationBudget(0)).toBe(17);
  });
});

describe('lowerFirstWord', () => {
  it('lowercases first word', () => {
    expect(lowerFirstWord('Hello World')).toBe('hello World');
  });

  it('handles empty string', () => {
    expect(lowerFirstWord('')).toBe('');
  });

  it('handles single word', () => {
    expect(lowerFirstWord('HELLO')).toBe('hello');
  });
});

describe('formatModelLabel', () => {
  it('returns empty string when no model', () => {
    expect(formatModelLabel(undefined)).toBe('');
  });

  it('returns lowercase for single segment', () => {
    expect(formatModelLabel('GPT-4O')).toBe('gpt-4o');
  });

  it('formats provider/model with shortening', () => {
    expect(formatModelLabel('accounts/fireworks/routers/kimi-k2p6-turbo')).toBe('accounts/...k2p6-turbo');
  });

  it('returns short modelPath unchanged', () => {
    expect(formatModelLabel('github/copilot/gpt-5.5')).toBe('github/...ot/gpt-5.5');
  });

  it('uses default maxTail of 10', () => {
    expect(formatModelLabel('accounts/anthropic/models/claude-3-5-sonnet')).toBe('accounts/...3-5-sonnet');
  });
});

describe('formatCountdownRemaining', () => {
  it('returns undefined when deadlineAtMs is missing', () => {
    expect(formatCountdownRemaining(undefined)).toBeUndefined();
  });

  it('formats remaining time as MM:SS', () => {
    const result = formatCountdownRemaining(Date.now() + 90_000);
    expect(['01:30', '01:29']).toContain(result);
  });

  it('returns undefined for past deadlines', () => {
    expect(formatCountdownRemaining(Date.now() - 1000)).toBeUndefined();
  });
});

describe('formatContextLabel', () => {
  it('returns formatted tokens when max is unknown', () => {
    expect(formatContextLabel(32000)).toBe('32.0k');
  });

  it('returns ratio when max is provided', () => {
    expect(formatContextLabel(32000, 200000)).toBe('32.0k/0.20M');
  });

  it('handles small numbers', () => {
    expect(formatContextLabel(500, 1000)).toBe('500/1.0k');
  });

  it('handles large numbers', () => {
    expect(formatContextLabel(950500, 1000000)).toBe('0.95M/1.00M');
  });

  it('returns placeholder when ctxTokens is 0 and max is known', () => {
    expect(formatContextLabel(0, 200000)).toBe('-----/0.20M');
  });
});
