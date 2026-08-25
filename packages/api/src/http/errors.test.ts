import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  sendBarNotFound,
  sendCityNotFound,
  sendGridUnavailable,
  sendInvalidCredentials,
  sendInvalidRequestBody,
  sendInvalidRequestQuery,
  sendOutsideCity,
  sendUnauthenticated,
} from './errors.js';

// The route suites assert status codes thoroughly and response bodies hardly
// at all: mutation testing found that changing `sendCityNotFound`'s message,
// or its `code`, or `sendBarNotFound`'s `code`, left every other API test
// passing. This file is the missing pin on the bodies themselves (SPEC.md
// Section 9.5's `{ code, message }` envelope).
//
// Deliberately a table of literals rather than anything derived from the
// source: a test that built the expected message from the same constant the
// helper uses would agree with any change to it, which is the failure mode
// being closed.

interface Captured {
  statusCode: number | null;
  body: unknown;
}

function captureReply(): { reply: FastifyReply; captured: Captured } {
  const captured: Captured = { statusCode: null, body: undefined };
  const stub = {
    code(status: number) {
      captured.statusCode = status;
      return stub;
    },
    send(payload: unknown) {
      captured.body = payload;
      return stub;
    },
  };
  return { reply: stub as unknown as FastifyReply, captured };
}

const cases: ReadonlyArray<{
  name: string;
  send: (reply: FastifyReply) => void;
  status: number;
  code: string;
  message: string;
}> = [
  {
    name: 'sendUnauthenticated',
    send: sendUnauthenticated,
    status: 401,
    code: 'unauthenticated',
    message: 'Authentication required.',
  },
  {
    name: 'sendInvalidCredentials',
    send: sendInvalidCredentials,
    status: 401,
    code: 'invalid_credentials',
    message: 'Invalid username or password.',
  },
  {
    name: 'sendInvalidRequestBody',
    send: sendInvalidRequestBody,
    status: 400,
    code: 'invalid_request',
    message: 'The request body is invalid.',
  },
  {
    name: 'sendInvalidRequestQuery',
    send: sendInvalidRequestQuery,
    status: 400,
    code: 'invalid_request',
    message: 'The request query is invalid.',
  },
  {
    name: 'sendCityNotFound',
    send: sendCityNotFound,
    status: 404,
    code: 'city_not_found',
    message: 'No active city is configured.',
  },
  {
    name: 'sendOutsideCity',
    send: sendOutsideCity,
    status: 422,
    code: 'outside_city',
    message: 'That position is outside the playable area.',
  },
  {
    name: 'sendGridUnavailable',
    send: sendGridUnavailable,
    status: 503,
    code: 'grid_unavailable',
    message: 'The district grid is not loaded on this server.',
  },
  {
    name: 'sendBarNotFound',
    send: sendBarNotFound,
    status: 404,
    code: 'bar_not_found',
    message: 'That bar does not exist.',
  },
];

describe('shared error replies', () => {
  for (const testCase of cases) {
    it(`${testCase.name} sends ${testCase.status} ${testCase.code}`, () => {
      const { reply, captured } = captureReply();
      testCase.send(reply);
      expect(captured.statusCode).toBe(testCase.status);
      expect(captured.body).toEqual({ code: testCase.code, message: testCase.message });
    });
  }

  // The trap this module was built around: `sendInvalidRequest` existed in
  // eight modules with two different messages, and merging them into one
  // would have silently changed what `GET /api/leaderboard` replies to a bad
  // query string. Both survive, and they must stay distinguishable.
  it('keeps the body and query variants of invalid_request distinct', () => {
    const body = captureReply();
    const query = captureReply();
    sendInvalidRequestBody(body.reply);
    sendInvalidRequestQuery(query.reply);
    expect(body.captured.body).not.toEqual(query.captured.body);
  });
});
