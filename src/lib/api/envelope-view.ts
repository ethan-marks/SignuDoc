import { getDb } from "../db/connection.ts";

export type ApiEnvelopeView = {
  completedAt: number | null;
  declinedAt: number | null;
  expiresAt: number | null;
  externalReference: string | null;
  id: string;
  metadata: Record<string, unknown>;
  sentAt: number | null;
  signers: Array<{
    declineReason: string | null;
    email: string;
    id: string;
    name: string;
    signedAt: number | null;
    signOrder: number;
    status: string;
  }>;
  status: string;
  title: string;
  voidedAt: number | null;
};

export async function getApiEnvelopeView(
  userId: string,
  envelopeId: string,
): Promise<ApiEnvelopeView | null> {
  const db = getDb();
  const envelope = await db.query<Omit<ApiEnvelopeView, "signers">>(
    `SELECT e.id, e.title, e.status, e.sent_at AS "sentAt",
            e.completed_at AS "completedAt", e.declined_at AS "declinedAt",
            e.voided_at AS "voidedAt", e.expires_at AS "expiresAt",
            a.external_reference AS "externalReference",
            COALESCE(a.metadata, '{}'::jsonb) AS metadata
     FROM envelopes e LEFT JOIN api_envelopes a ON a.envelope_id = e.id
     WHERE e.id = $1 AND e.user_id = $2`,
    [envelopeId, userId],
  );
  const row = envelope.rows[0];

  if (!row) {
    return null;
  }

  const signers = await db.query<ApiEnvelopeView["signers"][number]>(
    `SELECT id, name, email, sign_order AS "signOrder", status,
            signed_at AS "signedAt", decline_reason AS "declineReason"
     FROM signers WHERE envelope_id = $1 ORDER BY sign_order`,
    [envelopeId],
  );

  return { ...row, signers: signers.rows };
}

export async function findApiEnvelopeIds(
  userId: string,
  externalReference: string,
): Promise<string[]> {
  const result = await getDb().query<{ id: string }>(
    `SELECT e.id FROM envelopes e
     JOIN api_envelopes a ON a.envelope_id = e.id
     WHERE e.user_id = $1 AND a.external_reference = $2
     ORDER BY e.created_at DESC LIMIT 20`,
    [userId, externalReference],
  );

  return result.rows.map((row) => row.id);
}
