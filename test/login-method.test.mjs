// The login-method classification fix, end to end.
//
// Four changes are pinned here:
//
//   1. the scan projects a method's `prompts` into a public-safe shape, so the
//      card can tell "needs a form" from "just opens a browser";
//   2. the sign-in flow classifies the REAL flow from what authorize()
//      returned (classifyAuthorizedFlow), and chooseBrowserMethod() can be
//      told which method to use;
//   3. the card's markers name the five kinds honestly, in four languages;
//   4. a plugin with several runnable oauth methods (ZCode's per-site flows)
//      offers a choice instead of silently taking the first one.
//
// The plugin facts below are the ones read out of the installed magpie plugins
// under ~/.config/magpie/plugins/node_modules; nothing here imports a provider
// plugin or calls authorize() outside the sign-in flow's own injected pieces.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyMethod,
  normalizeScan,
  projectPrompts,
  requiresFormInput,
  requiresSecretInput,
} from "../lib/magpie-plugins.mjs";
import { mergeProviderSources } from "../lib/provider-sources.mjs";
import {
  classifyAuthorizedFlow,
  chooseBrowserMethod,
  createSignInFlow,
} from "../lib/signin-flow.mjs";
import { methodCategory, methodCategoryText } from "../ui/provider-state.js";

// ---------- change 1: the prompts projection ----------

test("the prompts projection keeps only the public field shape", () => {
  const prompts = [
    {
      type: "text",
      key: "startUrl",
      message: "Organization Start URL",
      placeholder: "https://d-xxxxxxxxxx.awsapps.com/start",
      default: "leaked default",
      validate: () => undefined,
    },
    {
      type: "select",
      key: "site",
      message: "Where is the team's plan?",
      options: [
        { label: "Z.ai", value: "zai", hint: "z.ai" },
        { label: "BigModel (智谱)", value: "bigmodel", hint: "bigmodel.cn" },
      ],
    },
  ];
  const projected = projectPrompts(prompts);
  expect(projected).toEqual([
    { type: "text", key: "startUrl", message: "Organization Start URL", options: [] },
    {
      type: "select",
      key: "site",
      message: "Where is the team's plan?",
      options: [
        { label: "Z.ai", value: "zai" },
        { label: "BigModel (智谱)", value: "bigmodel" },
      ],
    },
  ]);
  // No entered value, no placeholder, no hint and no function survives.
  const text = JSON.stringify(projected);
  expect(text).not.toContain("placeholder");
  expect(text).not.toContain("leaked default");
  expect(text).not.toContain("hint");
  expect(text).not.toContain("validate");
});

test("the prompts projection is bounded, idempotent and never throws", () => {
  for (const junk of [null, undefined, 42, "text", {}, [null, 42, "x"]]) {
    expect(projectPrompts(junk)).toEqual([]);
  }
  const once = projectPrompts([{ type: "select", key: "k", message: "m", options: [{ label: "a", value: "b" }] }]);
  expect(projectPrompts(once)).toEqual(once);
});

test("a method that asks for typed details is a form, not a browser hand-off", () => {
  const kiro = classifyMethod({
    type: "oauth",
    label: "Kiro (Google, GitHub, AWS Builder ID, IAM Identity Center)",
    hasAuthorize: true,
    prompts: [
      { type: "select", key: "loginMethod", message: "Choose a sign-in method", options: [] },
      { type: "text", key: "startUrl", message: "Organization Start URL" },
      { type: "text", key: "region", message: "AWS region" },
    ],
  });
  expect(kiro.category).toBe("form");
  expect(kiro.browser).toBe(false);
  expect(requiresFormInput(kiro.prompts)).toBe(true);
});

test("a method that asks for a pasted secret is a secret flow", () => {
  const pat = classifyMethod({
    type: "oauth",
    label: "Sign in with Qoder PAT",
    hasAuthorize: true,
    prompts: [{ type: "password", key: "pat", message: "Your Personal Access Token" }],
  });
  expect(pat.category).toBe("secret");
  expect(requiresSecretInput(pat.prompts)).toBe(true);
  expect(requiresFormInput(pat.prompts)).toBe(true);
});

