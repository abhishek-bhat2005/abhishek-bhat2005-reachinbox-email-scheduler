import { Prisma, type EmailBatch } from "@prisma/client";
import { basename } from "node:path";

import { Router, type Request } from "express";
import multer from "multer";
import { z } from "zod";

import { requireAuth } from "../auth/require-auth.js";
import type { AppConfig } from "../config/env.js";
import type { DatabaseClient } from "../db/prisma.js";
import { asyncHandler } from "../http/async-handler.js";
import { HttpError } from "../http/http-error.js";
import { LeadFileError, normalizeEmail, parseLeadFile } from "./lead-parser.js";
import {
  createEmailBatch,
  scheduledDashboardStatuses,
  sentDashboardStatuses,
} from "./scheduling-service.js";

type EmailApiConfig = Pick<
  AppConfig,
  | "API_MAX_PAGE_SIZE"
  | "API_PAGE_SIZE"
  | "DEFAULT_EMAILS_PER_HOUR"
  | "DEFAULT_MIN_SEND_DELAY_MS"
  | "MAX_BODY_LENGTH"
  | "MAX_EMAILS_PER_HOUR"
  | "MAX_LEADS_PER_BATCH"
  | "MAX_SCHEDULE_HORIZON_DAYS"
  | "MAX_SEND_DELAY_MS"
  | "MAX_SUBJECT_LENGTH"
  | "MAX_UPLOAD_BYTES"
  | "MIN_SEND_DELAY_MS"
>;

export interface EmailRouterDependencies {
  config: EmailApiConfig;
  database: DatabaseClient;
}

const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(255)
  .regex(/^[A-Za-z0-9._~-]+$/u, "contains unsupported characters");
const senderIdSchema = z.uuid();
const cursorSchema = z.object({ sortAt: z.iso.datetime(), id: z.uuid() });

function parseOrThrow<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, "VALIDATION_ERROR", "The request data is invalid", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  return result.data;
}

function authenticatedUser(request: Request): Express.User {
  if (request.user === undefined) {
    throw new HttpError(401, "AUTHENTICATION_REQUIRED", "Authentication is required");
  }
  return request.user;
}

function parseFileOrThrow(file: Express.Multer.File | undefined, config: EmailApiConfig) {
  if (file === undefined) {
    throw new HttpError(400, "LEADS_FILE_REQUIRED", "A leadsFile upload is required");
  }

  try {
    return parseLeadFile(file.buffer, file.originalname, file.mimetype, config.MAX_LEADS_PER_BATCH);
  } catch (error) {
    if (error instanceof LeadFileError) {
      const status = error.code === "TOO_MANY_LEADS" ? 413 : 422;
      throw new HttpError(status, error.code, error.message);
    }
    throw error;
  }
}

function encodeCursor(sortAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ sortAt: sortAt.toISOString(), id })).toString("base64url");
}

function decodeCursor(value: string | undefined): { sortAt: Date; id: string } | null {
  if (value === undefined) {
    return null;
  }

  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return { sortAt: new Date(parsed.sortAt), id: parsed.id };
  } catch {
    throw new HttpError(400, "INVALID_CURSOR", "The pagination cursor is invalid");
  }
}

function senderResponse(sender: {
  id: string;
  displayName: string;
  email: string;
  isDefault: boolean;
  isActive: boolean;
  hourlyLimit: number;
  minimumDelayMs: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: sender.id,
    displayName: sender.displayName,
    email: sender.email,
    isDefault: sender.isDefault,
    isActive: sender.isActive,
    hourlyLimit: sender.hourlyLimit,
    minimumDelayMs: sender.minimumDelayMs,
    createdAt: sender.createdAt.toISOString(),
    updatedAt: sender.updatedAt.toISOString(),
  };
}

function batchCreationResponse(
  batch: EmailBatch,
  replayed: boolean,
  invalidRows: ReturnType<typeof parseLeadFile>["invalidRows"],
) {
  return {
    replayed,
    batch: {
      id: batch.id,
      status: batch.status.toLowerCase(),
      startAt: batch.startAt.toISOString(),
      totalRows: batch.totalRows,
      validRecipientCount: batch.validRecipientCount,
      invalidRecipientCount: batch.invalidRecipientCount,
      duplicateRecipientCount: batch.duplicateRecipientCount,
      invalidRows,
    },
  };
}

