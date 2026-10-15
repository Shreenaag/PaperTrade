import { createHash, randomBytes } from "node:crypto";
import type { Env } from "../../config/env.js";

// OAuth 2.0 authorization-code flow with PKCE, used for identity only: the provider's access token
// is used once to read the profile and then dropped (never stored).

export type ProviderName = "google" | "github";

export interface OAuthIdentity {
  provider: ProviderName;
  providerAccountId: string;
  email: string; // verified by the provider, lower-cased
  displayName: string;
  avatarUrl: string | null;
}

export interface OAuthProvider {
  authorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string;
  fetchIdentity(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthIdentity>;
}

export type OAuthProviders = Partial<Record<ProviderName, OAuthProvider>>;

export function pkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  return { codeVerifier, codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url") };
}

async function getJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

function google(clientId: string, clientSecret: string): OAuthProvider {
  return {
    authorizeUrl: ({ state, codeChallenge, redirectUri }) =>
      `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      })}`,

    async fetchIdentity({ code, codeVerifier, redirectUri }) {
      const token = await getJson<{ access_token: string }>("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: codeVerifier,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      });
      const u = await getJson<{ sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }>(
        "https://openidconnect.googleapis.com/v1/userinfo",
        { headers: { authorization: `Bearer ${token.access_token}` } },
      );
      if (!u.email || !u.email_verified) throw new Error("google account has no verified email");
      return {
        provider: "google",
        providerAccountId: u.sub,
        email: u.email.toLowerCase(),
        displayName: u.name ?? u.email,
        avatarUrl: u.picture ?? null,
      };
    },
  };
}

function github(clientId: string, clientSecret: string): OAuthProvider {
  const api = { accept: "application/vnd.github+json", "user-agent": "papertrade" };
  return {
    authorizeUrl: ({ state, codeChallenge, redirectUri }) =>
      `https://github.com/login/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "read:user user:email",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        allow_signup: "true",
      })}`,

    async fetchIdentity({ code, codeVerifier, redirectUri }) {
      const token = await getJson<{ access_token?: string; error?: string }>("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        }),
      });
      if (!token.access_token) throw new Error(`github token exchange failed: ${token.error}`); // GitHub errors with 200
      const headers = { ...api, authorization: `Bearer ${token.access_token}` };
      const [u, emails] = await Promise.all([
        getJson<{ id: number; login: string; name: string | null; avatar_url: string | null }>("https://api.github.com/user", { headers }),
        getJson<{ email: string; primary: boolean; verified: boolean }[]>("https://api.github.com/user/emails", { headers }),
      ]);
      const email = emails.find((e) => e.primary && e.verified)?.email;
      if (!email) throw new Error("github account has no verified primary email");
      return {
        provider: "github",
        providerAccountId: String(u.id),
        email: email.toLowerCase(),
        displayName: u.name ?? u.login,
        avatarUrl: u.avatar_url,
      };
    },
  };
}

// Only providers with credentials in the env are enabled; others answer 404.
export function createProviders(env: Env): OAuthProviders {
  return {
    ...(env.GOOGLE_CLIENT_ID && { google: google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET!) }),
    ...(env.GITHUB_CLIENT_ID && { github: github(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET!) }),
  };
}
