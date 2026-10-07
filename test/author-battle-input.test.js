import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  createPromptBattleRound,
  setPromptBattleField,
  promptBattleErrorsByField,
  addPromptToBattleRound,
  removePromptFromBattleRound,
} from '../prompt-battle-editor.js';

test('author battle input binds input listener and updates validation on input', () => {
  const source = readFileSync(new URL('../author.js', import.meta.url), 'utf8');
  const start = source.indexOf('function bindEditorEvents() {');
  assert.ok(start >= 0, 'bindEditorEvents start found');
  const sentinel = '  $("[data-bonus-enabled]")';
  const end = source.indexOf(sentinel, start);
  assert.ok(end >= 0, 'bindEditorEvents end sentinel found');
  const branch = source.slice(start, end).trimEnd() + '}';

  const round = createPromptBattleRound('r', 'R');
  if (!round.engine) round.engine = {};
  round.engine.variants = 3;
  round.type = 'prompt_battle';

  const listeners = {};
  const input = {
    type: 'number',
    value: '3',
    dataset: { battleField: 'engine.variants' },
    addEventListener(event, callback) {
      listeners[event] = callback;
    },
  };
  const marker = {
    dataset: { battleError: 'engine.variants' },
    textContent: '',
    hidden: true,
  };

  const document = {
    querySelectorAll(selector) {
      if (selector === '[data-battle-field]') return [input];
      if (selector === '[data-battle-error]') return [marker];
      return [];
    },
  };

  let saved;
  let remounts = 0;
  const renderEditor = () => { remounts += 1; };
  const render = () => { remounts += 1; };
  const context = {
    selectedRound: () => round,
    selection: { roundIndex: 0 },
    setPromptBattleField,
    markChanged: () => {
      saved = JSON.parse(JSON.stringify(round));
    },
    renderNav: () => {},
    renderQuizHealth: () => {},
    renderPreview: () => {},
    promptBattleErrorsByField,
    addPromptToBattleRound,
    removePromptFromBattleRound,
    renderEditor,
    render,
    document,
    crypto: { randomUUID: () => '00000000' },
  };

  vm.runInNewContext(branch + ';bindEditorEvents();', context, { filename: 'author-branch.vm' });

  assert.ok(listeners.input, 'input listener should be bound');

  input.value = '7';
  listeners.input();

  assert.strictEqual(saved.engine.variants, 7);
  assert.strictEqual(remounts, 0);

  input.value = '0';
  listeners.input();

  const expectedErrors = promptBattleErrorsByField(round, 0);
  assert.strictEqual(marker.textContent, expectedErrors['engine.variants']);
  assert.strictEqual(marker.hidden, false);

  input.value = '7';
  listeners.input();

  assert.strictEqual(marker.textContent, '');
  assert.strictEqual(marker.hidden, true);
  assert.strictEqual(remounts, 0);
});
