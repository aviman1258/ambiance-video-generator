import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sceneProblem } from '../web/scene-check.js';

test('real scene descriptions pass, including short and non-English ones', () => {
  for (const ok of [
    'Summer afternoon in rural Kolkata. Wind in the trees. Sunny with dust specs in the sunlight.',
    'Kerala houseboat',
    'Monsoon Mumbai apartment',
    'Rajasthani haveli at night',
    'Darjeeling tea estate in mist',
    'Varanasi ghats at dawn, diyas floating',
    'बारिश में मुंबई की शाम',
  ]) {
    assert.equal(sceneProblem(ok), null, ok);
  }
});

test('empty, too short, mashed or symbol-heavy input is rejected', () => {
  for (const bad of ['', '   ', 'rain', 'asdf qwer', 'asdfgh jkl', 'sdfsdf fdsa', 'xkcd zzzz qwrt', '!!!! ???? 1234 5678', 'aaaa bbbb', 'hjkl hjkl hjkl']) {
    assert.notEqual(sceneProblem(bad), null, JSON.stringify(bad));
  }
});
