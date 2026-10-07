import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  createPromptBattleRound,
  duplicatePromptBattleRound,
  isRestorableAuthorDraft,
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

test('a restored battle draft with missing or malformed prompts can reach the editor action safely', () => {
  const source = readFileSync(new URL('../author.js', import.meta.url), 'utf8');
  const start = source.indexOf('function bindEditorEvents() {');
  const sentinel = '  $("[data-bonus-enabled]")';
  const end = source.indexOf(sentinel, start);
  const branch = source.slice(start, end).trimEnd() + '}';

  for (const prompts of [undefined, { preserved: true }]) {
    const round = createPromptBattleRound('r', 'R');
    if (prompts === undefined) delete round.prompts;
    else round.prompts = prompts;
    assert.equal(isRestorableAuthorDraft({ bank: { rounds: [round] } }), true);

    let addPrompt;
    const addButton = { addEventListener: (_event, callback) => { addPrompt = callback; } };
    const context = {
      selectedRound: () => round,
      selection: { roundIndex: 0 },
      setPromptBattleField,
      markChanged: () => {},
      renderNav: () => {},
      renderQuizHealth: () => {},
      renderPreview: () => {},
      promptBattleErrorsByField,
      addPromptToBattleRound,
      removePromptFromBattleRound,
      renderEditor: () => {},
      render: () => {},
      document: { querySelectorAll: (selector) => selector === '[data-add-battle-prompt]' ? [addButton] : [] },
      crypto: { randomUUID: () => '00000000' },
    };

    vm.runInNewContext(branch + ';bindEditorEvents();', context, { filename: 'author-branch.vm' });
    assert.ok(addPrompt, 'Add prompt listener should be bound');
    assert.doesNotThrow(addPrompt);
    if (prompts === undefined) assert.deepEqual(round.prompts, [{ id: 'prompt-00000000', text: '' }]);
    else {
      assert.deepEqual(round.prompts, { preserved: true });
      assert.match(promptBattleErrorsByField(round, 0).prompts, /needs at least one battle prompt/);
    }
  }
});

test('malformed battle prompt containers remain visible, invalid, and safe to copy or remove', () => {
  const source = readFileSync(new URL('../author.js', import.meta.url), 'utf8');
  const extract = (name, nextName) => {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf(`\nfunction ${nextName}(`, start);
    assert.ok(start >= 0 && end > start, `${name} source found`);
    return source.slice(start, end);
  };
  const navSource = extract('renderNav', 'renderQuizHealth');
  const editorSource = extract('renderPromptBattleEditor', 'renderEditor');
  const cases = [
    { name: 'missing list', round: () => { const value = createPromptBattleRound('r', 'R'); delete value.prompts; return value; } },
    { name: 'non-array list', round: () => ({ ...createPromptBattleRound('r', 'R'), prompts: { preserved: true } }) },
    { name: 'null prompt row', round: () => ({ ...createPromptBattleRound('r', 'R'), prompts: [null] }) },
  ];

  for (const { name, round: createRound } of cases) {
    const round = createRound();
    assert.equal(isRestorableAuthorDraft({ bank: { rounds: [round] } }), true, `${name} remains recoverable`);

    const elements = {
      '#nav-title': {},
      '#round-nav': { innerHTML: '' },
      '#add-battle-round': { addEventListener: () => {} },
    };
    const navContext = {
      $: (selector) => elements[selector],
      bank: { title: 'Quiz', rounds: [round] },
      navSearch: '',
      navTypeFilter: '',
      selection: { roundIndex: 0, questionIndex: 0 },
      escapeHtml: (value) => String(value),
      typeLabel: (value) => value,
      addPromptBattleRound: () => {},
      document: { querySelectorAll: () => [] },
    };
    assert.doesNotThrow(() => vm.runInNewContext(`${navSource};renderNav();`, navContext), `${name} navigation`);

    const editorContext = {
      selection: { roundIndex: 0 },
      round,
      promptBattleErrorsByField,
      battleField: () => '',
      escapeHtml: (value) => String(value),
    };
    assert.doesNotThrow(() => vm.runInNewContext(`${editorSource};result=renderPromptBattleEditor(round);`, editorContext), `${name} editor rendering`);
    assert.match(editorContext.result, /data-battle-error="prompts"/);
    if (name !== 'null prompt row') assert.match(editorContext.result, /needs at least one battle prompt/);
    else assert.match(editorContext.result, /must be an object/);

    assert.doesNotThrow(() => duplicatePromptBattleRound(round, 'copy', () => 'new-prompt'), `${name} duplication`);
    assert.doesNotThrow(() => removePromptFromBattleRound(round, 0), `${name} removal`);
    if (name === 'non-array list') assert.deepEqual(round.prompts, { preserved: true }, 'invalid persisted data is left untouched');
  }
});
