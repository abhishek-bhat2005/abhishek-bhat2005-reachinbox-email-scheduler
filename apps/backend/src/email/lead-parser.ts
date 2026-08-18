import { extname } from "node:path";

import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";

const emailSchema = z.email().max(320);
const supportedMimeTypes = new Set([
  "application/csv",
  "application/octet-stream",
  "application/vnd.ms-excel",
  "text/csv",
  "text/plain",
]);
const invalidDetailLimit = 25;
const invalidValueLimit = 120;

export interface ParsedLead {
  email: string;
  normalizedEmail: string;
}

export interface InvalidLead {
  row: number;
  value: string;
  reason: "invalid_email";
}

export interface LeadParseResult {
  leads: ParsedLead[];
  totalRows: number;
  invalidCount: number;
  duplicateCount: number;
  invalidRows: InvalidLead[];
}

export class LeadFileError extends Error {
  readonly code: "INVALID_FILE" | "TOO_MANY_LEADS" | "UNSUPPORTED_FILE";

  constructor(code: "INVALID_FILE" | "TOO_MANY_LEADS" | "UNSUPPORTED_FILE", message: string) {
    super(message);
    this.name = "LeadFileError";
    this.code = code;
  }
}

interface Candidate {
  row: number;
  value: string;
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/u, "");
  } catch {
    throw new LeadFileError("INVALID_FILE", "The leads file must contain valid UTF-8 text");
  }
}

function csvCandidates(content: string): Candidate[] {
  let rows: string[][];

  try {
    rows = parseCsv(content, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }) as string[][];
  } catch {
    throw new LeadFileError("INVALID_FILE", "The CSV file could not be parsed");
  }

  if (rows.length === 0) {
    return [];
  }

  const firstRow = rows[0];
  if (firstRow === undefined) {
    return [];
  }

  const emailColumn = firstRow.findIndex((value) => value.trim().toLowerCase() === "email");
  const hasHeader = emailColumn >= 0;

  if (!hasHeader && rows.some((row) => row.length !== 1)) {
    throw new LeadFileError("INVALID_FILE", "A multi-column CSV file must contain an email header");
  }

  const columnIndex = hasHeader ? emailColumn : 0;
  const startIndex = hasHeader ? 1 : 0;

  return rows.slice(startIndex).map((row, index) => ({
    row: index + startIndex + 1,
    value: row[columnIndex] ?? "",
  }));
}

function textCandidates(content: string): Candidate[] {
  const candidates: Candidate[] = [];

  for (const [lineIndex, line] of content.split(/\r?\n/u).entries()) {
    for (const value of line.split(",")) {
      if (value.trim().length > 0) {
        candidates.push({ row: lineIndex + 1, value });
      }
    }
  }

  return candidates;
}

export function normalizeEmail(value: string): ParsedLead | null {
  const email = value.trim();
  const containsControlCharacter = [...email].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });

  if (containsControlCharacter || !emailSchema.safeParse(email).success) {
    return null;
  }

  const separator = email.lastIndexOf("@");
  const localPart = email.slice(0, separator);
  const domain = email.slice(separator + 1).toLowerCase();

  return { email: `${localPart}@${domain}`, normalizedEmail: `${localPart}@${domain}` };
}

export function parseLeadFile(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  maxLeads: number,
): LeadParseResult {
  const extension = extname(filename).toLowerCase();
  if (!supportedMimeTypes.has(mimeType) || (extension !== ".csv" && extension !== ".txt")) {
    throw new LeadFileError("UNSUPPORTED_FILE", "Only CSV and text lead files are supported");
  }

  const content = decodeUtf8(buffer);
  const candidates = extension === ".csv" ? csvCandidates(content) : textCandidates(content);

  if (candidates.length > maxLeads) {
    throw new LeadFileError(
      "TOO_MANY_LEADS",
      `The leads file exceeds the configured maximum of ${maxLeads} rows`,
    );
  }

  const leads: ParsedLead[] = [];
  const invalidRows: InvalidLead[] = [];
  const seen = new Set<string>();
  let invalidCount = 0;
  let duplicateCount = 0;

  for (const candidate of candidates) {
    const parsed = normalizeEmail(candidate.value);
    if (parsed === null) {
      invalidCount += 1;
      if (invalidRows.length < invalidDetailLimit) {
        invalidRows.push({
          row: candidate.row,
          value: candidate.value.trim().slice(0, invalidValueLimit),
          reason: "invalid_email",
        });
      }
      continue;
    }

    if (seen.has(parsed.normalizedEmail)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(parsed.normalizedEmail);
    leads.push(parsed);
  }

  return {
    leads,
    totalRows: candidates.length,
    invalidCount,
    duplicateCount,
    invalidRows,
  };
}
