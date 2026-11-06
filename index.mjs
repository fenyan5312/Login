import { startServer } from "./lib/server.mjs";
import { workbuddyAuthHooks } from "./lib/workbuddy-auth.mjs";

let starting;
let service = null;

function portOf(options) {
  const port = Number(options?.port ?? 3492);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3492;
}

// Test-only handle on the background start. magpie only ever sees the default
// export; this lets a test await the service that `server()` deliberately does
// not wait for, and close it again.
export const __testing = {
  get starting() {
    return starting;
  },
  get service() {
    return service;
  },
  reset() {
    starting = undefined;
    service = null;
  },
};

// One plugin, two jobs:
//
//   1. the page — proxy exits, provider sign-ins and the account ledger,
//      served by a loopback HTTP service (lib/server.mjs);
//   2. WorkBuddy — the community plugin's hooks, unchanged, with one more
//      sign-in method ("paste a credential") appended (lib/workbuddy-auth.mjs).
//
// magpie hands `server()` the real `client` (auth.set, tui.showToast,
// app.log) and `magpie` API; the page service keeps them so an import writes
// through the same `client.auth.set` a sign-in uses. The returned object is
// the provider hooks; `{}` when the community plugin is absent (the page half
// must still load).
//
// The bind stays out of `server()`'s return path: during an update the old
// host still owns the port until it exits, and awaiting the bind here used up
// magpie's load budget and made the plugin look like it never loaded.
export default {
  id: "magpie-login",
  server: async (input = {}, options = {}) => {
    starting ??= startServer({
      port: portOf(options),
      portRetryMs: Number.POSITIVE_INFINITY,
      client: input.client,
      magpie: input.magpie,
      pluginInput: input,
    })
      .then((started) => {
        service = started;
        console.log(`[login] page listening on http://127.0.0.1:${started.port}`);
        return started;
      })
      .catch((error) => {
        starting = undefined;
        console.error(`[login] page service failed to start: ${String(error?.message ?? error)}`);
        return null;
      });

    try {
      return await workbuddyAuthHooks(input);
    } catch (error) {
      console.error(`[login] WorkBuddy methods unavailable: ${String(error?.message ?? error)}`);
      return {};
    }
  },
};
