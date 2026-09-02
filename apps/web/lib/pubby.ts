import { PubbyServer } from "@getpubby/sdk/server";

/**
 * Whether Pubby is configured. Self-hosted installs commonly have no Pubby at all.
 */
export const PUBBY_ENABLED = !!(
  process.env.PUBBY_APP_ID &&
  process.env.PUBBY_APP_KEY &&
  process.env.PUBBY_APP_SECRET
);

const client = new PubbyServer({
  appId: process.env.PUBBY_APP_ID!,
  key: process.env.PUBBY_APP_KEY!,
  secret: process.env.PUBBY_APP_SECRET!,
  apiHost: "https://api.pubby.dev",
});

/**
 * The Pubby client, with `trigger` made a no-op when Pubby is not configured.
 *
 * The `!` assertions above do not throw at construction, so on an install with no Pubby
 * every `trigger` reached the API with an undefined app id and came back `500`. Harmless
 * to the caller, which fires and forgets, and not harmless to read: a self-hosted
 * deployment logged one failure per review forever, and a real outage would have looked
 * exactly the same as the steady state.
 *
 * Guarded HERE rather than at the call sites. There are 68 of them, the guard was already
 * documented as the caller's job and none of them did it, and the sixty-ninth would not
 * either. A rule nobody follows is better encoded than restated.
 *
 * `authenticatePrivateChannel` and `authenticatePresenceChannel` are deliberately not
 * wrapped. They answer a browser asking to join a channel, and with no Pubby there is
 * nothing to join: failing is the correct answer, and a silent success would leave the
 * client waiting on a subscription it will never get.
 */
export const pubby = {
  trigger: async (...args: Parameters<PubbyServer["trigger"]>) => {
    if (!PUBBY_ENABLED) return undefined;
    return client.trigger(...args);
  },
  authenticatePrivateChannel: (...args: Parameters<PubbyServer["authenticatePrivateChannel"]>) =>
    client.authenticatePrivateChannel(...args),
  authenticatePresenceChannel: (...args: Parameters<PubbyServer["authenticatePresenceChannel"]>) =>
    client.authenticatePresenceChannel(...args),
};