export function createEmailRouter(dependencies: EmailRouterDependencies): Router {
  const { config, database } = dependencies;
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 },
  });
  const policyFields = {
    hourlyLimit: z.coerce.number().int().min(1).max(config.MAX_EMAILS_PER_HOUR),
    minimumDelayMs: z.coerce
      .number()
      .int()
      .min(config.MIN_SEND_DELAY_MS)
      .max(config.MAX_SEND_DELAY_MS),
  };
  const createSenderSchema = z
    .object({
      displayName: z.string().trim().min(1).max(200),
      email: z.email().max(320),
      isDefault: z.boolean().optional().default(false),
      ...policyFields,
    })
    .strict();
  const updateSenderSchema = z
    .object({
      displayName: z.string().trim().min(1).max(200).optional(),
      email: z.email().max(320).optional(),
      isDefault: z.boolean().optional(),
      isActive: z.boolean().optional(),
      hourlyLimit: policyFields.hourlyLimit.optional(),
      minimumDelayMs: policyFields.minimumDelayMs.optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, "At least one field is required");
  const scheduleSchema = z
    .object({
      senderId: senderIdSchema,
      subject: z.string().trim().min(1).max(config.MAX_SUBJECT_LENGTH),
      body: z.string().min(1).max(config.MAX_BODY_LENGTH),
      startAt: z.coerce.date(),
      ...policyFields,
    })
    .strict();
  const listQuerySchema = z.object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(config.API_MAX_PAGE_SIZE)
      .default(config.API_PAGE_SIZE),
    senderId: senderIdSchema.optional(),
  });

  router.use(requireAuth);

  router.get("/config/compose", (_request, response) => {
    response.status(200).json({
      defaults: {
        hourlyLimit: config.DEFAULT_EMAILS_PER_HOUR,
        minimumDelayMs: config.DEFAULT_MIN_SEND_DELAY_MS,
        pageSize: config.API_PAGE_SIZE,
      },
      limits: {
        hourlyLimit: { min: 1, max: config.MAX_EMAILS_PER_HOUR },
        minimumDelayMs: { min: config.MIN_SEND_DELAY_MS, max: config.MAX_SEND_DELAY_MS },
        maxBodyLength: config.MAX_BODY_LENGTH,
        maxLeadsPerBatch: config.MAX_LEADS_PER_BATCH,
        maxScheduleHorizonDays: config.MAX_SCHEDULE_HORIZON_DAYS,
        maxSubjectLength: config.MAX_SUBJECT_LENGTH,
        maxUploadBytes: config.MAX_UPLOAD_BYTES,
      },
    });
  });

  router.get(
    "/senders",
    asyncHandler(async (request, response) => {
      const user = authenticatedUser(request);
      const senders = await database.emailSender.findMany({
        where: { userId: user.id },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      });
      response.status(200).json({ senders: senders.map(senderResponse) });
    }),
  );

  router.post(
    "/senders",
    asyncHandler(async (request, response) => {
      const user = authenticatedUser(request);
      const input = parseOrThrow(createSenderSchema, request.body);
      const normalized = normalizeEmail(input.email);
      if (normalized === null) {
        throw new HttpError(400, "VALIDATION_ERROR", "The sender email is invalid");
      }

      try {
        const sender = await database.$transaction(async (transaction) => {
          if (input.isDefault) {
            await transaction.emailSender.updateMany({
              where: { userId: user.id },
              data: { isDefault: false },
            });
          }

          return transaction.emailSender.create({
            data: {
              userId: user.id,
              displayName: input.displayName,
              email: normalized.email,
              normalizedEmail: normalized.normalizedEmail,
              isDefault: input.isDefault,
              hourlyLimit: input.hourlyLimit,
              minimumDelayMs: input.minimumDelayMs,
            },
          });
        });

        response.status(201).json({ sender: senderResponse(sender) });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new HttpError(409, "SENDER_ALREADY_EXISTS", "That sender already exists");
        }
        throw error;
      }
    }),
  );

  router.patch(
    "/senders/:senderId",
    asyncHandler(async (request, response) => {
      const user = authenticatedUser(request);
      const senderId = parseOrThrow(senderIdSchema, request.params.senderId);
      const input = parseOrThrow(updateSenderSchema, request.body);

      try {
        const sender = await database.$transaction(async (transaction) => {
          const current = await transaction.emailSender.findFirst({
            where: { id: senderId, userId: user.id },
          });
          if (current === null) {
            throw new HttpError(404, "SENDER_NOT_FOUND", "The sender was not found");
          }
          if (current.isDefault && input.isActive === false) {
            throw new HttpError(
              409,
              "DEFAULT_SENDER_REQUIRED",
              "Choose another default sender before deactivating this sender",
            );
          }
          if (current.isDefault && input.isDefault === false) {
            throw new HttpError(
              409,
              "DEFAULT_SENDER_REQUIRED",
              "Choose another default sender before removing this default",
            );
          }
          if (input.isDefault === true && input.isActive === false) {
            throw new HttpError(400, "VALIDATION_ERROR", "An inactive sender cannot be default");
          }

          const data: Prisma.EmailSenderUncheckedUpdateInput = {};
          if (input.displayName !== undefined) data.displayName = input.displayName;
          if (input.isActive !== undefined) data.isActive = input.isActive;
          if (input.hourlyLimit !== undefined) data.hourlyLimit = input.hourlyLimit;
          if (input.minimumDelayMs !== undefined) data.minimumDelayMs = input.minimumDelayMs;
          if (input.isDefault !== undefined) data.isDefault = input.isDefault;
          if (input.email !== undefined) {
            const normalized = normalizeEmail(input.email);
            if (normalized === null) {
              throw new HttpError(400, "VALIDATION_ERROR", "The sender email is invalid");
            }
            data.email = normalized.email;
            data.normalizedEmail = normalized.normalizedEmail;
          }

          if (input.isDefault === true) {
            await transaction.emailSender.updateMany({
              where: { userId: user.id, id: { not: senderId } },
              data: { isDefault: false },
            });
            data.isActive = true;
          }

          return transaction.emailSender.update({ where: { id: senderId }, data });
        });

        response.status(200).json({ sender: senderResponse(sender) });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new HttpError(409, "SENDER_ALREADY_EXISTS", "That sender already exists");
        }
        throw error;
      }
    }),
  );

  router.post(
    "/email-batches",
    upload.single("leadsFile"),
    asyncHandler(async (request, response) => {
      const user = authenticatedUser(request);
      const idempotencyKey = parseOrThrow(idempotencyKeySchema, request.get("Idempotency-Key"));
      const existingBatch = await database.emailBatch.findUnique({
        where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } },
      });
      if (existingBatch !== null) {
        response.status(200).json(batchCreationResponse(existingBatch, true, []));
        return;
      }

      const input = parseOrThrow(scheduleSchema, request.body);
      const now = new Date();
      const horizon = new Date(
        now.getTime() + config.MAX_SCHEDULE_HORIZON_DAYS * 24 * 60 * 60 * 1000,
      );
      if (input.startAt < now || input.startAt > horizon) {
        throw new HttpError(
          422,
          "INVALID_START_TIME",
          "The start time must be in the future and within the configured schedule horizon",
        );
      }

      const parsedLeads = parseFileOrThrow(request.file, config);
      const lastScheduledAt = new Date(
        input.startAt.getTime() + Math.max(0, parsedLeads.leads.length - 1) * input.minimumDelayMs,
      );
      if (lastScheduledAt > horizon) {
        throw new HttpError(
          422,
          "SCHEDULE_EXCEEDS_HORIZON",
          "The staggered batch extends beyond the configured schedule horizon",
        );
      }

      const result = await createEmailBatch(database, {
        userId: user.id,
        senderId: input.senderId,
        idempotencyKey,
        subject: input.subject,
        bodyText: input.body,
        startAt: input.startAt,
        hourlyLimit: input.hourlyLimit,
        minimumDelayMs: input.minimumDelayMs,
        sourceFilename: basename(request.file?.originalname ?? "leads.txt"),
        parsedLeads,
      });

      response
        .status(result.replayed ? 200 : 201)
        .json(
          batchCreationResponse(
            result.batch,
            result.replayed,
            result.replayed ? [] : parsedLeads.invalidRows,
          ),
        );
    }),
  );

  router.get(
    "/email-batches/:batchId",
    asyncHandler(async (request, response) => {
      const user = authenticatedUser(request);
      const batchId = parseOrThrow(z.uuid(), request.params.batchId);
      const batch = await database.emailBatch.findFirst({
        where: { id: batchId, userId: user.id },
        include: {
          sender: { select: { id: true, displayName: true, email: true } },
        },
      });
      if (batch === null) {
        throw new HttpError(404, "BATCH_NOT_FOUND", "The email batch was not found");
      }

      const statusCounts = await database.scheduledEmail.groupBy({
        by: ["status"],
        where: { batchId: batch.id },
        _count: { _all: true },
      });

      response.status(200).json({
        batch: {
          id: batch.id,
          status: batch.status.toLowerCase(),
          subject: batch.subject,
          startAt: batch.startAt.toISOString(),
          counts: {
            totalRows: batch.totalRows,
            valid: batch.validRecipientCount,
            invalid: batch.invalidRecipientCount,
            duplicate: batch.duplicateRecipientCount,
            byStatus: Object.fromEntries(
              statusCounts.map((entry) => [entry.status.toLowerCase(), entry._count._all]),
            ),
          },
          sender: batch.sender,
          createdAt: batch.createdAt.toISOString(),
        },
      });
    }),
  );

  router.get(
    "/emails/scheduled",
    asyncHandler(async (request, response) => {
      const user = authenticatedUser(request);
      const query = parseOrThrow(listQuerySchema, request.query);
      const cursor = decodeCursor(query.cursor);
      const rows = await database.scheduledEmail.findMany({
        where: {
          batch: { userId: user.id },
          status: { in: scheduledDashboardStatuses },
          ...(query.senderId === undefined ? {} : { senderId: query.senderId }),
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { nextAttemptAt: { gt: cursor.sortAt } },
                  { nextAttemptAt: cursor.sortAt, id: { gt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
        take: query.limit + 1,
        include: {
          batch: { select: { subject: true } },
          sender: { select: { displayName: true, email: true } },
        },
      });
      const hasMore = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);

      response.status(200).json({
        items: page.map((row) => ({
          id: row.id,
          recipientEmail: row.recipientEmail,
          subject: row.batch.subject,
          scheduledAt: row.scheduledAt.toISOString(),
          nextAttemptAt: row.nextAttemptAt.toISOString(),
          status: row.status.toLowerCase(),
          sender: row.sender,
        })),
        nextCursor:
          hasMore && last !== undefined ? encodeCursor(last.nextAttemptAt, last.id) : null,
      });
    }),
  );

  router.get(
    "/emails/sent",
    asyncHandler(async (request, response) => {
      const user = authenticatedUser(request);
      const query = parseOrThrow(listQuerySchema, request.query);
      const cursor = decodeCursor(query.cursor);
      const rows = await database.scheduledEmail.findMany({
        where: {
          batch: { userId: user.id },
          status: { in: sentDashboardStatuses },
          ...(query.senderId === undefined ? {} : { senderId: query.senderId }),
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { updatedAt: { lt: cursor.sortAt } },
                  { updatedAt: cursor.sortAt, id: { lt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        include: {
          batch: { select: { subject: true } },
          sender: { select: { displayName: true, email: true } },
        },
      });
      const hasMore = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);

      response.status(200).json({
        items: page.map((row) => ({
          id: row.id,
          recipientEmail: row.recipientEmail,
          subject: row.batch.subject,
          sentAt: row.sentAt?.toISOString() ?? null,
          completedAt: row.updatedAt.toISOString(),
          status: row.status.toLowerCase(),
          etherealPreviewUrl: row.etherealPreviewUrl,
          error: row.lastErrorMessage,
          sender: row.sender,
        })),
        nextCursor: hasMore && last !== undefined ? encodeCursor(last.updatedAt, last.id) : null,
      });
    }),
  );

  return router;
}
