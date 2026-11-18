export class WebhookUrlError extends Error {}

// Webhooks go out from the server, so a URL that points inside it must be
// refused. This checks the host as written; it does not resolve DNS.
export function assertSafeWebhookUrl(rawUrl: string): URL {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookUrlError("The webhook URL is not a valid URL.");
  }

  const allowInsecure = process.env.SIGNUDOC_ALLOW_INSECURE_WEBHOOKS === "1";

  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    throw new WebhookUrlError("The webhook URL must use https.");
  }

  const host = url.hostname.toLowerCase();
  const privateHost =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host === "::1" ||
    host.startsWith("[") ||
    /^(0|10|127)\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (privateHost && !allowInsecure) {
    throw new WebhookUrlError("The webhook URL must be a public address.");
  }

  return url;
}
