// secret.test.js — unit tests for timingSafeCompare helper
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeCompare } from '../server.js';

test('timingSafeCompare: equal strings return true', () => {
  assert.equal(timingSafeCompare('abc123', 'abc123'), true);
});

test('timingSafeCompare: equal-length unequal strings return false', () => {
  assert.equal(timingSafeCompare('abc123', 'xyz789'), false);
});

test('timingSafeCompare: unequal-length returns false without throwing', () => {
  assert.doesNotThrow(() => {
    const result = timingSafeCompare('short', 'muchlonger');
    assert.equal(result, false);
  });
});

test('timingSafeCompare: empty strings are equal', () => {
  assert.equal(timingSafeCompare('', ''), true);
});

test('timingSafeCompare: non-string a returns false', () => {
  assert.equal(timingSafeCompare(null, 'abc'), false);
});

test('timingSafeCompare: non-string b returns false', () => {
  assert.equal(timingSafeCompare('abc', undefined), false);
});

test('timingSafeCompare: one char off returns false', () => {
  assert.equal(timingSafeCompare('secret1', 'secret2'), false);
});
