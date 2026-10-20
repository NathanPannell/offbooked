import assert from "node:assert/strict";
import { test } from "node:test";
import { inviteExpiresAt, inviteToken, inviteUrl, parseInviteToken } from "./invite.ts";

const actorId = "5f0c1d7e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";

test("invite tokens round-trip and match the documented format", () => {
  const token = inviteToken("secret", actorId, 3);
  const [id, version, sig] = token.split(".");
  assert.equal(id, Buffer.from(actorId.replace(/-/g, ""), "hex").toString("base64url"));
  assert.equal(version, "3");
  assert.equal(sig!.length, 22);
  assert.deepEqual(parseInviteToken("secret", token), { actorId, tokenVersion: 3 });
  assert.equal(inviteUrl("https://offbooked.com", "secret", actorId, 3), `https://offbooked.com/i/${token}`);
});

test("forged, bumped or garbled tokens are rejected", () => {
  const token = inviteToken("secret", actorId, 1);
  assert.equal(parseInviteToken("other-secret", token), null);
  const [id, , sig] = token.split(".");
  assert.equal(parseInviteToken("secret", `${id}.2.${sig}`), null);
  assert.equal(parseInviteToken("secret", "nonsense"), null);
  assert.equal(parseInviteToken("secret", `${id}.1.${sig!.slice(0, 21)}x`), null);
});

test("invites expire when the content is deleted, 7 days after the final performance, or 120 days after creation", () => {
  const created = new Date("2026-01-01T00:00:00Z");
  assert.equal(inviteExpiresAt("2026-03-01", created).toISOString(), "2026-03-08T12:00:00.000Z");
  assert.equal(inviteExpiresAt(null, created).toISOString(), "2026-05-01T00:00:00.000Z");
});
