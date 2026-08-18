import { describe, expect, it } from "vitest";

import { classifyDeliveryError } from "../../src/worker/email-processor.js";

describe("SMTP error classification", () => {
  it("separates permanent, transient, and ambiguous delivery failures", () => {
    expect(classifyDeliveryError({ code: "EAUTH" })).toBe("permanent");
    expect(classifyDeliveryError({ responseCode: 550 })).toBe("permanent");
    expect(classifyDeliveryError({ code: "EDNS" })).toBe("transient");
    expect(classifyDeliveryError({ responseCode: 421 })).toBe("transient");
    expect(classifyDeliveryError({ code: "ETIMEDOUT" })).toBe("unknown");
    expect(classifyDeliveryError(new Error("unclassified"))).toBe("unknown");
  });
});
