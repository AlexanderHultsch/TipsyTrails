import { randomUUID } from 'node:crypto';
import { CONFIG } from '@tipsytrails/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth, setSessionCookie, SESSION_COOKIE_NAME } from '../auth/cookie.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, deleteSession } from '../auth/session.js';
import type { Env } from '../env.js';
import { createRateLimiter } from '../http/rate-limit.js';

// A pre-computed argon2id hash with no corresponding password. Verifying
// against it when a submitted username is unknown burns the same CPU time as
// a real verification would, so the generic login failure carries no timing
// tell (Section 9.5).
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$CXa1fUEaLq21364CBeMR4g$slln4ryOJYGoZJaukEIqiuALeblyRubBuMSYzjkLfcA';

const usernameSchema = z
  .string()
  .min(CONFIG.USERNAME_MIN_LENGTH)
  .max(CONFIG.USERNAME_MAX_LENGTH)
  .regex(/^[a-zA-Z0-9_-]+$/);

const registerSchema = z.object({
  username: usernameSchema,
  password: z.string().min(CONFIG.PASSWORD_MIN_LENGTH),
  securityQuestion: z.string().min(1),
  securityAnswer: z.string().min(1),
  ageConfirmed: z.literal(true),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

interface UserRow {
  id: number;
  username: string;
  avatar_seed: string;
  is_admin: number;
  is_anonymous: number;
  must_change_password: number;
}

interface UserRowWithHash extends UserRow {
  password_hash: string;
}

interface PublicUser {
  id: number;
  username: string;
  avatarSeed: string;
  isAdmin: boolean;
  isAnonymous: boolean;
  mustChangePassword: boolean;
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    avatarSeed: row.avatar_seed,
    isAdmin: Boolean(row.is_admin),
    isAnonymous: Boolean(row.is_anonymous),
    mustChangePassword: Boolean(row.must_change_password),
  };
}

function sendInvalidRequest(reply: FastifyReply): void {
  reply.code(400).send({ code: 'invalid_request', message: 'The request body is invalid.' });
}

function sendInvalidCredentials(reply: FastifyReply): void {
  reply.code(401).send({ code: 'invalid_credentials', message: 'Invalid username or password.' });
}

function sendUnauthenticated(reply: FastifyReply): void {
  reply.code(401).send({ code: 'unauthenticated', message: 'Authentication required.' });
}

export function authRoutes(env: Env) {
  return async function authRoutesPlugin(app: FastifyInstance): Promise<void> {
    const authRateLimit = createRateLimiter('auth');

    app.post('/api/auth/register', { preHandler: authRateLimit }, async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) {
        sendInvalidRequest(reply);
        return;
      }
      const { username, password, securityQuestion, securityAnswer } = parsed.data;

      const existing = request.server.db
        .prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?')
        .get(username);
      if (existing) {
        reply
          .code(409)
          .send({ code: 'username_taken', message: 'That username is already in use.' });
        return;
      }

      const passwordHash = await hashPassword(password);
      const securityAnswerHash = await hashPassword(securityAnswer.trim().toLowerCase());
      const now = Math.floor(Date.now() / 1000);
      const avatarSeed = randomUUID();

      const result = request.server.db
        .prepare(
          `INSERT INTO users
            (username, password_hash, security_question, security_answer_hash, avatar_seed, age_confirmed_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(username, passwordHash, securityQuestion, securityAnswerHash, avatarSeed, now, now);

      const userId = Number(result.lastInsertRowid);
      const session = createSession(request.server.db, userId);
      setSessionCookie(reply, env, session.id);

      reply.code(201);
      return toPublicUser({
        id: userId,
        username,
        avatar_seed: avatarSeed,
        is_admin: 0,
        is_anonymous: 0,
        must_change_password: 0,
      });
    });

    app.post('/api/auth/login', { preHandler: authRateLimit }, async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        sendInvalidRequest(reply);
        return;
      }
      const { username, password } = parsed.data;

      const row = request.server.db
        .prepare<[string], UserRowWithHash>(
          `SELECT id, username, password_hash, avatar_seed, is_admin, is_anonymous, must_change_password
           FROM users WHERE username = ?`,
        )
        .get(username);

      const passwordValid = await verifyPassword(
        row ? row.password_hash : DUMMY_PASSWORD_HASH,
        password,
      );

      if (!row || !passwordValid) {
        sendInvalidCredentials(reply);
        return;
      }

      const session = createSession(request.server.db, row.id);
      setSessionCookie(reply, env, session.id);
      return toPublicUser(row);
    });

    app.post('/api/auth/logout', async (request, reply) => {
      const cookieValue = request.cookies[SESSION_COOKIE_NAME];
      if (cookieValue) {
        const unsigned = request.unsignCookie(cookieValue);
        if (unsigned.valid && unsigned.value) {
          deleteSession(request.server.db, unsigned.value);
        }
      }
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      return { ok: true };
    });

    app.get('/api/auth/me', { preHandler: requireAuth }, async (request, reply) => {
      if (request.userId == null) {
        sendUnauthenticated(reply);
        return;
      }

      const row = request.server.db
        .prepare<[number], UserRow>(
          `SELECT id, username, avatar_seed, is_admin, is_anonymous, must_change_password
           FROM users WHERE id = ?`,
        )
        .get(request.userId);

      if (!row) {
        sendUnauthenticated(reply);
        return;
      }

      return toPublicUser(row);
    });
  };
}
