import {
  apiError,
  handleApiError,
  requireApiPrincipal,
} from "@/lib/api/route";
import { createDownloadResponse } from "@/lib/download-response";
import { getSenderEnvelopeDownload } from "@/lib/downloads";
import { getApiEnvelopeView } from "@/lib/api/envelope-view";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const principal = await requireApiPrincipal(request);

  if (principal instanceof Response) {
    return principal;
  }

  try {
    const { id } = await context.params;
    const envelope = await getApiEnvelopeView(principal.user.id, id);

    if (!envelope) {
      return apiError(404, "not_found", "Envelope not found.");
    }

    return await createDownloadResponse(
      await getSenderEnvelopeDownload(principal.user.id, id, "evidence"),
    );
  } catch (error) {
    return handleApiError(error, request, principal);
  }
}