test("a select alone is not a form: ZCode's team method still opens a browser", () => {
  const team = classifyMethod({
    type: "oauth",
    label: "ZCode: a team's GLM Coding Plan",
    hasAuthorize: true,
    prompts: [
      {
        type: "select",
        key: "site",
        message: "Where is the team's plan?",
        options: [{ label: "Z.ai", value: "zai" }],
      },
    ],
  });
  expect(team.category).toBe("pending");
  expect(requiresFormInput(team.prompts)).toBe(false);
});

test("the scan projects the prompts of every method it reports", () => {
  const scan = normalizeScan({
    available: true,
    providers: [
      {
        id: "kiro",
        package: "@magpie-community/opencode-kiro-auth",
        methods: [
          {
            type: "oauth",
            label: "Kiro (Google, GitHub, AWS Builder ID)",
            hasAuthorize: true,
            prompts: [
              { type: "text", key: "region", message: "AWS region", placeholder: "us-east-1" },
            ],
          },
        ],
      },
    ],
  });
  const method = scan.providers[0].methods[0];
  expect(method.category).toBe("form");
  expect(method.prompts).toEqual([
    { type: "text", key: "region", message: "AWS region", options: [] },
  ]);
  expect(JSON.stringify(scan)).not.toContain("placeholder");
  expect(JSON.stringify(scan)).not.toContain("us-east-1");
});

// ---------- change 2: the real flow, from authorize() ----------

test("classifyAuthorizedFlow names ZCode's browser flow", () => {
  const authorized = {
    url: "https://zcode.example/oauth/cli/authorize?flow_id=abc",
    instructions: "Sign in to Z.ai in the browser; this finishes on its own.",
    method: "auto",
  };
  expect(classifyAuthorizedFlow(authorized)).toEqual({
    category: "browser",
    url: authorized.url,
    instructions: authorized.instructions,
  });
});

// The real instruction strings, read out of the installed plugins, so a change
// in one of them is caught here rather than in a broken sign-in.
test("classifyAuthorizedFlow reads the real plugin instructions", () => {
  const real = [
    {
      what: "ZCode: Z.ai / BigModel",
      authorized: {
        url: "https://zcode.example/oauth/cli/authorize?flow_id=1",
        instructions: "Sign in to Z.ai in the browser; this finishes on its own.",
      },
      category: "browser",
    },
    {
      what: "Qoder's device code",
      authorized: {
        url: "https://qoder.com/device/selectAccounts?challenge=x",
        instructions: "Sign in to Qoder in the browser and authorize this device",
      },
      category: "device",
    },
    {
      what: "MiniMax Code's device code",
      authorized: {
        url: "https://minimax.example/device?user_code=1234",
        instructions:
          "Sign in to MiniMax Code in the browser and confirm the code 1234; this finishes by itself.",
      },
      category: "device",
    },
    {
      what: "Kiro's sign-in page",
      authorized: {
        url: "https://kiro.example/signin?state=x",
        instructions:
          "Sign in to Kiro with Google, GitHub, AWS Builder ID or IAM Identity Center.",
      },
      category: "browser",
    },
    {
      what: "ZCode's own app session",
      authorized: {
        url: "",
        instructions:
          "Uses the account the ZCode app is signed in to, and follows it while ZCode stays signed in to that account.",
      },
      category: "local",
    },
    {
      what: "Kiro CLI's or IDE's own session",
      authorized: {
        url: "",
        instructions: "Uses the account kiro-cli or the Kiro IDE is signed in to.",
      },
      category: "local",
    },
    {
      what: "Command Code's CLI session",
      authorized: {
        url: "",
        instructions: "Uses the account in /home/me/.commandcode/auth.json.",
      },
      category: "local",
    },
  ];
  for (const entry of real) {
    expect(classifyAuthorizedFlow(entry.authorized).category).toBe(entry.category);
  }
});

