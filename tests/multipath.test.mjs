import assert from "node:assert/strict";
import test from "node:test";
import { loadSessionIdentity, verifySignedValue } from "../js/identity.js";
import { MultipathRoom } from "../js/multipath.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
  removeItem(key) {
    this.values.delete(key);
  }
}

globalThis.sessionStorage = new MemoryStorage();

class FakeBus {
  /** @param {(a: string, b: string) => boolean} canConnect */
  constructor(canConnect) {
    this.canConnect = canConnect;
    this.rooms = new Map();
  }

  join(label) {
    return () => {
      const room = new FakeRoom(this, label);
      this.rooms.set(label, room);
      for (const other of this.rooms.values()) {
        if (other === room || !this.canConnect(label, other.label)) continue;
        queueMicrotask(() => other.peerJoin?.(label));
      }
      return room;
    };
  }
}

class FakeRoom {
  constructor(bus, label) {
    this.bus = bus;
    this.label = label;
    this.actions = new Map();
    this.peerJoin = null;
    this.peerLeave = null;
  }

  set onPeerJoin(fn) {
    this.peerJoin = fn;
    for (const other of this.bus.rooms.values()) {
      if (
        other !== this &&
        this.bus.canConnect(this.label, other.label)
      ) {
        queueMicrotask(() => fn(other.label));
      }
    }
  }

  set onPeerLeave(fn) {
    this.peerLeave = fn;
  }

  makeAction(name) {
    if (this.actions.has(name)) return this.actions.get(name);
    const action = {
      onMessage: null,
      send: async (data, opts = {}) => {
        const targets = opts.target
          ? [this.bus.rooms.get(opts.target)].filter(Boolean)
          : [...this.bus.rooms.values()].filter((room) => room !== this);
        for (const target of targets) {
          if (!this.bus.canConnect(this.label, target.label)) continue;
          const remote = target.actions.get(name);
          if (typeof remote?.onMessage === "function") {
            queueMicrotask(() =>
              remote.onMessage(structuredClone(data), {
                peerId: this.label,
              }),
            );
          }
        }
      },
    };
    this.actions.set(name, action);
    return action;
  }

  getPeers() {
    return Object.fromEntries(
      [...this.bus.rooms.values()]
        .filter(
          (room) =>
            room !== this &&
            this.bus.canConnect(this.label, room.label),
        )
        .map((room) => [
          room.label,
          {
            connectionState: "connected",
            iceConnectionState: "connected",
          },
        ]),
    );
  }

  leave() {
    this.bus.rooms.delete(this.label);
    for (const other of this.bus.rooms.values()) {
      if (this.bus.canConnect(this.label, other.label)) {
        queueMicrotask(() => other.peerLeave?.(this.label));
      }
    }
  }
}

async function identity(name) {
  globalThis.sessionStorage = new MemoryStorage();
  return loadSessionIdentity(`test-${name}`);
}

async function settle(ms = 300) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("session identities sign and verify routed values", async () => {
  const signer = await identity("signer");
  const value = { packetId: "p1", payload: "hello" };
  const signature = await signer.sign(value);
  assert.equal(
    await verifySignedValue(
      signer.peerId,
      signer.publicJwk,
      value,
      signature,
    ),
    true,
  );
  assert.equal(
    await verifySignedValue(
      signer.peerId,
      signer.publicJwk,
      { ...value, payload: "changed" },
      signature,
    ),
    false,
  );
});

test("routes text, DM, and media chunks through an intermediate peer", async () => {
  const canConnect = (a, b) => {
    const pair = [a, b].sort().join("-");
    return pair === "A-C" || pair === "A-D" || pair === "B-C";
  };
  const mqtt = new FakeBus(canConnect);
  const nostr = new FakeBus(canConnect);
  const [idA, idB, idC, idD] = await Promise.all([
    identity("A"),
    identity("B"),
    identity("C"),
    identity("D"),
  ]);
  const makeRoom = (label, signer) =>
    new MultipathRoom({
      strategies: [
        { name: "mqtt", joinRoom: mqtt.join(label) },
        { name: "nostr", joinRoom: nostr.join(label) },
      ],
      config: { appId: "test" },
      roomId: "room",
      identity: signer,
    });

  const roomA = makeRoom("A", idA);
  // D is deliberately joined first and is a dead-end branch for B.
  const roomD = makeRoom("D", idD);
  const roomC = makeRoom("C", idC);
  const roomB = makeRoom("B", idB);
  const actionA = roomA.makeAction("chat");
  roomC.makeAction("chat");
  const actionB = roomB.makeAction("chat");
  const received = [];
  actionB.onMessage = (data, meta) => received.push({ data, meta });

  await settle();
  await actionA.send(
    { type: "event", body: { text: "group text" } },
    { target: idB.peerId },
  );
  await actionA.send(
    { type: "dm-send-text", body: { text: "private for now" } },
    { target: idB.peerId },
  );
  await actionA.send(
    { type: "media-chunk", body: { mediaId: "m1", index: 0, data: "AA" } },
    { target: idB.peerId },
  );
  await settle();

  assert.deepEqual(
    received.map((item) => item.data.type),
    ["event", "dm-send-text", "media-chunk"],
  );
  assert.ok(received.every((item) => item.meta.peerId === idA.peerId));

  roomA.leave();
  roomB.leave();
  roomC.leave();
  roomD.leave();
});

test("deduplicates packets arriving through MQTT and Nostr", async () => {
  const all = () => true;
  const mqtt = new FakeBus(all);
  const nostr = new FakeBus(all);
  const [idA, idB] = await Promise.all([identity("DA"), identity("DB")]);
  const roomA = new MultipathRoom({
    strategies: [
      { name: "mqtt", joinRoom: mqtt.join("A") },
      { name: "nostr", joinRoom: nostr.join("A") },
    ],
    config: {},
    roomId: "room",
    identity: idA,
  });
  const roomB = new MultipathRoom({
    strategies: [
      { name: "mqtt", joinRoom: mqtt.join("B") },
      { name: "nostr", joinRoom: nostr.join("B") },
    ],
    config: {},
    roomId: "room",
    identity: idB,
  });
  const actionA = roomA.makeAction("chat");
  const actionB = roomB.makeAction("chat");
  let count = 0;
  actionB.onMessage = () => {
    count += 1;
  };

  await settle();
  await actionA.send(
    { type: "roster", body: {} },
    { target: idB.peerId },
  );
  await settle(100);
  assert.equal(count, 1);

  roomA.leave();
  roomB.leave();
});
