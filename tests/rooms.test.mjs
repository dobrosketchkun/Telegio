import test from "node:test";
import assert from "node:assert/strict";
import {
  applyHost,
  applyHostEvent,
  createHostState,
  filterHostStateForPeer,
  mergeHostSnapshots,
} from "../js/engine.js";
import {
  makeSessionId,
  normalizePermanentRoomId,
  permanentSessionId,
} from "../js/ids.js";
import {
  canRestorePermanentRoom,
  compareHostClaims,
  HOST_GRACE_MS,
  isHostLeaseExpired,
  pickElectionWinner,
} from "../js/rooms.js";
import { ChatSession } from "../js/session.js";

test("normalizes typed room IDs and derives stable opaque namespaces", async () => {
  assert.equal(normalizePermanentRoomId("  My Friends  "), "my-friends");
  assert.throws(() => normalizePermanentRoomId("x"), /3–64/);
  assert.throws(() => normalizePermanentRoomId("bad/id"), /3–64/);
  const first = await permanentSessionId("My Friends");
  const second = await permanentSessionId("my-friends");
  const other = await permanentSessionId("other-room");
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^p_[A-Za-z0-9_-]{32}$/);
});

test("random session IDs contain at least 128 random bits", () => {
  const ids = new Set(Array.from({ length: 100 }, () => makeSessionId()));
  assert.equal(ids.size, 100);
  for (const id of ids) {
    assert.match(id, /^r_[A-Za-z0-9_-]{22}$/);
  }
});

test("first entrant hosts and simultaneous candidates use lowest ID", () => {
  assert.equal(pickElectionWinner(["peer-c", "peer-a", "peer-b"]), "peer-a");
  const session = fakePermanentSession("peer-a");
  session._candidateIds = new Set(["peer-a"]);
  session._permanentHostMissing = true;
  session._runElection(false);
  assert.equal(session.role, "host");
  assert.equal(session.electionTerm, 1);
  assert.equal(session.hostState.session.title, "shared-room");
  assert.equal(session._permanentHostMissing, false);
  session.leave({ endSession: false });
});

test("candidate joins an existing valid host claim", () => {
  const session = fakePermanentSession("peer-z");
  session._onElectionFrame(
    "host-claim",
    {
      roomId: "shared-room",
      hostId: "peer-a",
      term: 4,
      leaseExpiry: Date.now() + HOST_GRACE_MS,
    },
    "peer-a",
  );
  assert.equal(session.role, "guest");
  assert.equal(session.electionTerm, 4);
  assert.equal(session._hostHint, "peer-a");
  session.leave({ endSession: false });
});

test("host grace expires at 30 seconds and refresh state obeys lease", () => {
  const started = 10_000;
  assert.equal(isHostLeaseExpired(started, started + 29_999), false);
  assert.equal(isHostLeaseExpired(started, started + 30_000), true);
  const resume = {
    roomMode: "permanent",
    permanentRoomId: "shared-room",
    leaseExpiry: started + 30_000,
  };
  assert.equal(canRestorePermanentRoom(resume, "shared-room", started), true);
  assert.equal(
    canRestorePermanentRoom(resume, "shared-room", started + 30_000),
    false,
  );
  assert.equal(canRestorePermanentRoom(resume, "another-room", started), false);
});

test("an empty room restarts without resurrecting old shared state", () => {
  const fresh = mergeHostSnapshots([], {
    sessionId: "same-permanent-namespace",
    title: "shared-room",
    hostPeerId: "new-peer",
    hostDisplayName: "New peer",
  });
  assert.equal(fresh.session.id, "same-permanent-namespace");
  assert.equal(fresh.session.title, "shared-room");
  assert.deepEqual(fresh.groups, {});
  assert.deepEqual(fresh.groupMessages, {});
  assert.equal(fresh.roster.length, 1);
});

test("higher term wins and equal-term split brain picks lower host ID", () => {
  assert.ok(
    compareHostClaims(
      { term: 3, hostId: "peer-z" },
      { term: 2, hostId: "peer-a" },
    ) > 0,
  );
  assert.ok(
    compareHostClaims(
      { term: 3, hostId: "peer-a" },
      { term: 3, hostId: "peer-z" },
    ) > 0,
  );

  const losingHost = fakePermanentSession("peer-z");
  losingHost.role = "host";
  losingHost.electionTerm = 2;
  losingHost._hostHint = "peer-z";
  losingHost.hostState = createHostState({
    sessionId: "namespace",
    title: "shared-room",
    hostPeer: rosterPeer("peer-z", "Old host", "host"),
  });
  losingHost._onElectionFrame(
    "host-claim",
    { roomId: "shared-room", hostId: "peer-a", term: 3 },
    "peer-a",
  );
  assert.equal(losingHost.role, "guest");
  assert.equal(losingHost._hostHint, "peer-a");
  assert.ok(
    losingHost.sent.some(
      ({ frame, target }) =>
        frame.type === "state-handoff" && target === "peer-a",
    ),
  );
  losingHost.leave({ endSession: false });
});

