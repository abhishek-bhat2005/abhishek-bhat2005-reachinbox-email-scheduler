import type { User } from "@prisma/client";

import type { AppConfig } from "../config/env.js";
import type { DatabaseClient } from "../db/prisma.js";
import type { GoogleIdentity } from "./google-profile.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

type SenderDefaults = Pick<AppConfig, "DEFAULT_EMAILS_PER_HOUR" | "DEFAULT_MIN_SEND_DELAY_MS">;

function toAuthenticatedUser(user: User): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };
}

export async function upsertGoogleUser(
  database: DatabaseClient,
  identity: GoogleIdentity,
  senderDefaults: SenderDefaults,
): Promise<AuthenticatedUser> {
  const user = await database.$transaction(async (transaction) => {
    const savedUser = await transaction.user.upsert({
      where: { googleSubject: identity.googleSubject },
      create: {
        googleSubject: identity.googleSubject,
        email: identity.email,
        name: identity.name,
        avatarUrl: identity.avatarUrl,
        lastLoginAt: new Date(),
      },
      update: {
        email: identity.email,
        name: identity.name,
        avatarUrl: identity.avatarUrl,
        lastLoginAt: new Date(),
      },
    });

    await transaction.emailSender.upsert({
      where: {
        userId_normalizedEmail: {
          userId: savedUser.id,
          normalizedEmail: identity.email,
        },
      },
      create: {
        userId: savedUser.id,
        displayName: identity.name,
        email: identity.email,
        normalizedEmail: identity.email,
        isDefault: true,
        hourlyLimit: senderDefaults.DEFAULT_EMAILS_PER_HOUR,
        minimumDelayMs: senderDefaults.DEFAULT_MIN_SEND_DELAY_MS,
      },
      update: {
        displayName: identity.name,
        email: identity.email,
      },
    });

    return savedUser;
  });

  return toAuthenticatedUser(user);
}

export async function findAuthenticatedUser(
  database: DatabaseClient,
  userId: string,
): Promise<AuthenticatedUser | null> {
  const user = await database.user.findUnique({ where: { id: userId } });
  return user === null ? null : toAuthenticatedUser(user);
}
