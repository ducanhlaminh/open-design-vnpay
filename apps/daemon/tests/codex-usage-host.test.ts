/**
 * Coverage for the Codex app-server JSON-RPC exchange
 * (`exchangeCodexRateLimits`) extracted out of `readSandboxCodexUsage` so it
 * can drive a directly-spawned host `codex app-server --stdio` process just
 * as well as the Docker one. These tests stub the spawned child entirely —
 * no Docker, no real Codex binary — and only exercise the protocol
 * state machine (initialize → initialized → rateLimits) and the stdout
 * line-buffered JSON-RPC parsing.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { exchangeCodexRateLimits } from '../src/agent-sandbox.js';

type MockChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

function makeMockChild(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

describe('exchangeCodexRateLimits', () => {
  it('parses a rateLimits response after acknowledging initialize', async () => {
    const child = makeMockChild();
    const promise = exchangeCodexRateLimits(() => child as unknown as ChildProcess);

    child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    child.stdout.write(
      `${JSON.stringify({
        id: 2,
        result: {
          rateLimits: {
            primary: { usedPercent: 42, resetsAt: 1700000000, windowDurationMins: 300 },
            secondary: { usedPercent: 10, resetsAt: 1700600000, windowDurationMins: 10080 },
            planType: 'pro',
            credits: { hasCredits: true },
          },
        },
      })}\n`,
    );

    await expect(promise).resolves.toEqual({
      available: true,
      primary: { utilization: 42, resetsAt: 1700000000, durationMinutes: 300 },
      secondary: { utilization: 10, resetsAt: 1700600000, durationMinutes: 10080 },
      planType: 'pro',
      hasCredits: true,
    });
  });

  it('treats a null secondary window and missing fields as absent, not zero', async () => {
    const child = makeMockChild();
    const promise = exchangeCodexRateLimits(() => child as unknown as ChildProcess);

    child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    child.stdout.write(
      `${JSON.stringify({
        id: 2,
        result: { rateLimits: { primary: { usedPercent: 5 }, secondary: null, planType: null, credits: {} } },
      })}\n`,
    );

    const result = await promise;
    expect(result.secondary).toBeNull();
    expect(result.planType).toBeNull();
    expect(result.hasCredits).toBeNull();
    expect(result.primary).toEqual({ utilization: 5, resetsAt: null, durationMinutes: null });
  });

  it('ignores non-JSON-RPC diagnostic lines mixed into stdout', async () => {
    const child = makeMockChild();
    const promise = exchangeCodexRateLimits(() => child as unknown as ChildProcess);

    child.stdout.write('codex app-server booting...\n');
    child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    child.stdout.write('some unrelated log line\n');
    child.stdout.write(
      `${JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 1 }, secondary: null } } })}\n`,
    );

    await expect(promise).resolves.toMatchObject({ available: true });
  });

  it('rejects when the process exits before producing a usable rateLimits result', async () => {
    const child = makeMockChild();
    const promise = exchangeCodexRateLimits(() => child as unknown as ChildProcess);

    child.emit('exit', 1);

    await expect(promise).rejects.toThrow('Codex usage process exited with 1');
  });

  it('rejects when the child fails to spawn at all', async () => {
    const child = makeMockChild();
    const promise = exchangeCodexRateLimits(() => child as unknown as ChildProcess);

    child.emit('error', new Error('spawn codex ENOENT'));

    await expect(promise).rejects.toThrow('spawn codex ENOENT');
  });
});
