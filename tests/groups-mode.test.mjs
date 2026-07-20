import test from "node:test";
import assert from "node:assert/strict";
import {
  addRosterPeer,
  applyHost,
  createEmptyDmState,
  createHostState,
  effectNeedsRosterFanout,
  enrollPeerInEveryoneGroups,
  filterHostStateForPeer,
  listChatsForUi,
} from "../js/engine.js";

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

function withGuests(state, ...ids) {
  let next = state;
  for (const peerId of ids) {
    next = addRosterPeer(next, {
      peerId,
      displayName: peerId,
      online: true,
    });
  }
  return next;
}

test("create public with one member; outsider filter is title-only", () => {
  let state = withGuests(baseState(), "g1", "g2");
  const created = applyHost(
    state,
    { type: "create-group", title: "Board", mode: "public" },
    { actorPeerId: "g1" },
  );
  assert.equal(created.ok, true);
  state = created.state;
  const chatId = Object.keys(state.groups)[0];
  assert.deepEqual(state.groups[chatId].memberPeerIds, ["g1"]);
  assert.equal(state.groups[chatId].mode, "public");
  const createFx = created.effects.find((e) => e.event === "chat-created");
  assert.equal(createFx.publicStub, true);
  assert.equal(effectNeedsRosterFanout(state, createFx), true);

  // Seed a message only members should see.
  const sent = applyHost(
    state,
    { type: "send-text", chatId, text: "secret" },
    { actorPeerId: "g1" },
  );
  assert.equal(sent.ok, true);
  state = sent.state;

  const forOutsider = filterHostStateForPeer(state, "g2");
  assert.ok(forOutsider.groups[chatId]);
  assert.equal(forOutsider.groups[chatId].title, "Board");
  assert.deepEqual(forOutsider.groupMessages[chatId], []);

  const forMember = filterHostStateForPeer(state, "g1");
  assert.equal(forMember.groupMessages[chatId].length, 1);
});

test("join-group adds member and history; leave restores name-only", () => {
  let state = withGuests(baseState(), "g1", "g2");
  const created = applyHost(
    state,
    { type: "create-group", title: "Board", mode: "public" },
    { actorPeerId: "g1" },
  );
  state = created.state;
  const chatId = Object.keys(state.groups)[0];
  const sent = applyHost(
    state,
    { type: "send-text", chatId, text: "hello" },
    { actorPeerId: "g1" },
  );
  state = sent.state;

  const joined = applyHost(
    state,
    { type: "join-group", chatId },
    { actorPeerId: "g2" },
  );
  assert.equal(joined.ok, true);
  state = joined.state;
  assert.ok(state.groups[chatId].memberPeerIds.includes("g2"));
  const historyFx = joined.effects.find(
    (e) => e.event === "chat-created" && Array.isArray(e.messages),
  );
  assert.ok(historyFx);
  assert.ok(historyFx.messages.some((m) => m.text === "hello"));
  assert.equal(effectNeedsRosterFanout(state, historyFx), false);

  const left = applyHost(
    state,
    { type: "leave-group", chatId },
    { actorPeerId: "g2" },
  );
  assert.equal(left.ok, true);
  state = left.state;
  assert.ok(state.groups[chatId], "public leave keeps the group");
  assert.equal(state.groups[chatId].memberPeerIds.includes("g2"), false);

  const stubFx = left.effects.find((e) => e.event === "chat-created");
  assert.equal(effectNeedsRosterFanout(state, stubFx), true);

  const forOutsider = filterHostStateForPeer(state, "g2");
  assert.deepEqual(forOutsider.groupMessages[chatId], []);
});

test("create everyone = full roster; enrollPeerInEveryoneGroups for late joiner", () => {
  let state = withGuests(baseState(), "g1", "g2");
  const created = applyHost(
    state,
    { type: "create-group", title: "All", mode: "everyone" },
    { actorPeerId: "host" },
  );
  assert.equal(created.ok, true);
  state = created.state;
  const chatId = Object.keys(state.groups)[0];
  assert.deepEqual(
    [...state.groups[chatId].memberPeerIds].sort(),
    ["g1", "g2", "host"].sort(),
  );

  state = addRosterPeer(state, { peerId: "g3", displayName: "Late" });
  const enrolled = enrollPeerInEveryoneGroups(state, "g3");
  state = enrolled.state;
  assert.ok(state.groups[chatId].memberPeerIds.includes("g3"));
  assert.equal(enrolled.effects.length, 1);
  assert.deepEqual(enrolled.effects[0].memberPeerIds, ["g3"]);

  const leave = applyHost(
    state,
    { type: "leave-group", chatId },
    { actorPeerId: "g1" },
  );
  assert.equal(leave.ok, false);
  assert.match(leave.error, /Cannot leave/i);

  const add = applyHost(
    state,
    { type: "add-group-members", chatId, memberPeerIds: ["g1"] },
    { actorPeerId: "host" },
  );
  assert.equal(add.ok, false);
  assert.match(add.error, /Everyone is already/i);
});

test("listChatsForUi: joined before browse-only public rows", () => {
  let state = withGuests(baseState(), "g1", "g2");
  let r = applyHost(
    state,
    {
      type: "create-group",
      title: "Private",
      mode: "private",
      memberPeerIds: ["g1"],
    },
    { actorPeerId: "host" },
  );
  assert.equal(r.ok, true);
  state = r.state;
  r = applyHost(
    state,
    { type: "create-group", title: "Zebra Public", mode: "public" },
    { actorPeerId: "g1" },
  );
  assert.equal(r.ok, true);
  state = r.state;
  r = applyHost(
    state,
    { type: "create-group", title: "Alpha Public", mode: "public" },
    { actorPeerId: "g1" },
  );
  assert.equal(r.ok, true);
  state = r.state;

  const dm = createEmptyDmState();
  const forG2 = listChatsForUi(state, dm, "g2");
  const joined = forG2.filter((c) => c.joined !== false);
  const browse = forG2.filter((c) => c.joined === false);
  assert.equal(joined.length, 0);
  assert.equal(browse.length, 2);
  assert.deepEqual(
    browse.map((c) => c.title),
    ["Alpha Public", "Zebra Public"],
  );
  assert.ok(browse.every((c) => c.preview === "" && c.mode === "public"));

  const forHost = listChatsForUi(state, dm, "host");
  let lastJoinedIdx = -1;
  let firstBrowseIdx = -1;
  forHost.forEach((c, i) => {
    if (c.joined !== false) lastJoinedIdx = i;
    if (c.joined === false && firstBrowseIdx < 0) firstBrowseIdx = i;
  });
  assert.ok(firstBrowseIdx > lastJoinedIdx);
});
