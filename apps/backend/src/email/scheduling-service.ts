import { Prisma, type EmailBatch, type ScheduledEmailStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../db/prisma.js";
import { HttpError } from "../http/http-error.js";
import {
  createBullJobId,
  createRecipientIdempotencyKey,
  createScheduledEmailId,
} from "./identifiers.js";
import type { LeadParseResult } from "./lead-parser.js";

const insertionChunkSize = 250;

export interface CreateBatchInput {
  userId: string;
  senderId: string;
  idempotencyKey: string;
  subject: string;
  bodyText: string;
  startAt: Date;
  hourlyLimit: number;
  minimumDelayMs: number;
  sourceFilename: string;
  parsedLeads: LeadParseResult;
}

export interface CreatedBatchResult {
  batch: EmailBatch;
  replayed: boolean;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function findExistingBatch(
  database: DatabaseClient,
  userId: string,
  idempotencyKey: string,
): Promise<EmailBatch | null> {
  return database.emailBatch.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
  });
}

export async function createEmailBatch(
  database: DatabaseClient,
  input: CreateBatchInput,
): Promise<CreatedBatchResult> {
  const existing = await findExistingBatch(database, input.userId, input.idempotencyKey);
  if (existing !== null) {
    return { batch: existing, replayed: true };
  }

  if (input.parsedLeads.leads.length === 0) {
    throw new HttpError(422, "NO_VALID_RECIPIENTS", "The leads file has no valid recipients", {
      totalRows: input.parsedLeads.totalRows,
      invalidCount: input.parsedLeads.invalidCount,
      duplicateCount: input.parsedLeads.duplicateCount,
      invalidRows: input.parsedLeads.invalidRows,
    });
  }

  try {
    const batch = await database.$transaction(
      async (transaction) => {
        const sender = await transaction.emailSender.findFirst({
          where: { id: input.senderId, userId: input.userId, isActive: true },
        });

        if (sender === null) {
          throw new HttpError(404, "SENDER_NOT_FOUND", "The active sender was not found");
        }

        await transaction.emailSender.update({
          where: { id: sender.id },
          data: {
            hourlyLimit: input.hourlyLimit,
            minimumDelayMs: input.minimumDelayMs,
          },
        });

        const createdBatch = await transaction.emailBatch.create({
          data: {
            id: randomUUID(),
            userId: input.userId,
            senderId: sender.id,
            idempotencyKey: input.idempotencyKey,
            subject: input.subject,
            bodyText: input.bodyText,
            startAt: input.startAt,
            requestedHourlyLimit: input.hourlyLimit,
            requestedMinimumDelayMs: input.minimumDelayMs,
            sourceFilename: input.sourceFilename,
            totalRows: input.parsedLeads.totalRows,
            validRecipientCount: input.parsedLeads.leads.length,
            invalidRecipientCount: input.parsedLeads.invalidCount,
            duplicateRecipientCount: input.parsedLeads.duplicateCount,
            status: "SCHEDULED",
          },
        });

        const emailRows = input.parsedLeads.leads.map((lead, sequenceNumber) => {
          const id = createScheduledEmailId();
          const scheduledAt = new Date(
            input.startAt.getTime() + sequenceNumber * input.minimumDelayMs,
          );

          return {
            id,
            batchId: createdBatch.id,
            senderId: sender.id,
            recipientEmail: lead.email,
            normalizedRecipientEmail: lead.normalizedEmail,
            sequenceNumber,
            scheduledAt,
            nextAttemptAt: scheduledAt,
            bullJobId: createBullJobId(id),
            idempotencyKey: createRecipientIdempotencyKey(createdBatch.id, lead.normalizedEmail),
          };
        });

        for (const chunk of chunks(emailRows, insertionChunkSize)) {
          await transaction.scheduledEmail.createMany({ data: chunk });
        }

        return createdBatch;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return { batch, replayed: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const racedBatch = await findExistingBatch(database, input.userId, input.idempotencyKey);
      if (racedBatch !== null) {
        return { batch: racedBatch, replayed: true };
      }
    }

    throw error;
  }
}

export const scheduledDashboardStatuses: ScheduledEmailStatus[] = [
  "SCHEDULED",
  "RATE_LIMITED",
  "PROCESSING",
  "RETRYABLE",
];

export const sentDashboardStatuses: ScheduledEmailStatus[] = ["SENT", "FAILED", "DELIVERY_UNKNOWN"];
