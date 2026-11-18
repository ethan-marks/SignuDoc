import { getApiEnvelopeView } from "@/lib/api/envelope-view";
import {
  apiError,
  apiJson,
  handleApiError,
  requireApiPrincipal,
} from "@/lib/api/route";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const principal = await requireApiPrincipal(request);

  if (principal instanceof Response) {
    return principal;
  }

  try {
    const { id } = await context.params;
    const envelope = await getApiEnvelopeView(principal.user.id, id);

    return envelope
      ? apiJson(envelope)
      : apiError(404, "not_found", "Envelope not found.");
  } catch (error) {
    return handleApiError(error, request, principal);
  }
}
