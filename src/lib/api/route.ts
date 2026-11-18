import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { DownloadAccessError } from "../downloads.ts";
import { EnvelopeMutationError } from "../envelopes.ts";
import { logRouteError } from "../security/logging.ts";
import { consumeRateLimit } from "../security/rate-limit.ts";
import { getClientIpAddress, getRequestPathname } from "../security/request.ts";
import { authenticateApiRequest, type ApiPrincipal } from "./keys.ts";

export function apiError(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message } },
    { headers: { "cache-control": "private, no-store" }, status },
  );
}

export function apiJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    headers: { "cache-control": "private, no-store" },
    status,
  });
}

export async function requireApiPrincipal(
  request: Request,
): Promise<ApiPrincipal | NextResponse> {
  const principal = await authenticateApiRequest(request);

  if (!principal) {
    return apiError(
      401,
      "unauthorized",
      "Send a valid API key as 'Authorization: Bearer sud_...'.",
    );
  }

  const decision = await consumeRateLimit({
    key: `api:${principal.keyId}`,
    limit: 120,
    windowMs: 60_000,
  });

  if (!decision.allowed) {
    const response = apiError(429, "rate_limited", "Too many requests.");

    response.headers.set("retry-after", String(decision.retryAfterSeconds));

    return response;
  }

  return principal;
}

export function handleApiError(
  error: unknown,
  request: Request,
  principal: ApiPrincipal,
) {
  if (error instanceof ZodError) {
    return apiError(
      400,
      "invalid_request",
      error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; "),
    );
  }

  if (
    error instanceof EnvelopeMutationError ||
    error instanceof DownloadAccessError
  ) {
    return apiError(
      error.statusCode,
      error.statusCode === 404 ? "not_found" : "request_failed",
      error.message,
    );
  }

  logRouteError(error, {
    category: "public_api_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure in the public API.",
    path: getRequestPathname(request),
    userId: principal.user.id,
  });

  return apiError(500, "internal_error", "Something went wrong.");
}
