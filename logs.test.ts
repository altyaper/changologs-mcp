import { describe, expect, it } from "vitest";
import { createLog, wantsNewLog } from "./logs.js";

// A fake POST /logs: records the request and answers like LogsController#create_standalone.
function fakeApi() {
  const calls: Array<{ path: string; body: any }> = [];
  const api = async (path: string, options: RequestInit = {}) => {
    const body = JSON.parse(options.body as string);
    calls.push({ path, body });
    return body.daily_note
      ? { log: { hash_id: "daily1", title: "2026-10-23" }, daily_note: true }
      : { log: { hash_id: "new1", title: body.log.title } };
  };
  return { api, calls };
}

describe("wantsNewLog", () => {
  it("follows new_log when given", () => {
    expect(wantsNewLog({ new_log: true })).toBe(true);
    expect(wantsNewLog({ new_log: false, title: "Spec" })).toBe(false);
  });

  it("otherwise takes a title to mean a new log", () => {
    expect(wantsNewLog({ title: "Spec" })).toBe(true);
    expect(wantsNewLog({ title: "  " })).toBe(false);
    expect(wantsNewLog({ text: "a note" })).toBe(false);
    expect(wantsNewLog(undefined)).toBe(false);
  });
});

describe("createLog", () => {
  it("creates a standalone log, opting out of the daily note", async () => {
    const { api, calls } = fakeApi();
    const message = await createLog({ text: "<p>body</p>", title: "Q4 plan", workspace_id: "ws 1" }, api);

    expect(calls).toEqual([{ path: "/logs?workspace_id=ws%201", body: { log: { text: "<p>body</p>", title: "Q4 plan" }, daily_note: false } }]);
    expect(message).toBe('Created log "Q4 plan" (ID: new1)');
  });

  it("titles a new log with today's date when none is given", async () => {
    const { api, calls } = fakeApi();
    await createLog({ text: "body", new_log: true }, api);

    expect(calls[0].body.log.title).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("appends to the daily note without a title, and says so", async () => {
    const { api, calls } = fakeApi();
    const message = await createLog({ text: "quick note" }, api);

    expect(calls).toEqual([{ path: "/logs", body: { log: { text: "quick note" }, daily_note: true } }]);
    expect(message).toBe('Added to today\'s daily note "2026-10-23" (ID: daily1)');
  });
});
