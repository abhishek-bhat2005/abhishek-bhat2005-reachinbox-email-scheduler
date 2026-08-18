import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, errorName } from "../../src/observability/logger.js";

afterEach(() => vi.restoreAllMocks());

describe("structured logger", () => {
  it("honors the configured level and redacts sensitive context keys", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = createLogger({ LOG_LEVEL: "info" }, "test");

    logger.debug("hidden");
    logger.info("started", { batchId: "batch-1" });
    logger.error("failed", { sessionToken: "private", errorName: "TypeError" });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"batchId":"batch-1"'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"sessionToken":"[REDACTED]"'));
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining("private"));
  });

  it("reduces unknown errors to a safe class name", () => {
    expect(errorName(new TypeError("sensitive detail"))).toBe("TypeError");
    expect(errorName("not an error")).toBe("UnknownError");
  });
});
