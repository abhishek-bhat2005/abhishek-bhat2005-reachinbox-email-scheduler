import type { Profile } from "passport-google-oauth20";

export interface GoogleIdentity {
  googleSubject: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export function normalizeGoogleProfile(profile: Profile): GoogleIdentity {
  const emailEntry = profile.emails?.find((entry) => entry.verified !== false);
  const email = emailEntry?.value.trim().toLowerCase();

  if (profile.id.trim() === "" || email === undefined || email === "") {
    throw new Error("Google did not provide a verified identity and email");
  }

  const name = profile.displayName.trim() || email.split("@")[0] || email;
  const avatarUrl = profile.photos?.[0]?.value ?? null;

  return {
    googleSubject: profile.id,
    email,
    name,
    avatarUrl,
  };
}
