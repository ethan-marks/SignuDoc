import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { after } from "next/server";

import { getDb } from "../db/connection.ts";
import { assertSafeWebhookUrl, WebhookUrlError } from "./webhook-url.ts";

export { assertSafeWebhookUrl, WebhookUrlError };

export type WebhookEvent =
  | "envelope.completed"
  | "envelope.declined"
  | "envelope.voided";

export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  "envelope.completed",
  "envelope.declined",
  "envelope.voided",
];

const MAX_ATTEMPTS = 6;
const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 43200];
const REQUEST_TIMEOUT_MS = 8000;

export type WebhookEndpointRecord = {
  active: boolean;
  createdAt: number;
  id: string;
  url: string;
};

export async function createWebhookEndpoint(
  userId: string,
  rawUrl: string,
): Promise<WebhookEndpointRecord & { secret: string }> {
  const url = assertSafeWebhookUrl(rawUrl).toString();
  const id = randomUUID();
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const result = await getDb().query<{ createdAt: number }>(
    `INSERT INTO webhook_endpoints (id, user_id, url, secret)
     VALUES ($1, $2, $3, $4) RETURNING created_at AS "createdAt"`,
    [id, userId, url, secret],
  );

  return {
    active: true,
    createdAt: result.rows[0]?.createdAt ?? 0,
    id,
    secret,
    url,
  };
}

export async function listWebhookEndpoints(
  userId: string,
): Promise<WebhookEndpointRecord[]> {
  const result = await getDb().query<WebhookEndpointRecord>(
    `SELECT id, url, active, created_at AS "createdAt"
     FROM webhook_endpoints WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );

  return result.rows;
}

export async function deleteWebhookEndpoint(
  userId: string,
  endpointId: string,
): Promise<boolean> {
  const result = await getDb().query(
    `DELETE FROM webhook_endpoints WHERE id = $1 AND user_id = $2`,
    [endpointId, userId],
  );

  return result.rowCount === 1;
}

export function signWebhookBody(
  secret: string,
  timestamp: number,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${String(timestamp)}.${body}`)
    .digest("hex");
}

export async function buildEnvelopePayload(
  envelopeId: string,
  event: WebhookEvent,
) {
  const db = getDb();
  const envelope = await db.query<{
    completedAt: number | null;
    declinedAt: number | null;
    externalReference: string | null;
    id: string;
    metadata: Record<string, unknown> | null;
    status: string;
    title: string;
    voidedAt: number | null;
  }>(
    `SELECT e.id, e.title, e.status, e.completed_at AS "completedAt",
            e.declined_at AS "declinedAt", e.voided_at AS "voidedAt",
            a.external_reference AS "externalReference", a.metadata
     FROM envelopes e LEFT JOIN api_envelopes a ON a.envelope_id = e.id
     WHERE e.id = $1`,
    [envelopeId],
  );
  const row = envelope.rows[0];

  if (!row) {
    return null;
  }

  const signers = await db.query(
    `SELECT id, name, email, sign_order AS "signOrder", status,
            signed_at AS "signedAt", declined_at AS "declinedAt",
            decline_reason AS "declineReason"
     FROM signers WHERE envelope_id = $1 ORDER BY sign_order`,
    [envelopeId],
  );

  return {
    created: Math.floor(Date.now() / 1000),
    data: {
      completedAt: row.completedAt,
      declinedAt: row.declinedAt,
      envelopeId: row.id,
      externalReference: row.externalReference,
      metadata: row.metadata ?? {},
      signers: signers.rows,
      status: row.status,
      title: row.title,
      voidedAt: row.voidedAt,
    },
    event,
    id: randomUUID(),
  };
}

