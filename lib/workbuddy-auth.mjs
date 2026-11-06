// The WorkBuddy side of Login: take the community plugin's hooks exactly as it
// returns them, then append one more sign-in method at the end of
// `auth.methods`.
//
// magpie lets one plugin serve a provider, and "other sign-in methods" shows
// every method that plugin hands out. Registering a second plugin would hide
// the browser / desktop / API-key methods; taking the provider over and
// returning only the pasted one would hide them too. Wrapping keeps all four
// in one hand-out.
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const COMMUNITY = "@magpie-community/opencode-workbuddy-auth";

function configDir() {
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "magpie");
  return join(homedir(), ".config", "magpie");
}

/** Every place the community plugin may have landed, nearest first. */
function candidates() {
  const dir = configDir();
  // Only the configured directory: falling back to the real home directory
  // would let an isolated or test environment silently load production data.
  return [
    COMMUNITY,
    pathToFileURL(join(dir, "plugins", "node_modules", COMMUNITY, "index.mjs")).href,
    pathToFileURL(join(dir, "plugins", "node_modules", COMMUNITY, "opencode.mjs")).href,
  ];
}

async function communityFactory() {
  for (const spec of candidates()) {
    try {
      const mod = await import(spec);
      // The package's "." export points at opencode2.mjs, which has no
      // WorkBuddyAuthPlugin; the factory lives in index.mjs. Take the first
      // module that actually exports it, not the first one that imports.
      if (typeof mod?.WorkBuddyAuthPlugin === "function") return mod.WorkBuddyAuthPlugin;
    } catch {
      // try the next spelling
    }
  }
  throw new Error(
    [
      `找不到社区插件 ${COMMUNITY} 的 WorkBuddyAuthPlugin 导出。`,
      "Login 的 WorkBuddy 登录是挂在它上面的，先安装或升级它：",
      `  magpie plugin add ${COMMUNITY}`,
    ].join("\n"),
  );
}

/**
 * The plugin function's return value. Returns `{}` when the community plugin
 * is absent: the page half of Login must still load, with the reason in the log.
 */
export async function workbuddyAuthHooks(input) {
  const make = await communityFactory();
  const hooks = (await make(input)) ?? {};

  const { authorize } = await import("./workbuddy-paste.mjs");

  const methods = Array.isArray(hooks.auth?.methods) ? hooks.auth.methods : [];
  // Do not duplicate the method if the host loads this module twice.
  if (methods.some((method) => method && method.label === "粘贴凭据登录")) return hooks;

  return {
    ...hooks,
    auth: {
      ...hooks.auth,
      provider: hooks.auth?.provider ?? "workbuddy",
      methods: [
        ...methods,
        {
          type: "oauth",
          label: "粘贴凭据登录",
          prompts: [
            {
              type: "text",
              key: "credential",
              message: "把凭据 JSON、Cookie、请求头或 API key 粘到这里",
              placeholder:
                '{"account":{…},"auth":{"accessToken":"…","refreshToken":"…"}} / access_token=…; refresh_token=… / ck_…',
            },
          ],
          authorize,
        },
      ],
    },
  };
}
