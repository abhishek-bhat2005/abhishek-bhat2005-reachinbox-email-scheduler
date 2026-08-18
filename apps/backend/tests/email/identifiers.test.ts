import { describe, expect, it } from "vitest";

import { createBullJobId, createRecipientIdempotencyKey } from "../../src/email/identifiers.js";

describe("email identifiers", () => {
  it("creates deterministic BullMQ-compatible and recipient identifiers", () => {
    const emailId = "b233d542-48ab-4cae-bbc4-f561405c738c";
    const first = createRecipientIdempotencyKey(emailId, "lead@example.com");
    const second = createRecipientIdempotencyKey(emailId, "lead@example.com");

    expect(createBullJobId(emailId)).toBe(`email_${emailId}`);
    expect(createBullJobId(emailId)).not.toContain(":");
    expect(first).toBe(second);
    expect(first).toMatch(/^recipient_[a-f0-9]{64}$/u);
  });
});
