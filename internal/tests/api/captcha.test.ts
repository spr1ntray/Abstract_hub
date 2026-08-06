import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { solveTurnstile } from '../../src/api/captcha.js';

describe('solveTurnstile', () => {
  let agent: MockAgent;
  let originalDispatcher: Dispatcher;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    setGlobalDispatcher(originalDispatcher);
    await agent.close();
    vi.useRealTimers();
  });

  it('creates task, polls processing, returns token when ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const pool = agent.get('https://api.capsolver.com');
    pool
      .intercept({ path: '/createTask', method: 'POST' })
      .reply(200, { errorId: 0, taskId: 'tid123' });
    pool
      .intercept({ path: '/getTaskResult', method: 'POST' })
      .reply(200, { errorId: 0, status: 'processing' });
    pool
      .intercept({ path: '/getTaskResult', method: 'POST' })
      .reply(200, { errorId: 0, status: 'ready', solution: { token: 'CF_TOKEN' } });

    const promise = solveTurnstile({
      apiKey: 'CAP-XYZ',
      websiteURL: 'https://gigaverse.io/play',
      websiteKey: 'sk_abc',
    });

    // Advance fake timers to drive both 2s polls forward.
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(2500);
    const token = await promise;

    expect(token).toBe('CF_TOKEN');
  }, 10_000);

  it('throws when createTask returns error', async () => {
    agent
      .get('https://api.capsolver.com')
      .intercept({ path: '/createTask', method: 'POST' })
      .reply(200, { errorId: 1, errorDescription: 'invalid key' });

    await expect(
      solveTurnstile({ apiKey: 'bad', websiteURL: 'https://x', websiteKey: 'k' }),
    ).rejects.toThrow(/invalid key/);
  });

  it('throws when createTask response has no taskId', async () => {
    agent
      .get('https://api.capsolver.com')
      .intercept({ path: '/createTask', method: 'POST' })
      .reply(200, { errorId: 0 });

    await expect(
      solveTurnstile({ apiKey: 'k', websiteURL: 'https://x', websiteKey: 'k' }),
    ).rejects.toThrow(/no taskId/);
  });

  it('throws when polling returns error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const pool = agent.get('https://api.capsolver.com');
    pool
      .intercept({ path: '/createTask', method: 'POST' })
      .reply(200, { errorId: 0, taskId: 'tid123' });
    pool
      .intercept({ path: '/getTaskResult', method: 'POST' })
      .reply(200, { errorId: 99, errorDescription: 'boom' });

    const promise = solveTurnstile({
      apiKey: 'k',
      websiteURL: 'https://x',
      websiteKey: 'k',
    });
    // Attach rejection handler synchronously so the rejection is never "unhandled".
    const assertion = expect(promise).rejects.toThrow(/boom/);

    await vi.advanceTimersByTimeAsync(2500);
    await assertion;
  }, 10_000);

  it('throws when ready but missing token in solution', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const pool = agent.get('https://api.capsolver.com');
    pool
      .intercept({ path: '/createTask', method: 'POST' })
      .reply(200, { errorId: 0, taskId: 'tid123' });
    pool
      .intercept({ path: '/getTaskResult', method: 'POST' })
      .reply(200, { errorId: 0, status: 'ready', solution: {} });

    const promise = solveTurnstile({
      apiKey: 'k',
      websiteURL: 'https://x',
      websiteKey: 'k',
    });
    const assertion = expect(promise).rejects.toThrow(/no token/);

    await vi.advanceTimersByTimeAsync(2500);
    await assertion;
  }, 10_000);
});
