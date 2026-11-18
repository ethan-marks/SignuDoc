import { apiJson, handleApiError, requireApiPrincipal } from "@/lib/api/route";
import { getApiEnvelopeView } from "@/lib/api/envelope-view";
import { getDb } from "@/lib/db/connection";
import { voidSentEnvelope } from "@/lib/envelopes";
import { getClientIpAddress, getRequestUserAgent } from "@/lib/security/request";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const principal = await requireApiPrincipal(request);

  if (principal instanceof Response) {
    return principal;
  }

  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as {
      reason?: unknown;
    } | null;

    await voidSentEnvelope(
      principal.user.id,
      id,
      {
        ipAddress: getClientIpAddress(request.headers),
        reason: typeof body?.reason === "string" ? body.reason : null,
        senderEmail: principal.user.email,
        senderName: principal.user.name.trim() || principal.user.email,
        userAgent: getRequestUserAgent(request.headers),
      },
      { database: getDb() },
    );

    return apiJson(await getApiEnvelopeView(principal.user.id, id));
  } catch (error) {
    return handleApiError(error, request, principal);
  }
}
