import { describe, expect, test } from "bun:test";
import {
  accountView,
  filterAccounts,
  formatCheckSummary,
  formatExit,
  sortAccounts,
} from "../ui/account-view.js";

describe("accountView", () => {
  test("normalizes a full account record", () => {
    const raw = {
      provider: "workbuddy",
      providerLabel: "WorkBuddy",
      key: "workbuddy#1",
      accountId: "Demo Account",
      uid: "u-101",
      signedIn: true,
      signedInAt: "2026-11-03T10:00:00.000Z",
      note: "Primary dev seat",
      fingerprint: { id: "29a8·6643526f", pinnedAt: "2026-11-02T08:00:00.000Z" },
      lastLogin: { at: "2026-11-03T10:00:00.000Z", proxyId: "px1", proxyName: "01", region: "HK" },
      checks: [
        { grade: "A", at: "2026-11-03T11:00:00.000Z", proxyName: "HK · 01", exposure: 0, summary: ["Clean"] },
      ],
      unverified: false,
    };

    const view = accountView(raw);
    expect(view.name).toBe("Demo Account");
    expect(view.provider).toBe("workbuddy");
    expect(view.providerLabel).toBe("WorkBuddy");
    expect(view.key).toBe("workbuddy#1");
    expect(view.uid).toBe("u-101");
    expect(view.signedIn).toBe(true);
    expect(view.signedInAt).toBe("2026-11-03T10:00:00.000Z");
    expect(view.note).toBe("Primary dev seat");
    expect(view.fingerprint).toEqual({ id: "29a8·6643526f", pinnedAt: "2026-11-02T08:00:00.000Z" });
    expect(view.lastLogin).toEqual(raw.lastLogin);
    expect(view.lastCheck).toEqual(raw.checks[0]);
    expect(view.checks).toEqual(raw.checks);
    expect(view.unverified).toBe(false);
  });

  test("handles empty or missing fields with safe defaults", () => {
    const view = accountView({});
    expect(view.name).toBe("");
    expect(view.provider).toBe("");
    expect(view.providerLabel).toBe("");
    expect(view.key).toBe("");
    expect(view.uid).toBe("");
    expect(view.signedIn).toBe(false);
    expect(view.signedInAt).toBe("");
    expect(view.note).toBe("");
    expect(view.fingerprint).toEqual({ id: null, pinnedAt: null });
    expect(view.lastLogin).toBeNull();
    expect(view.lastCheck).toBeNull();
    expect(view.checks).toEqual([]);
    expect(view.unverified).toBe(false);

    expect(accountView(null).name).toBe("");
  });

  test("falls back from name to accountId, then uid, then key", () => {
    expect(accountView({ name: "Explicit Name", accountId: "AccId", key: "k1" }).name).toBe("Explicit Name");
    expect(accountView({ accountId: "AccId", key: "k1" }).name).toBe("AccId");
    expect(accountView({ accountId: "", uid: "uid1", key: "k1" }).name).toBe("uid1");
    expect(accountView({ accountId: "", uid: "", key: "k1" }).name).toBe("k1");
  });
});

describe("formatExit", () => {
  test("formats exit combinations correctly", () => {
    expect(formatExit(null)).toBe("直连");
    expect(formatExit(null, "Direct")).toBe("Direct");
    expect(formatExit({ proxyId: null })).toBe("直连");
    expect(formatExit({ proxyId: null }, "Direct")).toBe("Direct");
    expect(formatExit({ region: "香港", proxyName: "01" })).toBe("香港 · 01");
    expect(formatExit({ region: "香港", proxyName: "香港 · 01" })).toBe("香港 · 01");
    expect(formatExit({ region: "SG", proxyName: "Node A" })).toBe("SG · Node A");
    expect(formatExit({ proxyName: "US East" })).toBe("US East");
    expect(formatExit({ region: "Tokyo" })).toBe("Tokyo");
    expect(formatExit({ proxyName: "直连" })).toBe("直连");
  });
});

