import type { Request } from "express";

/** Reverse-proxy SSO headers recognised, in order -- first non-empty wins.
 * Port of the original's `_SSO_HEADERS` trust model: no real login, just
 * trust whatever identity a fronting reverse proxy already verified
 * (Azure App Service Easy Auth, IIS Windows Auth, oauth2-proxy, etc). */
const SSO_HEADERS = [
  "x-ms-client-principal-name",
  "x-auth-request-email",
  "x-forwarded-user",
  "x-auth-username",
  "remote-user",
];

export function currentUser(req: Request): string {
  for (const h of SSO_HEADERS) {
    const v = req.headers[h];
    const value = Array.isArray(v) ? v[0] : v;
    if (value) return value;
  }
  return "";
}
