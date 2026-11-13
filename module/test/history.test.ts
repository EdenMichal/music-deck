import { describe, expect, it, vi } from "vitest";
import { History, type Step } from "../src/history";

function step(log: string[], name: string, fail = false): Step {
  return {
    label: name,
    undo: async () => { if (fail) throw new Error("gone"); log.push(`undo ${name}`); },
    redo: async () => { log.push(`redo ${name}`); },
  };
}

describe("History", () => {
  it("undoes newest first and redoes in reverse", async () => {
    const log: string[] = [];
    const h = new History();
    h.push(step(log, "a"));
    h.push(step(log, "b"));
    expect(h.nextUndo?.label).toBe("b");
    await h.undo();
    await h.undo();
    expect(h.canUndo).toBe(false);
    expect(h.nextRedo?.label).toBe("a");
    await h.redo();
    expect(log).toEqual(["undo b", "undo a", "redo a"]);
    expect(h.nextUndo?.label).toBe("a");
    expect(h.nextRedo?.label).toBe("b");
  });

  it("a new step clears redo", async () => {
    const h = new History();
    h.push(step([], "a"));
    await h.undo();
    h.push(step([], "b"));
    expect(h.canRedo).toBe(false);
  });

  it("keeps only the newest steps", () => {
    const h = new History(2);
    ["a", "b", "c"].forEach(n => h.push(step([], n)));
    expect(h.nextUndo?.label).toBe("c");
  });

  it("drops a step that fails and reports false", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = new History();
    h.push(step([], "a", true));
    expect(await h.undo()).toBe(false);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });

  it("ignores a second undo while one is running, and tells listeners", async () => {
    const changed = vi.fn();
    const h = new History(25, changed);
    h.push(step([], "older"));
    h.push(step([], "newer"));
    const first = h.undo();
    expect(await h.undo()).toBe(false);
    await first;
    expect(h.nextUndo?.label).toBe("older");
    expect(h.nextRedo?.label).toBe("newer");
    expect(changed).toHaveBeenCalledTimes(3);
  });
});
