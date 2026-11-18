import { createHash, randomBytes, randomUUID } from "node:crypto";

import { getDb } from "../db/connection.ts";

export const API_KEY_PREFIX = "sud_";

export type ApiPrincipal = {
  keyId: string;
  user: { email: string; id: string; name: string };
};

export type ApiKeyRecord = {
  createdAt: number;
  id: string;
  keyPrefix: string;
  lastUsedAt: number | null;
  name: string;
  revokedAt: number | null;
};

const LAST_USED_REFRESH_SECONDS = 60;

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Returns the key once. Only its hash is stored, so it cannot be shown again. */
export async function createApiKey(
  userId: string,
  name: string,
): Promise<{ id: string; key: string; keyPrefix: string }> {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  const keyPrefix = key.slice(0, API_KEY_PREFIX.length + 6);

  await getDb().query(
    `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, name.trim().slice(0, 80) || "API key", keyPrefix, hashApiKey(key)],
  );

  return { id, key, keyPrefix };
}

export async function listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
  const result = await getDb().query<ApiKeyRecord>(
    `SELECT id, name, key_prefix AS "keyPrefix", created_at AS "createdAt",
            last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"
     FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );

  return result.rows;
}

export async function revokeApiKey(
  userId: string,
  keyId: string,
): Promise<boolean> {
  const result = await getDb().query(
    `UPDATE api_keys SET revoked_at = extract(epoch from now())::bigint
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [keyId, userId],
  );

  return result.rowCount === 1;
}

export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;

  return match?.[1] ?? null;
}

export async function authenticateApiRequest(
  request: Request,
): Promise<ApiPrincipal | null> {
  const token = readBearerToken(request);

  if (!token?.startsWith(API_KEY_PREFIX)) {
    return null;
  }

  const result = await getDb().query<{
    email: string;
    keyId: string;
    lastUsedAt: number | null;
    name: string;
    userId: string;
  }>(
    `SELECT k.id AS "keyId", k.last_used_at AS "lastUsedAt",
            u.id AS "userId", u.email, u.name
     FROM api_keys k JOIN "user" u ON u.id = k.user_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hashApiKey(token)],
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

  if (!row.lastUsedAt || now - row.lastUsedAt > LAST_USED_REFRESH_SECONDS) {
    await getDb().query(`UPDATE api_keys SET last_used_at = $1 WHERE id = $2`, [
      now,
      row.keyId,
    ]);
  }

  return {
    keyId: row.keyId,
    user: { email: row.email, id: row.userId, name: row.name },
  };
}
