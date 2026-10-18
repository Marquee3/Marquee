import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberSetting, readServerSettings } from '../src/runtime.js';

test('blank settings mean the default; invalid ones are errors, not "off"', () => {
  assert.equal(readServerSettings({}).pollSeconds, 60);
  assert.equal(readServerSettings({ SYNC_POLL_SECONDS: '' }).pollSeconds, 60);
  assert.equal(readServerSettings({ SYNC_POLL_SECONDS: '  ' }).pollSeconds, 60);
  assert.equal(readServerSettings({ SYNC_POLL_SECONDS: '0' }).pollSeconds, 0, '0 still turns polling off');
  assert.equal(readServerSettings({ SYNC_POLL_SECONDS: '300' }).pollSeconds, 300);
  assert.throws(() => readServerSettings({ SYNC_POLL_SECONDS: '60s' }), /SYNC_POLL_SECONDS must be a number/);
  assert.throws(() => readServerSettings({ SYNC_POLL_LOOKBACK_MINUTES: '-5' }), /SYNC_POLL_LOOKBACK_MINUTES must be a number from 0/);
  assert.throws(() => numberSetting({ X: 'abc' }, 'X', 1), /X must be a number/);
});
