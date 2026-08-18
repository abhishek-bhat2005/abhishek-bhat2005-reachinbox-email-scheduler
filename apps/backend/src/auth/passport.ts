import passportModule from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";

import type { AppConfig } from "../config/env.js";
import type { DatabaseClient } from "../db/prisma.js";
import { normalizeGoogleProfile } from "./google-profile.js";
import { findAuthenticatedUser, upsertGoogleUser } from "./google-user.js";

type GoogleAuthConfig = Pick<
  AppConfig,
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "GOOGLE_CALLBACK_URL"
  | "DEFAULT_EMAILS_PER_HOUR"
  | "DEFAULT_MIN_SEND_DELAY_MS"
>;

export function createPassport(database: DatabaseClient, config: GoogleAuthConfig) {
  const passport = new passportModule.Passport();

  passport.serializeUser<string>((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser<string>(async (userId, done) => {
    try {
      const user = await findAuthenticatedUser(database, userId);
      done(null, user ?? false);
    } catch (error: unknown) {
      done(error instanceof Error ? error : new Error("Failed to deserialize user"));
    }
  });

  passport.use(
    new GoogleStrategy(
      {
        clientID: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        callbackURL: config.GOOGLE_CALLBACK_URL,
        state: true,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const identity = normalizeGoogleProfile(profile);
          const user = await upsertGoogleUser(database, identity, config);
          done(null, user);
        } catch (error: unknown) {
          done(error instanceof Error ? error : new Error("Google authentication failed"));
        }
      },
    ),
  );

  return passport;
}
