import test from "node:test";
import assert from "node:assert/strict";
import {
  getPermission,
  markNotifyPromptSeen,
  notificationBody,
  notificationsSupported,
  shouldPromptForNotifications,
} from "../js/notify.js";

test("notificationBody covers common kinds", () => {
  assert.equal(notificationBody({ kind: "sticker" }), "Sticker");
  assert.equal(notificationBody({ kind: "media" }), "Photo");
  assert.equal(notificationBody({ kind: "text", text: "hi" }), "hi");
  assert.equal(notificationBody({ kind: "system", text: "joined" }), "joined");
  const long = "x".repeat(200);
  assert.ok(notificationBody({ text: long }).endsWith("…"));
  assert.ok(notificationBody({ text: long }).length <= 120);
});

test("notifications unsupported in Node reports denied / no prompt", () => {
  assert.equal(notificationsSupported(), false);
  assert.equal(getPermission(), "denied");
  assert.equal(shouldPromptForNotifications(), false);
});

test("markNotifyPromptSeen suppresses prompt key", () => {
  // In Node there is no Notification, so shouldPrompt stays false; still
  // exercise the localStorage write path without throwing.
  markNotifyPromptSeen();
  assert.equal(shouldPromptForNotifications(), false);
});
