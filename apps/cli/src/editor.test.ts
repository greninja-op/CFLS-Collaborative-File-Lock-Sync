/**
 * Unit tests for the best-effort editor launcher used by
 * `cfls sync merge <member> --resolve`. The actual spawn is injected so nothing
 * is launched; we assert the command/args construction and the fallback order.
 */

import { describe, expect, it, vi } from "vitest";

import { openInEditor, type Launcher } from "./editor";

describe("openInEditor", () => {
  it("returns null (and launches nothing) for an empty file list", () => {
    const launcher = vi.fn<Launcher>(() => true);
    expect(openInEditor([], "/repo", launcher)).toBeNull();
    expect(launcher).not.toHaveBeenCalled();
  });

  it("opens files with `-r <files>` using the first working editor command", () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const launcher: Launcher = (cmd, args) => {
      calls.push({ cmd, args });
      return cmd === "code";
    };
    const result = openInEditor(["a.ts", "b.ts"], "/repo", launcher);
    expect(result).toBe("code");
    expect(calls[0]).toEqual({ cmd: "code", args: ["-r", "a.ts", "b.ts"] });
  });

  it("falls back to the next command when the first is unavailable", () => {
    const tried: string[] = [];
    const launcher: Launcher = (cmd) => {
      tried.push(cmd);
      return cmd === "kiro";
    };
    expect(openInEditor(["x.ts"], "/repo", launcher)).toBe("kiro");
    expect(tried).toEqual(["code", "kiro"]);
  });

  it("returns null when no editor command succeeds", () => {
    const launcher: Launcher = () => false;
    expect(openInEditor(["x.ts"], "/repo", launcher)).toBeNull();
  });
});
