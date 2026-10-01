// The Prompt Battle host model test panel (base spec section 7.5) is a
// dev/host tool: model menu, Test button, returned images, reported cost.
// These are source-level regression tests, in the style of
// image-suggestion-removal.test.js, that pin the two guarantees a UI review
// can't verify by reading a render call in isolation:
//
//   1. The panel only renders on the host title screen, never for player or
//      presentation, and its model choice is always a <select>, never a
//      free-text field feeding the Worker's deployment allowlist.
//   2. The generated-image response never becomes part of the broadcast
//      `state` object, so it can't leak into publicRoomState().
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function functionBody(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `could not find function ${name} in app.js`);
  const nextFunction = app.indexOf("\nfunction ", start + 1);
  return app.slice(start, nextFunction > 0 ? nextFunction : undefined);
}

test("the test panel is defined once and rendered only from the host's title-screen lobby block", () => {
  const definitions = app.match(/function battleTestImagePanel\(/g) || [];
  assert.equal(definitions.length, 1, "battleTestImagePanel should be defined exactly once");
  const callSites = app.match(/\$\{battleTestImagePanel\(\)\}/g) || [];
  assert.equal(callSites.length, 1, "battleTestImagePanel() should be called from exactly one render site");
  // That one call site must live inside the hostedLobby line, which is
  // itself gated on isHostedRoom && state.presentationScreen === "title".
  const hostedLobbyLine = app.split("\n").find((line) => line.includes("const hostedLobby ="));
  assert.ok(hostedLobbyLine, "expected a hostedLobby definition in renderHost()");
  assert.match(hostedLobbyLine, /isHostedRoom && state\.presentationScreen === "title"/);
  assert.match(hostedLobbyLine, /\$\{battleTestImagePanel\(\)\}/);
});

test("the model chooser is a <select>, never a free-text input", () => {
  const panel = functionBody("battleTestImagePanel");
  assert.match(panel, /<select data-battle-test-model/);
  assert.doesNotMatch(panel, /data-battle-test-model[^>]*type="text"/);
  assert.doesNotMatch(panel, /<input[^>]*data-battle-test-model/);
});

test("the panel never appears in the player or presentation render paths", () => {
  const player = functionBody("renderPlayer");
  const presenter = functionBody("renderPresenter");
  for (const [name, body] of [["renderPlayer", player], ["renderPresenter", presenter]]) {
    assert.doesNotMatch(body, /battleTestImagePanel|data-battle-test/, `${name} must not render the host-only test panel`);
  }
});

test("the panel calls the authenticated Worker route with room/host-secret headers, matching the existing host-route pattern", () => {
  const app_ = app; // full source, since the handler is defined in attachEvents()
  const handlerStart = app_.indexOf('"[data-battle-test-generate]"');
  assert.ok(handlerStart >= 0, "expected a click handler for [data-battle-test-generate]");
  const handlerBody = app_.slice(handlerStart, app_.indexOf("});", handlerStart));
  assert.match(handlerBody, /\/battle\/test-image/);
  assert.match(handlerBody, /"x-quiz-room":\s*roomCode/);
  assert.match(handlerBody, /"x-quiz-host-secret":\s*hostSecret/);
  assert.match(handlerBody, /method:\s*"POST"/);
});

test("the test-panel state is not part of the object CLAUDE.md's projection invariant governs", () => {
  // publicRoomState() is the only allowlisted path to a player/presentation
  // client (product invariant #5). The panel's generated images and model
  // choice must never be assigned onto `state`, or a future edit to
  // publicRoomState() could forward them.
  assert.doesNotMatch(app, /state\.battleTest/);
  assert.match(app, /let battleTestPanel = /, "expected battleTestPanel to be its own module-level variable, not a field on `state`");
});
