import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Session, SessionSchema } from "@reasonateai/contracts/identity";
import type { Pool } from "pg";

export interface IssuedSession {
  session: Session;
  /** Opaque bearer value for the browser cookie. Never persisted in plaintext. */
  token: string;
}

export interface SessionRepository {
  createSession: (input: {
    absoluteTtlMs: number;
    idleTtlMs: number;
    ip?: string;
    userAgent?: string;
    userId: string;
  }) => Promise<IssuedSession>;
  /** Resolves a live session, touches it, and extends idle expiry. */
  resolveSession: (token: string) => Promise<Session | undefined>;
  revokeAllUserSessions: (userId: string) => Promise<number>;
  revokeSession: (sessionId: string) => Promise<boolean>;
  rotateSession: (input: {
    absoluteTtlMs: number;
    idleTtlMs: number;
    token: string;
  }) => Promise<IssuedSession | undefined>;
}

const TOKEN_BYTES = 32;

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * A high-entropy random token needs only a fast digest. A slow password KDF
 * would add latency to every authenticated request without adding security,
 * because the token is not user-chosen and cannot be guessed.
 */
const issueToken = (): string => randomBytes(TOKEN_BYTES).toString("base64url");

function toSession(row: Record<string, unknown>): Session {
  return SessionSchema.parse({
    absoluteExpiresAt: (row.absolute_expires_at as Date).toISOString(),
    createdAt: (row.created_at as Date).toISOString(),
    idleExpiresAt: (row.idle_expires_at as Date).toISOString(),
    lastSeenAt: (row.last_seen_at as Date).toISOString(),
    revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : null,
    rotatedFromSessionId: row.rotated_from_session_id ?? null,
    sessionId: row.session_id,
    userId: row.user_id,
  });
}

export function createSessionRepository(
  pool: Pool,
  config: { idleTtlMs: number }
): SessionRepository {
  async function insertSession(input: {
    absoluteTtlMs: number;
    idleTtlMs: number;
    ip?: string;
    rotatedFromSessionId?: string;
    token: string;
    userAgent?: string;
    userId: string;
  }): Promise<Session> {
    const result = await pool.query(
      `insert into auth_sessions
         (session_id, token_hash, user_id, idle_expires_at, absolute_expires_at,
          rotated_from_session_id, user_agent_hash, ip_hash)
       values ($1, $2, $3,
               now() + make_interval(secs => $4::double precision),
               now() + make_interval(secs => $5::double precision),
               $6, $7, $8)
       returning *`,
      [
        randomUUID(),
        digest(input.token),
        input.userId,
        input.idleTtlMs / 1000,
        input.absoluteTtlMs / 1000,
        input.rotatedFromSessionId ?? null,
        input.userAgent ? digest(input.userAgent) : null,
        input.ip ? digest(input.ip) : null,
      ]
    );

    const [row] = result.rows;
    if (!row) {
      throw new Error("Session insert returned no row.");
    }

    return toSession(row);
  }

  return {
    createSession: async (input) => {
      const token = issueToken();
      const session = await insertSession({ ...input, token });
      return { session, token };
    },

    resolveSession: async (token) => {
      const result = await pool.query(
        `update auth_sessions
            set last_seen_at = now(),
                idle_expires_at = least(
                  now() + make_interval(secs => $2::double precision),
                  absolute_expires_at
                )
          where token_hash = $1
            and revoked_at is null
            and idle_expires_at > now()
            and absolute_expires_at > now()
          returning *`,
        [digest(token), config.idleTtlMs / 1000]
      );

      const [row] = result.rows;
      return row ? toSession(row) : undefined;
    },

    revokeAllUserSessions: async (userId) => {
      const result = await pool.query(
        `update auth_sessions
            set revoked_at = now()
          where user_id = $1 and revoked_at is null`,
        [userId]
      );
      return result.rowCount ?? 0;
    },

    revokeSession: async (sessionId) => {
      const result = await pool.query(
        `update auth_sessions
            set revoked_at = now()
          where session_id = $1 and revoked_at is null
          returning session_id`,
        [sessionId]
      );
      return result.rowCount === 1;
    },

    rotateSession: async (input) => {
      const existing = await pool.query(
        `update auth_sessions
            set revoked_at = now()
          where token_hash = $1
            and revoked_at is null
            and idle_expires_at > now()
            and absolute_expires_at > now()
          returning session_id, user_id`,
        [digest(input.token)]
      );

      const [row] = existing.rows;
      if (!row) {
        return;
      }

      const token = issueToken();
      const session = await insertSession({
        absoluteTtlMs: input.absoluteTtlMs,
        idleTtlMs: input.idleTtlMs,
        rotatedFromSessionId: row.session_id as string,
        token,
        userId: row.user_id as string,
      });

      return { session, token };
    },
  };
}
