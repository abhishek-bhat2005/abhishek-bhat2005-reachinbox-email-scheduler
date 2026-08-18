import type { Profile } from "passport-google-oauth20";
import { describe, expect, it } from "vitest";

import { normalizeGoogleProfile } from "../../src/auth/google-profile.js";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    provider: "google",
    id: "google-subject",
    profileUrl: "https://profiles.example.test/google-subject",
    displayName: "Test User",
    name: { familyName: "User", givenName: "Test" },
    emails: [{ value: "USER@Example.com", verified: true }],
    photos: [{ value: "https://images.example.test/avatar.png" }],
    _raw: "{}",
    _json: {
      iss: "https://accounts.google.com",
      aud: "test-client",
      sub: "google-subject",
      iat: 1,
      exp: 2,
    },
    ...overrides,
  };
}

describe("Google profile normalization", () => {
  it("keeps the stable subject and normalizes the verified email", () => {
    expect(normalizeGoogleProfile(profile())).toEqual({
      googleSubject: "google-subject",
      email: "user@example.com",
      name: "Test User",
      avatarUrl: "https://images.example.test/avatar.png",
    });
  });

  it("rejects a profile without a verified email", () => {
    expect(() =>
      normalizeGoogleProfile(profile({ emails: [{ value: "user@example.com", verified: false }] })),
    ).toThrow("Google did not provide a verified identity and email");
  });
});