test("classifyAuthorizedFlow names a device-code flow", () => {
  const qoder = {
    url: "https://qoder.com/device/selectAccounts?challenge=x",
    instructions: "Sign in to Qoder in the browser and authorize this device",
  };
  expect(classifyAuthorizedFlow(qoder).category).toBe("device");
  const minimax = {
    url: "https://minimax.example/device?user_code=1234",
    instructions: "Sign in to MiniMax Code in the browser and confirm the code 1234; this finishes by itself.",
  };
  expect(classifyAuthorizedFlow(minimax).category).toBe("device");
});

test("classifyAuthorizedFlow names a local session that has no URL", () => {
  const zcodeApp = {
    url: "",
    instructions: "Uses the account the ZCode app is signed in to, and follows it while ZCode stays signed in to that account.",
  };
  // No URL and no instruction at all is the plainest local reuse.
  expect(classifyAuthorizedFlow({ url: "", instructions: "" }).category).toBe("local");
  expect(classifyAuthorizedFlow({}).category).toBe("local");
  // A URL-less flow that names an already-signed-in account is a local session,
  // NOT a fill-in form. This was the bug: every real local-session plugin
  // returns exactly this shape.
  expect(classifyAuthorizedFlow(zcodeApp).category).toBe("local");
});

// The exact `instructions` every real local-session plugin returns, read out of
// the installed packages under ~/.config/magpie/plugins/node_modules. They are
// all url-less; NONE of them may be called a form.
const REAL_LOCAL_SESSION_INSTRUCTIONS = [
  {
    package: "@magpie-community/opencode-commandcode-auth",
    instructions: "Uses the account in /root/.commandcode/auth.json.",
  },
  {
    package: "@magpie-community/opencode-cursor-auth",
    instructions: "Uses the account `cursor-agent login` signed in to.",
  },
  {
    package: "@magpie-community/opencode-devin-auth",
    instructions: "Uses the account in /root/.local/share/devin/credentials.toml.",
  },
  {
    package: "@magpie-community/opencode-kiro-auth",
    instructions: "Uses the account kiro-cli or the Kiro IDE is signed in to.",
  },
  {
    package: "@magpie-community/opencode-workbuddy-auth (AI desktop)",
    instructions: "Uses the account WorkBuddy AI desktop is signed in to.",
  },
  {
    package: "@magpie-community/opencode-workbuddy-auth (desktop)",
    instructions: "Uses the account WorkBuddy desktop is signed in to.",
  },
  {
    package: "@magpie-community/opencode-zcode-auth",
    instructions:
      "Uses the account the ZCode app is signed in to, and follows it while ZCode stays signed in to that account.",
  },
];

test("every real local-session instruction is a local session, never a form", () => {
  expect(REAL_LOCAL_SESSION_INSTRUCTIONS.length).toBe(7);
  for (const entry of REAL_LOCAL_SESSION_INSTRUCTIONS) {
    const result = classifyAuthorizedFlow({ url: "", instructions: entry.instructions });
    expect(result.category).toBe("local");
    expect(result.category).not.toBe("form");
    // A browser page is never claimed without a url.
    expect(result.category).not.toBe("browser");
  }
});

test("a URL-less method is a form only when it declares a typed prompt", () => {
  // Loomy's phone-code flow really is a fill-in form: it declares a text prompt.
  const loomy = classifyAuthorizedFlow(
    { url: "", instructions: "Enter the phone number that receives a code." },
    { prompts: [{ type: "text", key: "phone", message: "Phone number" }] },
  );
  expect(loomy.category).toBe("form");
  // Qoder's PAT is a pasted secret, told apart from a plain form.
  const qoderPat = classifyAuthorizedFlow(
    { url: "", instructions: "Paste your Qoder personal access token." },
    { prompts: [{ type: "password", key: "pat", message: "Personal Access Token" }] },
  );
  expect(qoderPat.category).toBe("secret");
  // Kiro's Start URL form is a form when authorize() returns no url.
  const kiro = classifyAuthorizedFlow(
    { url: "", instructions: "Fill in the Start URL and region." },
    {
      prompts: [
        { type: "select", key: "loginMethod", message: "Choose a method", options: [] },
        { type: "text", key: "startUrl", message: "Organization Start URL" },
        { type: "text", key: "region", message: "AWS region" },
      ],
    },
  );
  expect(kiro.category).toBe("form");
  // A select alone is not a form: the local-session reading still wins.
  const selectOnly = classifyAuthorizedFlow(
    { url: "", instructions: "Uses the account the app is signed in to." },
    { prompts: [{ type: "select", key: "site", message: "Pick a site", options: [] }] },
  );
  expect(selectOnly.category).toBe("local");
});

