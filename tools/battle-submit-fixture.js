export function createClient() {
  return {
    channel() {
      const channel = {
        on() { return channel; },
        subscribe(callback) { callback("SUBSCRIBED"); return channel; },
        send() { return Promise.resolve("ok"); },
        unsubscribe() { return Promise.resolve("ok"); },
      };
      return channel;
    },
    async rpc(name, args) {
      const fixture = window.__battleFixture;
      fixture.calls.push({ name, assetId: args?.p_asset_id || null });
      window.__persistBattleFixture();
      if (name === "join_live_room") {
        return { data: {
          playerId: "fixture-player-id",
          revision: 1,
          state: { phase: fixture.phase, presentationScreen: fixture.phase, battleRoundIndex: 0, players: [] },
        }, error: null };
      }
      if (name === "get_player_battle_state") {
        return { data: { roomCode: args.p_room_code, phase: fixture.phase, entry: structuredClone(fixture.entry) }, error: null };
      }
      if (name === "submit_battle_entry") {
        if (fixture.mode === "retryable") throw new TypeError("fixture network unavailable");
        if (fixture.mode === "rejected") return { data: null, error: { message: "Submissions are closed for this round", code: "P0001" } };
        if (fixture.mode === "pending") await new Promise((resolve) => setTimeout(resolve, 900));
        fixture.entry.submissionStatus = "submitted";
        fixture.lastSubmittedAssetId = args.p_asset_id;
        fixture.mode = "pending";
        window.__persistBattleFixture();
        return { data: { entryId: "fixture-entry", submittedAssetId: args.p_asset_id, submittedAt: "offline-fixture" }, error: null };
      }
      return { data: null, error: null };
    },
  };
}
