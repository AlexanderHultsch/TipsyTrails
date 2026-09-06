import { useEffect } from 'react';
import { postShellReady } from './messages.js';

// `ready`, the first of 8.2's Page -> shell messages: "the web app has
// mounted", and the shell "replies with the current state through `dispatch`".
//
// Mounted in `App`, above the router, because "the web app has mounted" is a
// fact about the document and not about a route - and because the answer it
// asks for is the state of a tracker that has usually been running since before
// this document existed, which every screen wants and no screen owns.
//
// **It is deliberately not conditional on there being a session.** The shell's
// reply is a `dispatch` of what the tracker is doing, which for a signed-out
// player is an `idle` `tracking` event - a true answer, and the one the third
// icon of 8.3 needs in order to say `idle` rather than nothing.
//
// **Once per mount, not once per document.** React's StrictMode double-invokes
// effects in development, so a development build posts this twice; the shell's
// answer is a re-`dispatch` of the current state, which is idempotent, and the
// alternative - a module-level "already posted" flag - would make a second
// mount in the same document silently fail to announce itself, which is the
// failure with no symptom rather than the harmless one.
export function useShellReady(): void {
  useEffect(() => {
    postShellReady();
  }, []);
}
