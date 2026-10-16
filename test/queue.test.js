import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DealSyncQueue } from '../src/queue.js';

test('a burst of events for one deal becomes one sync', async () => {
  const runs = [];
  const queue = new DealSyncQueue(async (id) => runs.push(id), { debounceMs: 20 });
  queue.enqueue('1');
  queue.enqueue('1');
  await delay(5);
  queue.enqueue('1');
  queue.enqueue('2');
  await delay(60);
  await queue.flush();
  assert.deepEqual(runs.sort(), ['1', '2']);
});

test('syncs of the same deal never overlap', async () => {
  let active = 0;
  let maxActive = 0;
  const queue = new DealSyncQueue(
    async () => {
      maxActive = Math.max(maxActive, ++active);
      await delay(10);
      active--;
    },
    { debounceMs: 0, concurrency: 5 },
  );
  await Promise.all([queue.run('1'), queue.run('1'), queue.run('1')]);
  assert.equal(maxActive, 1);
});

test('different deals run in parallel up to the concurrency limit', async () => {
  let active = 0;
  let maxActive = 0;
  const queue = new DealSyncQueue(
    async () => {
      maxActive = Math.max(maxActive, ++active);
      await delay(10);
      active--;
    },
    { concurrency: 2 },
  );
  await Promise.all(['1', '2', '3', '4', '5'].map((id) => queue.run(id)));
  assert.equal(maxActive, 2);
});

test('events during a running sync trigger exactly one follow-up', async () => {
  const runs = [];
  let release;
  const queue = new DealSyncQueue(
    async (id) => {
      runs.push(id);
      if (runs.length === 1) await new Promise((resolve) => (release = resolve));
    },
    { debounceMs: 1 },
  );
  queue.enqueue('1');
  await delay(10); // first sync is now running and blocked
  queue.enqueue('1');
  await delay(10);
  queue.enqueue('1');
  await delay(10);
  release();
  await queue.flush();
  assert.deepEqual(runs, ['1', '1']);
});

test('run() passes options and returns the result; failures do not block the deal', async () => {
  const queue = new DealSyncQueue(async (id, options) => {
    if (options.fail) throw new Error('boom');
    return { id, force: options.force };
  }, { logger: { error() {} } });
  await assert.rejects(queue.run('1', { fail: true }), /boom/);
  assert.deepEqual(await queue.run('1', { force: true }), { id: '1', force: true });
});