test("classifyAuthorizedFlow never calls a URL-less CLI flow a browser", () => {
  const cli = {
    url: "",
    instructions: "Uses the account in /home/me/.commandcode/auth.json.",
  };
  expect(classifyAuthorizedFlow(cli).category).toBe("local");
  expect(classifyAuthorizedFlow(cli).category).not.toBe("browser");
  expect(classifyAuthorizedFlow(cli).category).not.toBe("form");
});

test("classifyAuthorizedFlow degrades to unknown for junk", () => {
  for (const value of [null, undefined, 42, "text", true]) {
    expect(classifyAuthorizedFlow(value)).toEqual({ category: "unknown", url: "", instructions: "" });
  }
});

test("a silent URL still counts as a browser page", () => {
  expect(classifyAuthorizedFlow({ url: "https://provider.example/oauth" }).category).toBe("browser");
});

test("chooseBrowserMethod can be told which method to use", () => {
  const zai = { type: "oauth", label: "ZCode: Z.ai GLM Coding Plan", authorize: async () => {} };
  const bigmodel = {
    type: "oauth",
    label: "ZCode: BigModel (智谱) GLM Coding Plan",
    authorize: async () => {},
  };
  const local = { type: "oauth", label: "ZCode app's sign-in", authorize: async () => {} };
  const methods = [zai, bigmodel, local];
  // Without a preference the old first-match behavior is unchanged.
  expect(chooseBrowserMethod(methods)).toBe(zai);
  // With a label the exact method wins, never the first one.
  expect(chooseBrowserMethod(methods, "ZCode: BigModel (智谱) GLM Coding Plan")).toBe(bigmodel);
  // With the method object itself it is that method.
  expect(chooseBrowserMethod(methods, bigmodel)).toBe(bigmodel);
  // A label that matches nothing is a mismatch, not a silent fallback.
  expect(chooseBrowserMethod(methods, "ZCode: nope")).toBeNull();
  // A local method is never chosen, not even by name.
  expect(chooseBrowserMethod(methods, "ZCode app's sign-in")).toBeNull();
});