async function attemptDelivery(deliveryId: string): Promise<void> {
  const db = getDb();
  const found = await db.query<{
    attempts: number;
    payload: unknown;
    secret: string;
    status: string;
    url: string;
  }>(
    `SELECT d.attempts, d.payload, d.status, e.url, e.secret
     FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.id = $1`,
    [deliveryId],
  );
  const delivery = found.rows[0];

  if (!delivery || delivery.status !== "pending") {
    return;
  }

  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const attempts = delivery.attempts + 1;
  let statusCode: number | null = null;
  let errorMessage: string | null = null;

  try {
    assertSafeWebhookUrl(delivery.url);
    const response = await fetch(delivery.url, {
      body,
      headers: {
        "content-type": "application/json",
        "signudoc-delivery": deliveryId,
        "signudoc-signature": `t=${String(timestamp)},v1=${signWebhookBody(
          delivery.secret,
          timestamp,
          body,
        )}`,
      },
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    statusCode = response.status;

    if (response.status < 200 || response.status >= 300) {
      errorMessage = `The endpoint answered ${String(response.status)}.`;
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Request failed.";
  }

  const now = Math.floor(Date.now() / 1000);

  if (!errorMessage) {
    await db.query(
      `UPDATE webhook_deliveries
       SET status = 'delivered', attempts = $2, delivered_at = $3,
           last_status_code = $4, last_error = NULL, next_attempt_at = NULL
       WHERE id = $1`,
      [deliveryId, attempts, now, statusCode],
    );

    return;
  }

  const giveUp = attempts >= MAX_ATTEMPTS;
  const delay =
    RETRY_DELAYS_SECONDS[Math.min(attempts - 1, RETRY_DELAYS_SECONDS.length - 1)] ??
    60;

  await db.query(
    `UPDATE webhook_deliveries
     SET status = $2, attempts = $3, last_status_code = $4, last_error = $5,
         next_attempt_at = $6
     WHERE id = $1`,
    [
      deliveryId,
      giveUp ? "failed" : "pending",
      attempts,
      statusCode,
      errorMessage.slice(0, 300),
      giveUp ? null : now + delay,
    ],
  );
}

async function emitNow(envelopeId: string, event: WebhookEvent): Promise<void> {
  const db = getDb();
  const owner = await db.query<{ userId: string }>(
    `SELECT user_id AS "userId" FROM envelopes WHERE id = $1`,
    [envelopeId],
  );
  const userId = owner.rows[0]?.userId;

  if (!userId) {
    return;
  }

  const endpoints = await db.query<{ id: string }>(
    `SELECT id FROM webhook_endpoints WHERE user_id = $1 AND active`,
    [userId],
  );

  if (endpoints.rows.length === 0) {
    return;
  }

  const payload = await buildEnvelopePayload(envelopeId, event);

  if (!payload) {
    return;
  }

  const ids: string[] = [];

  for (const endpoint of endpoints.rows) {
    const id = randomUUID();

    await db.query(
      `INSERT INTO webhook_deliveries
         (id, endpoint_id, envelope_id, event, payload, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, extract(epoch from now())::bigint)`,
      [id, endpoint.id, envelopeId, event, JSON.stringify(payload)],
    );
    ids.push(id);
  }

  await Promise.all(ids.map((id) => attemptDelivery(id)));
}

/**
 * Queues a webhook for an envelope event and tries to send it. It never
 * throws: a failure here must not undo a signature that was already saved.
 * Anything that fails is retried by retryDueDeliveries.
 */
export function emitEnvelopeEvent(
  envelopeId: string,
  event: WebhookEvent,
): void {
  const task = () =>
    emitNow(envelopeId, event).catch((error: unknown) => {
      console.error("[webhooks] Could not emit", event, error);
    });

  try {
    after(task);
  } catch {
    void task();
  }
}

export async function retryDueDeliveries(): Promise<{ retried: number }> {
  const due = await getDb().query<{ id: string }>(
    `SELECT id FROM webhook_deliveries
     WHERE status = 'pending'
       AND next_attempt_at <= extract(epoch from now())::bigint
     ORDER BY next_attempt_at LIMIT 50`,
  );

  for (const row of due.rows) {
    await attemptDelivery(row.id);
  }

  return { retried: due.rows.length };
}
