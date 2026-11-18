import { z } from "zod";

import {
  apiError,
  apiJson,
  handleApiError,
  requireApiPrincipal,
} from "@/lib/api/route";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookEndpoints,
  WEBHOOK_EVENTS,
  WebhookUrlError,
} from "@/lib/api/webhooks";

export async function GET(request: Request) {
  const principal = await requireApiPrincipal(request);

  if (principal instanceof Response) {
    return principal;
  }

  try {
    return apiJson({
      endpoints: await listWebhookEndpoints(principal.user.id),
      events: WEBHOOK_EVENTS,
    });
  } catch (error) {
    return handleApiError(error, request, principal);
  }
}

// The signing secret is returned here and never again.
export async function POST(request: Request) {
  const principal = await requireApiPrincipal(request);

  if (principal instanceof Response) {
    return principal;
  }

  try {
    const body = z
      .object({ url: z.string().trim().min(1).max(2000) })
      .parse(await request.json().catch(() => null));

    return apiJson(await createWebhookEndpoint(principal.user.id, body.url), 201);
  } catch (error) {
    if (error instanceof WebhookUrlError) {
      return apiError(400, "invalid_url", error.message);
    }

    return handleApiError(error, request, principal);
  }
}

export async function DELETE(request: Request) {
  const principal = await requireApiPrincipal(request);

  if (principal instanceof Response) {
    return principal;
  }

  const id = new URL(request.url).searchParams.get("id");

  if (!id) {
    return apiError(400, "invalid_request", "Pass ?id= of the endpoint.");
  }

  try {
    return (await deleteWebhookEndpoint(principal.user.id, id))
      ? apiJson({ deleted: true })
      : apiError(404, "not_found", "Webhook endpoint not found.");
  } catch (error) {
    return handleApiError(error, request, principal);
  }
}