describe("formatCheckSummary", () => {
  test("produces summary lines with exposure count header", () => {
    expect(formatCheckSummary(null)).toEqual([]);
    expect(formatCheckSummary({
      exposure: 2,
      summary: ["Line 1", "Line 2"],
    })).toEqual([
      "2 处可能暴露你",
      "Line 1",
      "Line 2",
    ]);

    expect(formatCheckSummary({
      exposure: 0,
      summary: ["Site saw nothing wrong"],
    })).toEqual([
      "站点没有标出任何矛盾",
      "Site saw nothing wrong",
    ]);

    expect(formatCheckSummary({
      summary: ["Plain summary line"],
    })).toEqual([
      "Plain summary line",
    ]);
  });
});

describe("filterAccounts", () => {
  const accounts = [
    { provider: "workbuddy", key: "wb#1", accountId: "Alpha", signedIn: true, note: "lead" },
    { provider: "workbuddy", key: "wb#2", accountId: "Beta", signedIn: false, note: "" },
    { provider: "antigravity", key: "ag#1", accountId: "Gamma", signedIn: false, note: "secondary" },
  ];

  test("filters by signedIn and signedOut", () => {
    expect(filterAccounts(accounts, { filter: "all" }).length).toBe(3);
    expect(filterAccounts(accounts, { filter: "signedIn" }).map((a) => a.key)).toEqual(["wb#1"]);
    expect(filterAccounts(accounts, { filter: "signedOut" }).map((a) => a.key)).toEqual(["wb#2", "ag#1"]);
  });

  test("filters by text query", () => {
    expect(filterAccounts(accounts, { query: "beta" }).map((a) => a.key)).toEqual(["wb#2"]);
    expect(filterAccounts(accounts, { query: "lead" }).map((a) => a.key)).toEqual(["wb#1"]);
    expect(filterAccounts(accounts, { query: "antigravity" }).map((a) => a.key)).toEqual(["ag#1"]);
    expect(filterAccounts(accounts, { query: "nonexistent" })).toEqual([]);
  });

  test("combines filter and query", () => {
    expect(filterAccounts(accounts, { filter: "signedIn", query: "workbuddy" }).map((a) => a.key)).toEqual(["wb#1"]);
    expect(filterAccounts(accounts, { filter: "signedOut", query: "workbuddy" }).map((a) => a.key)).toEqual(["wb#2"]);
  });
});

describe("sortAccounts", () => {
  const accounts = [
    {
      provider: "workbuddy",
      key: "wb#1",
      accountId: "Charlie",
      signedInAt: "2026-11-01T10:00:00.000Z",
      checks: [{ grade: "C", at: "2026-11-01T12:00:00.000Z" }],
    },
    {
      provider: "antigravity",
      key: "ag#1",
      accountId: "Alice",
      signedInAt: "2026-11-03T10:00:00.000Z",
      checks: [{ grade: "A", at: "2026-11-03T12:00:00.000Z" }],
    },
    {
      provider: "codex",
      key: "cx#1",
      accountId: "Bob",
      signedInAt: "2026-11-02T10:00:00.000Z",
      checks: [{ grade: "B", at: "2026-11-02T12:00:00.000Z" }],
    },
    {
      provider: "workbuddy",
      key: "wb#2",
      accountId: "Dave",
      signedInAt: "",
      checks: [],
    },
  ];

  test("sorts by name ascending", () => {
    const sorted = sortAccounts(accounts, "name");
    expect(sorted.map((a) => a.accountId)).toEqual(["Alice", "Bob", "Charlie", "Dave"]);
  });

  test("sorts by provider ascending", () => {
    const sorted = sortAccounts(accounts, "provider");
    expect(sorted.map((a) => a.provider)).toEqual(["antigravity", "codex", "workbuddy", "workbuddy"]);
  });

  test("sorts by grade (A > B > C > D > unrated)", () => {
    const sorted = sortAccounts(accounts, "grade");
    expect(sorted.map((a) => a.accountId)).toEqual(["Alice", "Bob", "Charlie", "Dave"]);
  });

  test("sorts by lastLogin descending (latest first)", () => {
    const sorted = sortAccounts(accounts, "lastLogin");
    expect(sorted.map((a) => a.accountId)).toEqual(["Alice", "Bob", "Charlie", "Dave"]);
  });
});
