import { describe, expect, it } from "vitest";

import { LeadFileError, parseLeadFile } from "../../src/email/lead-parser.js";

describe("lead file parsing", () => {
  it("parses a CSV email column and reports invalid and duplicate rows", () => {
    const file = Buffer.from(
      "name,email\nAda,ada@example.com\nInvalid,not-an-email\nDuplicate,ada@example.com\nGrace,Grace@EXAMPLE.COM\n",
    );

    const result = parseLeadFile(file, "leads.csv", "text/csv", 100);

    expect(result).toEqual({
      leads: [
        { email: "ada@example.com", normalizedEmail: "ada@example.com" },
        { email: "Grace@example.com", normalizedEmail: "Grace@example.com" },
      ],
      totalRows: 4,
      invalidCount: 1,
      duplicateCount: 1,
      invalidRows: [{ row: 3, value: "not-an-email", reason: "invalid_email" }],
    });
  });

  it("parses comma-separated and line-separated text leads", () => {
    const result = parseLeadFile(
      Buffer.from("one@example.com, two@example.com\nthree@example.com"),
      "leads.txt",
      "text/plain",
      100,
    );

    expect(result.leads).toHaveLength(3);
    expect(result.totalRows).toBe(3);
  });

  it("rejects unsupported files, malformed multi-column CSV, and configured overflow", () => {
    expect(() =>
      parseLeadFile(Buffer.from("a@example.com"), "leads.json", "text/plain", 10),
    ).toThrow(LeadFileError);
    expect(() =>
      parseLeadFile(Buffer.from("Ada,ada@example.com"), "leads.csv", "text/csv", 10),
    ).toThrow("must contain an email header");
    expect(() =>
      parseLeadFile(Buffer.from("one@example.com\ntwo@example.com"), "leads.txt", "text/plain", 1),
    ).toThrow("configured maximum");
  });

  it("returns zero valid recipients for an empty or entirely invalid file", () => {
    const empty = parseLeadFile(Buffer.from(""), "leads.txt", "text/plain", 100);
    const invalid = parseLeadFile(Buffer.from("not-an-email"), "leads.txt", "text/plain", 100);

    expect(empty.leads).toEqual([]);
    expect(empty.totalRows).toBe(0);
    expect(invalid.leads).toEqual([]);
    expect(invalid.invalidCount).toBe(1);
  });
});
