import { createHmac, randomUUID } from 'node:crypto';
import { CONFIG } from '@tipsytrails/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, setSessionCookie, SESSION_COOKIE_NAME } from '../auth/cookie.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  createSession,
  deleteOtherSessionsForUser,
  deleteSession,
  deleteSessionsForUser,
} from '../auth/session.js';
import type { Env } from '../env.js';
import {
  sendInvalidCredentials,
  sendInvalidRequestBody,
  sendUnauthenticated,
} from '../http/errors.js';
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

const passwordSchema = z.string().min(CONFIG.PASSWORD_MIN_LENGTH);

const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  securityQuestion: z.string().min(1),
  securityAnswer: z.string().min(1),
  ageConfirmed: z.literal(true),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const resetQuestionQuerySchema = z.object({
  username: z.string().trim().min(1),
});

const resetSchema = z.object({
  username: z.string().trim().min(1),
  securityAnswer: z.string().min(1),
  newPassword: passwordSchema,
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

// Fixed pool of plausible security questions used to answer
// GET /api/auth/reset/question for usernames that do not exist. The index
// into this list is derived deterministically from an HMAC of the username
// (Section 9.5), so the same unknown username always gets the same decoy.
const DECOY_SECURITY_QUESTIONS = [
  'What was the name of your first pet?',
  "What is your mother's maiden name?",
  'What was the make and model of your first car?',
  'What elementary school did you attend?',
  'In what city were you born?',
  'What was your childhood nickname?',
  'What is the name of your favorite childhood teacher?',
  'What street did you grow up on?',
  'What was the first concert you attended?',
  'What is the name of your favorite fictional character?',
];

// Expects a username already trimmed at the route boundary (Section 9.5),
// the same value used for the database lookup, so the two can never
// normalise differently.
function decoySecurityQuestion(trimmedUsername: string, env: Env): string {
  const normalized = trimmedUsername.toLowerCase();
  const digest = createHmac('sha256', env.SESSION_SECRET).update(normalized).digest();
  const index = digest.readUInt32BE(0) % DECOY_SECURITY_QUESTIONS.length;
  return DECOY_SECURITY_QUESTIONS[index];
}

function usernameFromRequest(request: FastifyRequest): string {
  const query = request.query as { username?: unknown };
  if (typeof query?.username === 'string') {
    return query.username;
  }
  const body = request.body as { username?: unknown } | undefined;
  if (typeof body?.username === 'string') {
    return body.username;
  }
  return '';
}

// The user record as every endpoint that answers with one sends it, and the
// row it is projected from. This module owns both because `GET
// /api/auth/me` is the canonical "who am I" answer and register/login return
// the same body; routes/account.ts imports them for `PATCH /api/settings`,
// which answers with the updated user, rather than keeping the second
// identical copy of all three it used to (same precedent as the shared
// reply bodies in http/errors.ts, imported rather than redefined per route).
// Two copies of a client-facing shape is exactly the thing that drifts, and
// the web client's own mirror of it (packages/web/src/api/types.ts's
// `User`) already has to be kept in step by hand across the package
// boundary — there is no reason to have a third to keep in step inside this
// one.
//
// `password_hash` and `security_answer_hash` are deliberately absent from
// both: neither ever leaves the server (Section 10.2), and the only place
// that needs the hash asks for it explicitly via `UserRowWithHash` below.
export interface UserRow {
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

// Not exported for the same reason the other result shapes in this package
// are not: every consumer gets it back from `toPublicUser` and sends it on,
// never holding it under its own name.
interface PublicUser {
  id: number;
  username: string;
  avatarSeed: string;
  isAdmin: boolean;
  isAnonymous: boolean;
  mustChangePassword: boolean;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    avatarSeed: row.avatar_seed,
    isAdmin: Boolean(row.is_admin),
    isAnonymous: Boolean(row.is_anonymous),
    mustChangePassword: Boolean(row.must_change_password),
  };
}

function sendInvalidResetAnswer(reply: FastifyReply): void {
  reply.code(401).send({ code: 'invalid_reset', message: 'Invalid username or security answer.' });
}

function sendInvalidCurrentPassword(reply: FastifyReply): void {
  reply.code(401).send({ code: 'invalid_credentials', message: 'Current password is incorrect.' });
}

export function authRoutes(env: Env) {
  return async function authRoutesPlugin(app: FastifyInstance): Promise<void> {
    const authRateLimit = createRateLimiter('auth');
    const resetByUserRateLimit = createRateLimiter('resetByUser', {
      getUsername: usernameFromRequest,
    });
    const resetByIpRateLimit = createRateLimiter('resetByIp');
    const resetRateLimits = [resetByUserRateLimit, resetByIpRateLimit];

    app.post('/api/auth/register', { preHandler: authRateLimit }, async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) {
        sendInvalidRequestBody(reply);
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
        sendInvalidRequestBody(reply);
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

    app.get('/api/auth/reset/question', { preHandler: resetRateLimits }, async (request, reply) => {
      const parsed = resetQuestionQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        sendInvalidRequestBody(reply);
        return;
      }
      const { username } = parsed.data;

      const row = request.server.db
        .prepare<[string], { security_question: string }>(
          'SELECT security_question FROM users WHERE username = ?',
        )
        .get(username);

      const question = row ? row.security_question : decoySecurityQuestion(username, env);
      return { question };
    });

    app.post('/api/auth/reset', { preHandler: resetRateLimits }, async (request, reply) => {
      const parsed = resetSchema.safeParse(request.body);
      if (!parsed.success) {
        sendInvalidRequestBody(reply);
        return;
      }
      const { username, securityAnswer, newPassword } = parsed.data;

      const row = request.server.db
        .prepare<[string], { id: number; security_answer_hash: string }>(
          'SELECT id, security_answer_hash FROM users WHERE username = ?',
        )
        .get(username);

      const answerValid = await verifyPassword(
        row ? row.security_answer_hash : DUMMY_PASSWORD_HASH,
        securityAnswer.trim().toLowerCase(),
      );

      if (!row || !answerValid) {
        sendInvalidResetAnswer(reply);
        return;
      }

      const newPasswordHash = await hashPassword(newPassword);
      request.server.db
        .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(newPasswordHash, row.id);
      deleteSessionsForUser(request.server.db, row.id);

      return { ok: true };
    });

    app.post('/api/auth/change-password', { preHandler: requireAuth }, async (request, reply) => {
      if (request.userId == null) {
        sendUnauthenticated(reply);
        return;
      }

      const parsed = changePasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        sendInvalidRequestBody(reply);
        return;
      }
      const { currentPassword, newPassword } = parsed.data;

      const row = request.server.db
        .prepare<[number], { password_hash: string }>(
          'SELECT password_hash FROM users WHERE id = ?',
        )
        .get(request.userId);
      if (!row) {
        sendUnauthenticated(reply);
        return;
      }

      const currentValid = await verifyPassword(row.password_hash, currentPassword);
      if (!currentValid) {
        sendInvalidCurrentPassword(reply);
        return;
      }

      const newPasswordHash = await hashPassword(newPassword);
      request.server.db
        .prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
        .run(newPasswordHash, request.userId);

      const cookieValue = request.cookies[SESSION_COOKIE_NAME];
      if (cookieValue) {
        const unsigned = request.unsignCookie(cookieValue);
        if (unsigned.valid && unsigned.value) {
          deleteOtherSessionsForUser(request.server.db, request.userId, unsigned.value);
        }
      }

      return { ok: true };
    });
  };
}
