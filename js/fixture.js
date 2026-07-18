import {
  createEmptyDmState,
  createHostState,
  applyDm,
  applyHost,
  appendSystemToGroups,
} from "./engine.js";
import { parseMarkdownLite } from "./entities.js";
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
 * Build a fixture session with Phase 2 chrome samples.
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

  // Reply to Mira's first message + spoiler formatting
  const miraMsgId = hostState.groupMessages[groupId][0].id;
  const spoilerParsed = parseMarkdownLite(
    "Don't tell Ken: ||the cake is a lie|| — also *bold* and `code`",
  );
  r = applyHost(
    hostState,
    {
      type: "send-text",
      chatId: groupId,
      text: spoilerParsed.text,
      entities: spoilerParsed.entities,
      replyTo: miraMsgId,
    },
    { actorPeerId: PEERS.self.peerId },
  );
  if (!r.ok) throw new Error(r.error);
  hostState = r.state;

  // Fully delivered checks on self's earlier message
  const selfPlainId = hostState.groupMessages[groupId].find(
    (m) => m.text?.includes("Works for me"),
  )?.id;
  if (selfPlainId) {
    for (const peer of [PEERS.host.peerId, PEERS.mira.peerId, PEERS.ken.peerId]) {
      r = applyHost(
        hostState,
        { type: "ack-delivery", chatId: groupId, messageIds: [selfPlainId] },
        { actorPeerId: peer },
      );
      if (!r.ok) throw new Error(r.error);
      hostState = r.state;
    }
  }

  // Edited message
  const toEditId = hostState.groupMessages[groupId].find(
    (m) => m.senderPeerId === PEERS.self.peerId && m.replyTo,
  )?.id;
  if (toEditId) {
    const edited = parseMarkdownLite(
      "Don't tell Ken: ||the cake is chocolate|| — also *bold* and `code`",
    );
    r = applyHost(
      hostState,
      {
        type: "edit-message",
        chatId: groupId,
        messageId: toEditId,
        text: edited.text,
        entities: edited.entities,
      },
      { actorPeerId: PEERS.self.peerId },
    );
    if (!r.ok) throw new Error(r.error);
    hostState = r.state;
  }

  const sys = appendSystemToGroups(
    hostState,
    "Ken joined the session",
    [groupId],
  );
  hostState = sys.state;

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
    {
      type: "send-text",
      chatId: notesId,
      text: "Phase 2 fixture: reply, spoiler, edit, checks",
    },
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
  dmState.dmMessages[dmId] = [
    {
      id: "m_fix_mira",
      chatId: dmId,
      senderPeerId: PEERS.mira.peerId,
      createdAt: Date.now() - 60_000,
      kind: "text",
      text: "Secret: don't tell the group about the cake",
      delivery: { ackedBy: [PEERS.self.peerId] },
    },
  ];
  dr = applyDm(dmState, PEERS.self.peerId, {
    type: "dm-send-text",
    dmId,
    text: "haha noted — host must not see this thread",
    replyTo: "m_fix_mira",
  });
  if (!dr.ok) throw new Error(dr.error);
  dmState = dr.state;
  // Mira acked our DM → double check
  dr = applyDm(
    dmState,
    PEERS.self.peerId,
    {
      type: "dm-ack",
      dmId,
      messageIds: [dr.message.id],
    },
    { remoteSenderPeerId: PEERS.mira.peerId },
  );
  if (!dr.ok) throw new Error(dr.error);
  dmState = dr.state;

  return {
    selfPeerId: PEERS.self.peerId,
    hostState,
    dmState,
  };
}

export { PEERS };
