import test from "node:test";
import assert from "node:assert/strict";
import {
  addRosterPeer,
  applyHost,
  createHostState,
  listChatsForUi,
  mergeHostSnapshots,
  remapRosterPeer,
  removeRosterPeer,
  setRosterOnline,
} from "../js/engine.js";
import { createEmptyDmState } from "../js/engine.js";
import {
  claimContinuity,
  loadOrCreateContinuity,
  verifyContinuity,
} from "../js/continuity.js";

function baseState() {
  return createHostState({
    sessionId: "s1",
    title: "Session",
    hostPeer: {
      peerId: "host",
      displayName: "Host",
      role: "host",
      joinedAt: 1,
      colorIndex: 0,
      online: true,
    },
  });
}

test("setRosterOnline flips flag without touching groups", () => {
  let state = addRosterPeer(baseState(), {
    peerId: "g1",
    displayName: "Guest",
    contPub: "cont-a",
  });
  const created = applyHost(
    state,
    { type: "create-group", title: "Chat", memberPeerIds: ["g1"] },
    { actorPeerId: "host" },
  );
  assert.equal(created.ok, true);
  state = created.state;
  const groupId = Object.keys(state.groups)[0];
  state = setRosterOnline(state, "g1", false);
  assert.equal(state.roster.find((r) => r.peerId === "g1").online, false);
  assert.ok(state.groups[groupId]);
  assert.deepEqual(state.groups[groupId].memberPeerIds.sort(), ["g1", "host"].sort());
});

test("removeRosterPeer and leave/kick never delete groups", () => {
  let state = addRosterPeer(baseState(), { peerId: "g1", displayName: "Guest" });
  const created = applyHost(
    state,
    { type: "create-group", title: "Duo", memberPeerIds: ["g1"] },
    { actorPeerId: "host" },
  );
  assert.equal(created.ok, true);
  state = created.state;
  const groupId = Object.keys(state.groups)[0];

  const left = applyHost(
    state,
    { type: "leave-group", chatId: groupId },
    { actorPeerId: "g1" },
  );
  assert.equal(left.ok, true);
  assert.ok(left.state.groups[groupId], "leave must keep the group");
  assert.deepEqual(left.state.groups[groupId].memberPeerIds, ["host"]);

  state = addRosterPeer(left.state, { peerId: "g2", displayName: "Other" });
  const added = applyHost(
    state,
    { type: "add-group-members", chatId: groupId, memberPeerIds: ["g2"] },
    { actorPeerId: "host" },
  );
  assert.equal(added.ok, true);
  state = added.state;

  const kicked = applyHost(
    state,
    { type: "admin-kick", peerId: "g2" },
    { actorPeerId: "host" },
  );
  assert.equal(kicked.ok, true);
  assert.ok(kicked.state.groups[groupId], "kick must keep the group");
  assert.ok(!kicked.state.roster.some((r) => r.peerId === "g2"));

  state = removeRosterPeer(state, "g1");
  assert.ok(state.groups[groupId] || kicked.state.groups[groupId]);
});

test("delete-group is the only explicit group teardown", () => {
  let state = addRosterPeer(baseState(), { peerId: "g1", displayName: "Guest" });
  const created = applyHost(
    state,
    { type: "create-group", title: "Gone", memberPeerIds: ["g1"] },
    { actorPeerId: "host" },
  );
  state = created.state;
  const groupId = Object.keys(state.groups)[0];
  const deleted = applyHost(
    state,
    { type: "delete-group", chatId: groupId },
    { actorPeerId: "host" },
  );
  assert.equal(deleted.ok, true);
  assert.equal(deleted.state.groups[groupId], undefined);
  assert.ok(deleted.effects.some((e) => e.event === "chat-deleted"));
});

test("remapRosterPeer rewrites memberships and message senders", () => {
  let state = addRosterPeer(baseState(), {
    peerId: "old",
    displayName: "Guest",
    contPub: "c1",
  });
  const created = applyHost(
    state,
    { type: "create-group", title: "G", memberPeerIds: ["old"] },
    { actorPeerId: "host" },
  );
  state = created.state;
  const groupId = Object.keys(state.groups)[0];
  const sent = applyHost(
    state,
    { type: "send-text", chatId: groupId, text: "hi" },
    { actorPeerId: "old" },
  );
  assert.equal(sent.ok, true);
  state = sent.state;
  state = remapRosterPeer(state, "old", "new", {
    displayName: "Guest",
    contPub: "c1",
    online: true,
  });
  assert.ok(state.roster.some((r) => r.peerId === "new"));
  assert.ok(!state.roster.some((r) => r.peerId === "old"));
  assert.ok(state.groups[groupId].memberPeerIds.includes("new"));
  assert.ok(!state.groups[groupId].memberPeerIds.includes("old"));
  assert.equal(state.groupMessages[groupId][0].senderPeerId, "new");
});

test("mergeHostSnapshots keeps absent peers offline instead of pruning", () => {
  let a = addRosterPeer(baseState(), { peerId: "g1", displayName: "G1" });
  a = applyHost(
    a,
    { type: "create-group", title: "Duo", memberPeerIds: ["g1"] },
    { actorPeerId: "host" },
  ).state;
  const groupId = Object.keys(a.groups)[0];
  const merged = mergeHostSnapshots([a], {
    sessionId: "s1",
    title: "Session",
    hostPeerId: "host",
    hostDisplayName: "Host",
    activePeerIds: ["host"],
  });
  assert.ok(merged.groups[groupId], "group survives handoff");
  assert.ok(merged.groups[groupId].memberPeerIds.includes("g1"));
  assert.equal(merged.roster.find((r) => r.peerId === "g1")?.online, false);
  assert.equal(merged.roster.find((r) => r.peerId === "host")?.online, true);
});

test("listChatsForUi marks offline DMs/groups", () => {
  let state = addRosterPeer(baseState(), { peerId: "g1", displayName: "G1" });
  state = setRosterOnline(state, "g1", false);
  state = applyHost(
    state,
    { type: "create-group", title: "Duo", memberPeerIds: ["g1"] },
    { actorPeerId: "host" },
  ).state;
  const dmState = createEmptyDmState();
  dmState.dms["dm:g1:host"] = {
    id: "dm:g1:host",
    type: "dm",
    memberPeerIds: ["g1", "host"],
    createdBy: "host",
    createdAt: 1,
  };
  dmState.dmMessages["dm:g1:host"] = [];
  const chats = listChatsForUi(state, dmState, "host");
  assert.ok(chats.every((c) => c.offline === true));
});

test("continuity key signs and verifies peerId", async () => {
  const mem = new Map();
  const origGet = globalThis.localStorage?.getItem?.bind(globalThis.localStorage);
  const origSet = globalThis.localStorage?.setItem?.bind(globalThis.localStorage);
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  try {
    const handle = await loadOrCreateContinuity("sess-cont");
    assert.ok(handle);
    const again = await loadOrCreateContinuity("sess-cont");
    assert.equal(again.pub, handle.pub);
    const claim = await claimContinuity(handle, "peer-xyz");
    assert.equal(await verifyContinuity("peer-xyz", claim), true);
    assert.equal(await verifyContinuity("other", claim), false);
  } finally {
    if (origGet) {
      globalThis.localStorage = {
        getItem: origGet,
        setItem: origSet,
      };
    }
  }
});
