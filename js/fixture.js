import {
  createEmptyDmState,
  createHostState,
  applyDm,
  applyHost,
  appendSystemToGroups,
} from "./engine.js";
import { parseMarkdownLite } from "./entities.js";
import { dmIdFor } from "./ids.js";
import {
  makeFixtureAudio,
  makeFixtureFile,
  makeFixtureImage,
  makeFixtureVideo,
  mintMediaId,
} from "./media.js";

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
 * Build a fixture session with Phase 2–4 chrome samples.
 * @param {{ name: string, stickers?: { id: string }[] } | null} [pack]
 * @returns {Promise<{
 *   selfPeerId: string,
 *   hostState: import("./engine.js").HostState,
 *   dmState: import("./engine.js").DmState,
 *   media: Map<string, { blob: Blob, mime: string, size: number, width?: number, height?: number, senderPeerId: string }>,
 * }>}
 */
export async function buildFixture(pack = null) {
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

  // Public group (creator only) + Everyone group for mode demos.
  r = applyHost(
    hostState,
    { type: "create-group", title: "Open board", mode: "public" },
    { actorPeerId: PEERS.mira.peerId },
  );
  if (!r.ok) throw new Error(r.error);
  hostState = r.state;
  r = applyHost(
    hostState,
    { type: "create-group", title: "All hands", mode: "everyone" },
    { actorPeerId: PEERS.host.peerId },
  );
  if (!r.ok) throw new Error(r.error);
  hostState = r.state;

  const notesId = Object.keys(hostState.groups).find(
    (id) => hostState.groups[id].title === "Dev notes",
  );
  r = applyHost(
    hostState,
    {
      type: "send-text",
      chatId: notesId,
      text: "Phase 7 fixture: polish — reactions, forward, pin/mute",
    },
    { actorPeerId: PEERS.mira.peerId },
  );
  if (!r.ok) throw new Error(r.error);
  hostState = r.state;

  const stickerIds = (pack?.stickers || []).map((s) => s.id).filter(Boolean);
  const packName = pack?.name || "TofPaintSafe";
  const sid0 = stickerIds[0] || "AgADegEAAki6kgc";
  const sid1 = stickerIds[1] || stickerIds[0] || "AgADfAEAAki6kgc";

  r = applyHost(
    hostState,
    {
      type: "send-sticker",
      chatId: groupId,
      pack: packName,
      stickerId: sid0,
    },
    { actorPeerId: PEERS.mira.peerId },
  );
  if (!r.ok) throw new Error(r.error);
  hostState = r.state;

  r = applyHost(
    hostState,
    {
      type: "send-sticker",
      chatId: groupId,
      pack: packName,
      stickerId: sid1,
      replyTo: miraMsgId,
    },
    { actorPeerId: PEERS.self.peerId },
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

  dr = applyDm(dmState, PEERS.self.peerId, {
    type: "dm-send-sticker",
    dmId,
    pack: packName,
    stickerId: sid0,
  });
  if (!dr.ok) throw new Error(dr.error);
  dmState = dr.state;

  /** @type {Map<string, { blob: Blob, mime: string, size: number, width?: number, height?: number, senderPeerId: string }>} */
  const media = new Map();

  const imgA = await makeFixtureImage("Photo A", "#3a7bd5");
  const imgB = await makeFixtureImage("Photo B", "#c94b4b");
  const imgC = await makeFixtureImage("Album C", "#2d8f5f");
  const imgDm = await makeFixtureImage("DM pic", "#8e44ad");

  const midA = mintMediaId();
  const midB = mintMediaId();
  const midC = mintMediaId();
  const midDm = mintMediaId();

  media.set(midA, {
    ...imgA,
    senderPeerId: PEERS.mira.peerId,
  });
  media.set(midB, {
    ...imgB,
    senderPeerId: PEERS.self.peerId,
  });
  media.set(midC, {
    ...imgC,
    senderPeerId: PEERS.self.peerId,
  });
  media.set(midDm, {
    ...imgDm,
    senderPeerId: PEERS.self.peerId,
  });

  r = applyHost(
    hostState,
    {
      type: "send-media",
      chatId: groupId,
      mediaIds: [midA],
      text: "Look at this photo",
    },
    { actorPeerId: PEERS.mira.peerId },
  );
  if (!r.ok) throw new Error(r.error);
  hostState = r.state;

  r = applyHost(
    hostState,
    {
      type: "send-media",
      chatId: groupId,
      mediaIds: [midB, midC],
      text: "Album sample",
      replyTo: miraMsgId,
    },
    { actorPeerId: PEERS.self.peerId },
  );
  if (!r.ok) throw new Error(r.error);
  hostState = r.state;

  dr = applyDm(dmState, PEERS.self.peerId, {
    type: "dm-send-media",
    dmId,
    mediaIds: [midDm],
    text: "private pic",
  });
  if (!dr.ok) throw new Error(dr.error);
  dmState = dr.state;

  const clip = await makeFixtureVideo("Clip");
  if (clip) {
    const midVid = mintMediaId();
    const midVidDm = mintMediaId();
    media.set(midVid, {
      blob: clip.blob,
      mime: clip.mime,
      size: clip.size,
      width: clip.width,
      height: clip.height,
      duration: clip.duration,
      senderPeerId: PEERS.self.peerId,
    });
    media.set(midVidDm, {
      blob: clip.blob,
      mime: clip.mime,
      size: clip.size,
      width: clip.width,
      height: clip.height,
      duration: clip.duration,
      senderPeerId: PEERS.self.peerId,
    });

    const vidInfo = [
      {
        size: clip.size,
        mime: clip.mime,
        duration: clip.duration,
        width: clip.width,
        height: clip.height,
      },
    ];
    r = applyHost(
      hostState,
      {
        type: "send-media",
        chatId: groupId,
        mediaIds: [midVid],
        mediaInfo: vidInfo,
        mediaKind: "video",
        text: "Short clip",
      },
      { actorPeerId: PEERS.self.peerId },
    );
    if (!r.ok) throw new Error(r.error);
    hostState = r.state;

    dr = applyDm(dmState, PEERS.self.peerId, {
      type: "dm-send-media",
      dmId,
      mediaIds: [midVidDm],
      mediaInfo: vidInfo,
      mediaKind: "video",
      text: "DM clip",
    });
    if (!dr.ok) throw new Error(dr.error);
    dmState = dr.state;
  } else {
    const sys = appendSystemToGroups(
      hostState,
      "Video fixture skipped (MediaRecorder unavailable)",
      [groupId],
    );
    hostState = sys.state;
  }

  const tone = await makeFixtureAudio();
  if (tone) {
    const midAud = mintMediaId();
    const midAudDm = mintMediaId();
    media.set(midAud, {
      blob: tone.blob,
      mime: tone.mime,
      size: tone.size,
      duration: tone.duration,
      senderPeerId: PEERS.self.peerId,
    });
    media.set(midAudDm, {
      blob: tone.blob,
      mime: tone.mime,
      size: tone.size,
      duration: tone.duration,
      senderPeerId: PEERS.self.peerId,
    });

    const audInfo = [
      {
        size: tone.size,
        mime: tone.mime,
        duration: tone.duration,
      },
    ];
    r = applyHost(
      hostState,
      {
        type: "send-media",
        chatId: groupId,
        mediaIds: [midAud],
        mediaInfo: audInfo,
        mediaKind: "audio",
        text: "Short tone",
      },
      { actorPeerId: PEERS.self.peerId },
    );
    if (!r.ok) throw new Error(r.error);
    hostState = r.state;

    dr = applyDm(dmState, PEERS.self.peerId, {
      type: "dm-send-media",
      dmId,
      mediaIds: [midAudDm],
      mediaInfo: audInfo,
      mediaKind: "audio",
      text: "DM tone",
    });
    if (!dr.ok) throw new Error(dr.error);
    dmState = dr.state;
  } else {
    const sys = appendSystemToGroups(
      hostState,
      "Audio fixture skipped",
      [groupId],
    );
    hostState = sys.state;
  }

  const doc = makeFixtureFile();
  const midFile = mintMediaId();
  const midFileDm = mintMediaId();
  media.set(midFile, {
    blob: doc.blob,
    mime: doc.mime,
    size: doc.size,
    fileName: doc.fileName,
    senderPeerId: PEERS.self.peerId,
  });
  media.set(midFileDm, {
    blob: doc.blob,
    mime: doc.mime,
    size: doc.size,
    fileName: doc.fileName,
    senderPeerId: PEERS.self.peerId,
  });

  const fileInfo = [
    {
      size: doc.size,
      mime: doc.mime,
      fileName: doc.fileName,
    },
  ];
  r = applyHost(
    hostState,
    {
      type: "send-media",
      chatId: groupId,
      mediaIds: [midFile],
      mediaInfo: fileInfo,
      mediaKind: "file",
      text: "Sample doc",
    },
    { actorPeerId: PEERS.self.peerId },
  );
  if (!r.ok) throw new Error(r.error);
  hostState = r.state;

  dr = applyDm(dmState, PEERS.self.peerId, {
    type: "dm-send-media",
    dmId,
    mediaIds: [midFileDm],
    mediaInfo: fileInfo,
    mediaKind: "file",
    text: "DM doc",
  });
  if (!dr.ok) throw new Error(dr.error);
  dmState = dr.state;

  const reactTarget =
    hostState.groupMessages[groupId]?.find((m) => m.kind === "text") ||
    hostState.groupMessages[groupId]?.[0];
  if (reactTarget) {
    r = applyHost(
      hostState,
      {
        type: "set-reaction",
        chatId: groupId,
        messageId: reactTarget.id,
        emoji: "👍",
      },
      { actorPeerId: PEERS.self.peerId },
    );
    if (!r.ok) throw new Error(r.error);
    hostState = r.state;
    r = applyHost(
      hostState,
      {
        type: "set-reaction",
        chatId: groupId,
        messageId: reactTarget.id,
        emoji: "🔥",
      },
      { actorPeerId: PEERS.mira.peerId },
    );
    if (!r.ok) throw new Error(r.error);
    hostState = r.state;
  }

  const dmText = dmState.dmMessages[dmId]?.find((m) => m.kind === "text");
  if (dmText) {
    dr = applyDm(dmState, PEERS.self.peerId, {
      type: "dm-reaction",
      dmId,
      messageId: dmText.id,
      emoji: "❤️",
    });
    if (!dr.ok) throw new Error(dr.error);
    dmState = dr.state;
  }

  if (reactTarget && notesId) {
    r = applyHost(
      hostState,
      {
        type: "forward-message",
        fromChatId: groupId,
        messageId: reactTarget.id,
        toChatId: notesId,
        fromName: "Mira",
      },
      { actorPeerId: PEERS.self.peerId },
    );
    if (!r.ok) throw new Error(r.error);
    hostState = r.state;
  }

  return {
    selfPeerId: PEERS.self.peerId,
    hostState,
    dmState,
    media,
  };
}

export { PEERS };
