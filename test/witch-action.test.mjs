import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWitchActionResources } from '../public/witch-action.js';

test('witch resources can only be used once', () => {
  assert.equal(validateWitchActionResources('save', { saveAvailable: true, killTargetId: 'P2' }).ok, true);
  assert.equal(validateWitchActionResources('save', { saveAvailable: false, killTargetId: 'P2' }).ok, false);
  assert.equal(validateWitchActionResources('poison', { poisonAvailable: true }).ok, true);
  assert.equal(validateWitchActionResources('poison', { poisonAvailable: false }).ok, false);
});

test('witch cannot spend antidote without a wolf target', () => {
  assert.equal(validateWitchActionResources('save', { saveAvailable: true, killTargetId: null }).ok, false);
  assert.equal(validateWitchActionResources('pass', {}).ok, true);
  assert.equal(validateWitchActionResources('invalid', {}).ok, false);
});
