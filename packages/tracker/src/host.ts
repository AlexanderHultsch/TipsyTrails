// ios/SPEC.md Section 7.2. The `Host` interface is the whole surface the
// tracker touches outside itself - it holds no global and calls nothing but
// this object. This file is the contract between TypeScript and Swift: the
// runtime module's Swift is a line-for-line implementation of it (Section
// 7.2's own words), substep F4 checks the two against each other, and under
// Vitest and the replay harness this same interface is satisfied by a fake
// clock and by Fastify's `inject` respectively (Section 13.2). Changing a
// member here is changing what the shell must implement.
import type { TrackerEvent } from './events.js';

// Section 7.2: what `Host.fetch` takes and returns.
export interface HostRequest {
  method: string;
  path: string;
  body?: string;
}

export interface HostResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// Section 7.3's three profiles, and the fields each one sets on
// `CLLocationManager` (Section 6.3) through `configureLocation`.
export interface LocationProfile {
  desiredAccuracyM: number;
  distanceFilterM: number;
  background: boolean;
}

// Section 7.2's `scheduleNotification` payload; Section 7.7 lists the four
// notifications the tracker schedules through it.
export interface LocalNotification {
  id: string;
  atMs: number;
  title: string;
  body: string;
}

// ios/SPEC.md Section 7.2's code block, verbatim: ten members, these names,
// these signatures.
export interface Host {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  // Returns a response for every HTTP status the server sends, including
  // 4xx and 5xx - it throws only on a transport failure (no connectivity, a
  // DNS failure, and the like). This is the opposite of what a reader who
  // knows WHATWG `fetch` expects, where a non-2xx status is still a
  // resolved response but the *distinction* between "the server answered"
  // and "the request never completed" is easy to blur; here that
  // distinction is exactly, and only, resolve-vs-throw. It is deliberately
  // not the WHATWG `fetch`: no streams, no `Headers` class, no `Request`
  // object - a subset Swift can implement completely (Section 7.2).
  fetch(input: HostRequest): Promise<HostResponse>;
  configureLocation(profile: LocationProfile): void;
  requestSignificantChanges(on: boolean): void;
  scheduleNotification(n: LocalNotification): void;
  cancelNotification(id: string): void;
  emit(event: TrackerEvent): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}
