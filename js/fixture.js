import { createEmptyDmState, createHostState, applyDm, applyHost } from "./engine.js";
import { dmIdFor } from "./ids.js";

const PEERS = {
  host: {
    peerId: "peer_host",
    displayName: "Alex",
    role: "host",
    joinedAt: 1_700_000_000_000,
    colorIndex: 0,
  },
  self: {
    peerId: "peer_self",
    displayName: "You",
    role: "member",
    joinedAt: 1_700_000_000_100,
    colorIndex: 1,
  },
  mira: {
    peerId: "peer_mira",
    displayName: "Mira",
    role: "member",
    joinedAt: 1_700_000_000_200,
    colorIndex: 2,
  },
  ken: {
    peerId: "peer_ken",
    displayName: "Ken",
    role: "member",
    joinedAt: 1_700_000_000_300,
    colorIndex: 3,
  },
};

/**
 * Build a fixture session: host roster + groups + a private DM for self.
 * @returns {{ selfPeerId: string, hostState: import("./engine.js").HostState, dmState: import("./engine.js").DmState }}
 */
export function buildFixture() {
  let hostState = createHostState({
    sessionId: "fixture01",
    title: "Fixture session",
    hostPeer: PEERS.host,
  });

  hostState = {
    ...hostState,
    roster: [PEERS.host, PEERS.self, PEERS.mira, PEERS.ken],
  };

  let r = applyHost(
    hostState,
    {
      type: "create-group",
      title: "Weekend plans",
      memberPeerIds: [
        PEERS.host.peerId,
        PEERS.self.peerId,
        PEERS.mira.peerId,
        PEERS.ken.peerId,
      ],
    },
    { actorPeerId: PEERS.host.peerId },
  );
  if (!r.ok) throw new Error(r.error);
  hostState = r.state;
  const groupId = Object.keys(hostState.groups)[0];

  const groupScript = [
    { actor: PEERS.mira.peerId, text: "Anyone free Saturday?" },
    { actor: PEERS.ken.peerId, text: "I can do afternoon" },
    { actor: PEERS.self.peerId, text: "Works for me — let's meet at 3" },
    { actor: PEERS.host.peerId, text: "I'll book a table" },
  ];
  for (const line of groupScript) {
    r = applyHost(
      hostState,
      { type: "send-text", chatId: groupId, text: line.text },
      { actorPeerId: line.actor },
    );
    if (!r.ok) throw new Error(r.error);
    hostState = r.state;
  }

  r = applyHost(
    hostState,
    {
      type: "create-group",
      title: "Dev notes",
      memberPeerIds: [PEERS.host.peerId, PEERS.self.peerId, PEERS.mira.peerId],
    },
    { actorPeerId: PEERS.self.peerId },
  );
  if (!r.ok) throw new Error(r.error);
  hostState = r.state;
  const notesId = Object.keys(hostState.groups).find((id) => id !== groupId);
  r = applyHost(
    hostState,
    { type: "send-text", chatId: notesId, text: "Phase 0 fixture is live" },
    { actorPeerId: PEERS.mira.peerId },
  );
  if (!r.ok) throw new Error(r.error);
  hostState = r.state;

  let dmState = createEmptyDmState();
  let dr = applyDm(dmState, PEERS.self.peerId, {
    type: "dm-open",
    peerId: PEERS.mira.peerId,
  });
  if (!dr.ok) throw new Error(dr.error);
  dmState = dr.state;

  const dmId = dmIdFor(PEERS.self.peerId, PEERS.mira.peerId);
  const dmScript = [
    { text: "Secret: don't tell the group about the cake" },
    { text: "haha noted — host must not see this thread" },
  ];
  // Alternate: first from mira (simulate their send into local log), then self
  dmState.dmMessages[dmId] = [
    {
      id: "m_fix_mira",
      chatId: dmId,
      senderPeerId: PEERS.mira.peerId,
      createdAt: Date.now() - 60_000,
      kind: "text",
      text: dmScript[0],
    },
  ];
  dr = applyDm(dmState, PEERS.self.peerId, {
    type: "dm-send-text",
    dmId,
    text: dmScript[1],
  });
  if (!dr.ok) throw new Error(dr.error);
  dmState = dr.state;

  return {
    selfPeerId: PEERS.self.peerId,
    hostState,
    dmState,
  };
}

export { PEERS };
