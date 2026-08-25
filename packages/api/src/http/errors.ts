import type { FastifyReply } from 'fastify';

// The error replies that more than one module sends, written once. SPEC.md
// Section 9.5 fixes the `{ code, message }` envelope and, for several of
// these, requires that two different causes be answered byte-identically — a
// rule that a copy of the body in each route can only keep by luck.
//
// What belongs here: a reply body sent by **two or more** modules. A body
// only one route ever sends stays in that route beside the handler that
// sends it (routes/visits.ts's `sendVisitNotFound`, routes/profile.ts's
// `sendProfileNotFound`, auth/cookie.ts's `sendForbidden`) — those are part
// of that route's contract rather than shared vocabulary.
//
// Under `http/` rather than `routes/` because `auth/cookie.ts` sends
// `sendUnauthenticated` too, and `auth/` importing from `routes/` would
// invert the layering. `http/` (csrf.ts, rate-limit.ts, security-headers.ts)
// is request/reply plumbing that both `routes/` and `auth/` sit on top of.

export function sendUnauthenticated(reply: FastifyReply): void {
  reply.code(401).send({ code: 'unauthenticated', message: 'Authentication required.' });
}

// SPEC.md Section 9.5: the same generic failure POST /api/auth/login uses
// for a wrong password, reused by routes/account.ts rather than a new code.
export function sendInvalidCredentials(reply: FastifyReply): void {
  reply.code(401).send({ code: 'invalid_credentials', message: 'Invalid username or password.' });
}

// Two bodies for one `code`, and the distinction is in the names on purpose:
// `invalid_request` is answered with "body" almost everywhere but with
// "query" by `GET /api/leaderboard`. Both are messages clients already see,
// so neither can be folded into the other.
//
// The names are qualified because an unqualified `sendInvalidRequest` made
// the choice invisible at the call site, and one route picks the one that
// does not match what it validated: routes/admin.ts's `GET /api/admin/bars`
// parses `request.query` and answers "The request body is invalid.". That
// reply is what the endpoint sends today and is left alone here; changing it
// is a behaviour change, not a rename.

export function sendInvalidRequestBody(reply: FastifyReply): void {
  reply.code(400).send({ code: 'invalid_request', message: 'The request body is invalid.' });
}

export function sendInvalidRequestQuery(reply: FastifyReply): void {
  reply.code(400).send({ code: 'invalid_request', message: 'The request query is invalid.' });
}

export function sendCityNotFound(reply: FastifyReply): void {
  reply.code(404).send({ code: 'city_not_found', message: 'No active city is configured.' });
}

// SPEC.md Section 5.1: "Positions outside the active city's bounding box are
// silently ignored by all endpoints" describes read/derive endpoints like
// `POST /api/samples`; a submission is a write the user must be told about,
// so the routes that accept a position (routes/bars.ts's suggest handler,
// routes/admin.ts's create/move handlers) reject rather than silently ignore.
export function sendOutsideCity(reply: FastifyReply): void {
  reply.code(422).send({
    code: 'outside_city',
    message: 'That position is outside the playable area.',
  });
}

export function sendGridUnavailable(reply: FastifyReply): void {
  reply.code(503).send({
    code: 'grid_unavailable',
    message: 'The district grid is not loaded on this server.',
  });
}

// SPEC.md Section 9.5: identical for "does not exist" and "not discovered by
// you" — a 403 would confirm existence and defeat Section 7.4. routes/bars.ts,
// routes/visits.ts and routes/admin.ts all send this one body for the same
// reason (Sections 7.4, 9.5: a check-in attempt must not become an existence
// oracle either) rather than each duplicating it.
export function sendBarNotFound(reply: FastifyReply): void {
  reply.code(404).send({ code: 'bar_not_found', message: 'That bar does not exist.' });
}
