import { z } from "zod";

import { getApiEnvelopeView, findApiEnvelopeIds } from "@/lib/api/envelope-view";
import {
  apiError,
  apiJson,
  handleApiError,
  requireApiPrincipal,
} from "@/lib/api/route";
import { getDb } from "@/lib/db/connection";
import {
  createDraftEnvelope,
  deleteDraftEnvelope,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "@/lib/envelopes";
import { getClientIpAddress, getRequestUserAgent } from "@/lib/security/request";
import { fieldTypes } from "@/lib/types/domain";

const createBodySchema = z.object({
  copyRecipients: z
    .array(z.object({ email: z.string(), name: z.string() }))
    .optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  externalReference: z.string().trim().min(1).max(200).optional(),
  fields: z
    .array(
      z.object({
        height: z.number().gt(0).max(1),
        label: z.string().max(120).optional(),
        page: z.number().int().positive(),
        required: z.boolean().optional(),
        signerEmail: z.string(),
        type: z.enum(fieldTypes),
        width: z.number().gt(0).max(1),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      }),
    )
    .optional(),
  filename: z.string().trim().min(1).max(200).optional(),
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  pdfBase64: z.string().min(1),
  reminderIntervalDays: z.number().int().min(1).max(30).optional(),
  send: z.boolean().default(true),
  signatureLevel: z.enum(["simple", "advanced", "qualified"]).optional(),
  signers: z
    .array(
      z.object({
        email: z.string(),
        name: z.string(),
        signOrder: z.number().int().positive().optional(),
      }),
    )
    .min(1),
  title: z.string().trim().min(1).max(200),
});

const FIELDS_PER_COLUMN = 4;

// Used when the caller sends no fields: one signature box per signer on the
// last page, stacked in columns so they never overlap.
function defaultSignatureFields(signerIds: string[], page: number) {
  return signerIds.map((signerId, index) => {
    const row = index % FIELDS_PER_COLUMN;
    const column = Math.floor(index / FIELDS_PER_COLUMN);

    return {
      height: 0.06,
      page,
      required: true,
      signerId,
      type: "signature" as const,
      width: 0.28,
      x: 0.05 + column * 0.31,
      y: 0.55 + row * 0.1,
    };
  });
}

export async function POST(request: Request) {
  const principal = await requireApiPrincipal(request);

  if (principal instanceof Response) {
    return principal;
  }

  const userId = principal.user.id;
  let envelopeId: string | null = null;

  try {
    const parsed = createBodySchema.safeParse(
      await request.json().catch(() => null),
    );

    if (!parsed.success) {
      return handleApiError(parsed.error, request, principal);
    }

    const body = parsed.data;
    const pdf = Buffer.from(body.pdfBase64, "base64");

    if (pdf.length === 0 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      return apiError(400, "invalid_pdf", "pdfBase64 must be a base64 PDF.");
    }

    const draft = await createDraftEnvelope(userId, {
      sourcePdf: {
        body: new Uint8Array(pdf),
        contentType: "application/pdf",
        filename: body.filename ?? `${body.title}.pdf`,
      },
      title: body.title,
    });

    envelopeId = draft.envelope.id;

    await getDb().query(
      `INSERT INTO api_envelopes (envelope_id, api_key_id, external_reference, metadata)
       VALUES ($1, $2, $3, $4)`,
      [
        envelopeId,
        principal.keyId,
        body.externalReference ?? null,
        JSON.stringify(body.metadata ?? {}),
      ],
    );

    const savedSigners = await replaceDraftEnvelopeSigners(userId, envelopeId, {
      copyRecipients: body.copyRecipients,
      signers: body.signers,
    });
    const signerIdByEmail = new Map(
      savedSigners.signers.map((signer) => [signer.email.toLowerCase(), signer.id]),
    );
    const lastPage = draft.envelope.pageCount;
    let fields;

    if (body.fields && body.fields.length > 0) {
      fields = body.fields.map((field) => {
        const signerId = signerIdByEmail.get(field.signerEmail.toLowerCase());

        if (!signerId) {
          throw new RangeError(
            `fields: ${field.signerEmail} is not one of the signers.`,
          );
        }

        if (field.page > lastPage) {
          throw new RangeError(
            `fields: page ${String(field.page)} is past the last page (${String(lastPage)}).`,
          );
        }

        const rest = { ...field, signerEmail: undefined };

        return { ...rest, required: field.required ?? true, signerId };
      });
    } else {
      fields = defaultSignatureFields(
        savedSigners.signers.map((signer) => signer.id),
        lastPage,
      );
    }

    await replaceDraftEnvelopeFields(userId, envelopeId, { fields });

    if (body.send) {
      await sendDraftEnvelope(
        userId,
        envelopeId,
        {
          expiresInDays: body.expiresInDays,
          ipAddress: getClientIpAddress(request.headers),
          reminderIntervalDays: body.reminderIntervalDays,
          senderEmail: principal.user.email,
          senderName: principal.user.name.trim() || principal.user.email,
          signatureLevel: body.signatureLevel,
          userAgent: getRequestUserAgent(request.headers),
        },
        { database: getDb() },
      );
    }

    return apiJson(await getApiEnvelopeView(userId, envelopeId), 201);
  } catch (error) {
    if (envelopeId) {
      await deleteDraftEnvelope(userId, envelopeId).catch(() => undefined);
    }

    if (error instanceof RangeError) {
      return apiError(400, "invalid_request", error.message);
    }

    return handleApiError(error, request, principal);
  }
}

export async function GET(request: Request) {
  const principal = await requireApiPrincipal(request);

  if (principal instanceof Response) {
    return principal;
  }

  const reference = new URL(request.url).searchParams.get("externalReference");

  if (!reference) {
    return apiError(
      400,
      "invalid_request",
      "Pass ?externalReference= to look up envelopes.",
    );
  }

  try {
    const ids = await findApiEnvelopeIds(principal.user.id, reference);
    const envelopes = await Promise.all(
      ids.map((id) => getApiEnvelopeView(principal.user.id, id)),
    );

    return apiJson({ envelopes: envelopes.filter(Boolean) });
  } catch (error) {
    return handleApiError(error, request, principal);
  }
}