test("state handoff unions group history, reactions, and acknowledgements", () => {
  const a = createHostState({
    sessionId: "namespace",
    title: "Room",
    hostPeer: rosterPeer("old-host", "Old host", "host"),
  });
  a.roster.push(rosterPeer("peer-a", "A"));
  a.groups.g1 = {
    id: "g1",
    kind: "group",
    title: "General",
    memberPeerIds: ["old-host", "peer-a"],
  };
  a.groupMessages.g1 = [
    message("m1", "old-host", "first", ["old-host"], ["👍", "peer-a"]),
  ];
  a.meta = { revision: 5, groupRevisions: { g1: 3 } };

  const b = structuredClone(a);
  b.roster.push(rosterPeer("peer-b", "B"));
  b.groups.g1.memberPeerIds.push("peer-b");
  b.groupMessages.g1[0].delivery.ackedBy.push("peer-b");
  b.groupMessages.g1.push(message("m2", "peer-b", "second", ["peer-b"]));
  b.meta = { revision: 6, groupRevisions: { g1: 4 } };

  const merged = mergeHostSnapshots([a, b], {
    sessionId: "namespace",
    title: "Room",
    hostPeerId: "peer-a",
    hostDisplayName: "A",
  });
  assert.deepEqual(
    merged.groupMessages.g1.map((entry) => entry.id),
    ["m1", "m2"],
  );
  assert.deepEqual(
    new Set(merged.groupMessages.g1[0].delivery.ackedBy),
    new Set(["old-host", "peer-b"]),
  );
  assert.equal(merged.roster.find((p) => p.role === "host").peerId, "peer-a");
  assert.equal(merged.meta.revision, 7);
  assert.equal(merged.meta.groupRevisions.g1, 4);
});

test("new group members receive the existing message history", () => {
  let hostState = createHostState({
    sessionId: "namespace",
    title: "Room",
    hostPeer: rosterPeer("host", "Host", "host"),
  });
  hostState.roster.push(
    rosterPeer("member-a", "Member A"),
    rosterPeer("member-b", "Member B"),
  );

  const created = applyHost(
    hostState,
    {
      type: "create-group",
      title: "History",
      memberPeerIds: ["member-a"],
    },
    { actorPeerId: "host" },
  );
  assert.equal(created.ok, true);
  hostState = created.state;
  const chatId = Object.keys(hostState.groups)[0];

  const sent = applyHost(
    hostState,
    { type: "send-text", chatId, text: "message from before" },
    { actorPeerId: "member-a" },
  );
  assert.equal(sent.ok, true);
  hostState = sent.state;

  let newcomerState = filterHostStateForPeer(hostState, "member-b");
  assert.equal(newcomerState.groups[chatId], undefined);

  const added = applyHost(
    hostState,
    {
      type: "add-group-members",
      chatId,
      memberPeerIds: ["member-b"],
    },
    { actorPeerId: "host" },
  );
  assert.equal(added.ok, true);
  for (const effect of added.effects) {
    newcomerState = applyHostEvent(newcomerState, effect);
  }

  assert.equal(newcomerState.groups[chatId].title, "History");
  assert.deepEqual(
    newcomerState.groupMessages[chatId].map((entry) => entry.text),
    ["message from before", "Host added Member B"],
  );
});

function fakePermanentSession(selfId) {
  const session = new ChatSession({
    onChange() {},
    onStatus() {},
    onError(error) {
      throw new Error(error);
    },
  });
  session.roomMode = "permanent";
  session.permanentRoomId = "shared-room";
  session._sessionId = "namespace";
  session._pendingDisplayName = selfId;
  session.selfPeerId = selfId;
  session.role = "candidate";
  session.sent = [];
  session._chat = {
    send(frame, options = {}) {
      session.sent.push({ frame, target: options.target });
      return Promise.resolve();
    },
  };
  return session;
}

function rosterPeer(peerId, displayName, role = "member") {
  return {
    peerId,
    displayName,
    role,
    joinedAt: 1,
    colorIndex: 0,
  };
}

function message(
  id,
  senderPeerId,
  text,
  ackedBy,
  reaction = undefined,
) {
  return {
    id,
    chatId: "g1",
    senderPeerId,
    kind: "text",
    text,
    createdAt: id === "m1" ? 1 : 2,
    delivery: { ackedBy },
    reactions: reaction
      ? [{ emoji: reaction[0], peerIds: [reaction[1]] }]
      : [],
  };
}