test("the flow reports the real method category after authorize() ran", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clean-login-classify-"));
  try {
    const controller = createSignInFlow({
      env: { MAGPIE_CLEAN_LOGIN_DATA: dir },
      client: { auth: { set: async () => {} } },
      readKeys: () => new Set(),
      readEntries: () => ({}),
      identityGenerator: async () => ({ tag: "pin" }),
      loadProvider: async () => ({
        methods: [
          {
            type: "oauth",
            label: "ZCode: Z.ai GLM Coding Plan",
            authorize: async () => ({
              url: "https://zcode.example/authorize",
              instructions: "Sign in to Z.ai in the browser; this finishes on its own.",
              callback: async () => ({
                type: "success",
                provider: "zcode",
                refresh: "R",
                access: "A",
                expires: 1,
                accountId: "me",
              }),
            }),
          },
        ],
      }),
      launchBrowser: async () => ({ pid: 1, close: async () => {} }),
      resolveExecutable: async () => "/fake/browser",
    });
    const started = await controller.startSignIn({ provider: "zcode" });
    expect(started.url).toBe("https://zcode.example/authorize");
    expect(controller.status().methodCategory).toBe("browser");
    await controller.whenSettled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the flow signs in with the method the caller asked for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clean-login-classify-"));
  try {
    const seen = [];
    const controller = createSignInFlow({
      env: { MAGPIE_CLEAN_LOGIN_DATA: dir },
      client: { auth: { set: async () => {} } },
      readKeys: () => new Set(),
      readEntries: () => ({}),
      identityGenerator: async () => ({ tag: "pin" }),
      loadProvider: async () => ({
        methods: [
          {
            type: "oauth",
            label: "ZCode: Z.ai GLM Coding Plan",
            authorize: async () => {
              seen.push("zai");
              return { url: "https://zcode.example/zai", instructions: "browser", callback: async () => ({ type: "success" }) };
            },
          },
          {
            type: "oauth",
            label: "ZCode: BigModel (智谱) GLM Coding Plan",
            authorize: async () => {
              seen.push("bigmodel");
              return { url: "https://zcode.example/bigmodel", instructions: "browser", callback: async () => ({ type: "success" }) };
            },
          },
        ],
      }),
      launchBrowser: async () => ({ pid: 1, close: async () => {} }),
      resolveExecutable: async () => "/fake/browser",
    });
    const started = await controller.startSignIn({
      provider: "zcode",
      methodLabel: "ZCode: BigModel (智谱) GLM Coding Plan",
    });
    expect(started.url).toBe("https://zcode.example/bigmodel");
    expect(seen).toEqual(["bigmodel"]);
    await controller.whenSettled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- change 3: the honest card markers ----------

const ZCODE_METHODS = [
  {
    type: "oauth",
    label: "ZCode: Z.ai GLM Coding Plan",
    browser: false,
    category: "pending",
    runnable: true,
  },
  {
    type: "oauth",
    label: "ZCode: BigModel (智谱) GLM Coding Plan",
    browser: false,
    category: "pending",
    runnable: true,
  },
  {
    type: "oauth",
    label: "ZCode: a team's GLM Coding Plan",
    browser: false,
    category: "pending",
    runnable: true,
    prompts: [
      { type: "select", key: "site", message: "Where is the team's plan?", options: [] },
    ],
  },
  { type: "oauth", label: "ZCode app's sign-in", browser: false, category: "local", runnable: true },
  { type: "api", label: "GLM Coding Plan API key", browser: false, category: "key", runnable: false },
];

test("ZCode's three oauth methods are no longer reported as unknown", () => {
  const view = mergeProviderSources({
    local: [],
    magpie: ["zcode"],
    plugins: {
      available: true,
      providers: [{ id: "zcode", package: "@magpie-community/opencode-zcode-auth", methods: ZCODE_METHODS }],
    },
  });
  const zcode = view.providers.find((provider) => provider.id === "zcode");
  const methods = zcode.authMethods;
  // None of the three browser flows is called "unknown" in the sense of
  // "nothing was found": the card says the kind is confirmed at sign-in time.
  expect(methods[0].category).toBe("pending");
  expect(zcode.unconfirmedMethod).toBe(true);
  expect(zcode.primaryCategory).toBe("pending");
  expect(zcode.signableMethod).toBe(true);
  expect(zcode.capability.reason.en).toContain("only known when the sign-in actually starts");
  expect(zcode.capability.reason.en).not.toContain("exposes a browser sign-in method");
  for (const lang of ["en", "zh-Hans", "zh-Hant", "ja"]) {
    expect(zcode.capability.reason[lang]).toBeTruthy();
  }
  // The local session and the API key keep their own kinds.
  expect(methodCategory(methods[3])).toBe("local");
  expect(methodCategory(methods[4])).toBe("key");
});

test("the card markers are told apart", () => {
  const text = {
    providerMethodBrowserTag: "browser",
    providerMethodDeviceTag: "device code",
    providerMethodFormTag: "needs details",
    providerMethodKeyTag: "key",
    providerMethodLocalTag: "local session",
    providerMethodSecretTag: "paste a token",
    providerMethodUnknownTag: "way to confirm",
  };
  expect(methodCategoryText("browser", text)).toBe("browser");
  expect(methodCategoryText("device", text)).toBe("device code");
  expect(methodCategoryText("form", text)).toBe("needs details");
  expect(methodCategoryText("key", text)).toBe("key");
  expect(methodCategoryText("local", text)).toBe("local session");
  expect(methodCategoryText("secret", text)).toBe("paste a token");
  expect(methodCategoryText("unknown", text)).toBe("way to confirm");
  // Every kind gets its own marker; none of them falls through to another.
  const kinds = ["browser", "device", "form", "key", "local", "secret", "unknown"];
  expect(new Set(kinds.map((kind) => methodCategoryText(kind, text))).size).toBe(kinds.length);
});

test("the backend's confirmed device category maps to the device-code marker", () => {
  // The sign-in flow reports `device` for a real device code (Qoder, MiniMax
  // Code). methodCategory() must keep that instead of degrading it to unknown.
  expect(methodCategory({ category: "device" })).toBe("device");
  expect(methodCategory({ type: "oauth", category: "device" })).toBe("device");
  expect(methodCategoryText("device", {})).toBe("device code");
});

test("a form method and a pasted-key method are not called unknown", () => {
  const view = mergeProviderSources({
    local: [],
    magpie: ["kiro", "qoder"],
    plugins: {
      available: true,
      providers: [
        {
          id: "kiro",
          package: "@magpie-community/opencode-kiro-auth",
          methods: [
            {
              type: "oauth",
              label: "Kiro (Google, GitHub, AWS Builder ID, IAM Identity Center)",
              browser: false,
              category: "form",
              runnable: true,
              prompts: [{ type: "text", key: "startUrl", message: "Organization Start URL", options: [] }],
            },
          ],
        },
        {
          id: "qoder",
          package: "@magpie-community/opencode-qoder-auth",
          methods: [
            {
              type: "oauth",
              label: "Sign in with Qoder PAT",
              browser: false,
              category: "secret",
              runnable: true,
              prompts: [{ type: "password", key: "pat", message: "Your Personal Access Token", options: [] }],
            },
          ],
        },
      ],
    },
  });
  const kiro = view.providers.find((provider) => provider.id === "kiro");
  const qoder = view.providers.find((provider) => provider.id === "qoder");
  expect(kiro.primaryCategory).toBe("form");
  expect(kiro.formMethod).toBe(true);
  expect(kiro.capability.reason.en).toContain("needs details typed in");
  expect(qoder.primaryCategory).toBe("secret");
  expect(qoder.secretMethod).toBe(true);
  expect(qoder.capability.reason.en).toContain("asks for a secret you paste in");
});

// ---------- change 4: the method choice ----------

test("a plugin with several runnable oauth methods offers a choice", () => {
  const view = mergeProviderSources({
    local: [],
    magpie: ["zcode"],
    plugins: {
      available: true,
      providers: [{ id: "zcode", package: "@magpie-community/opencode-zcode-auth", methods: ZCODE_METHODS }],
    },
  });
  const zcode = view.providers.find((provider) => provider.id === "zcode");
  // Only the runnable, non-local methods are offered: the API key is not a
  // sign-in flow and the local session is not a choice between sites.
  expect(zcode.signInMethods).toEqual([
    "ZCode: Z.ai GLM Coding Plan",
    "ZCode: BigModel (智谱) GLM Coding Plan",
    "ZCode: a team's GLM Coding Plan",
  ]);
});

test("a plugin with a single runnable method offers no choice", () => {
  const view = mergeProviderSources({
    local: [],
    magpie: ["cursor"],
    plugins: {
      available: true,
      providers: [
        {
          id: "cursor",
          package: "@magpie-community/opencode-cursor-auth",
          methods: [
            { type: "oauth", label: "Cursor (browser)", browser: true, category: "browser", runnable: true },
            { type: "oauth", label: "cursor-agent's sign-in", browser: false, category: "local", runnable: true },
          ],
        },
      ],
    },
  });
  const cursor = view.providers.find((provider) => provider.id === "cursor");
  expect(cursor.signInMethods).toEqual(["Cursor (browser)"]);
});
