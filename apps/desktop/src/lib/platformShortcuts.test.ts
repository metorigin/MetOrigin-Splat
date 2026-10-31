import { describe, expect, it } from "vitest";
import { hasPrimaryModifier, isMacPlatform, isWindowsPlatform } from "./platformShortcuts";

describe("platform navigation shortcuts", () => {
  const control = { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
  const command = { ...control, ctrlKey: false, metaKey: true };

  it("identifies Windows explicitly instead of treating every non-Mac platform as Windows", () => {
    for (const platform of ["Win32", "Win64", "win32"]) {
      expect(isWindowsPlatform(platform)).toBe(true);
    }
    for (const platform of ["MacIntel", "Darwin", "Linux x86_64", "Linux aarch64", ""]) {
      expect(isWindowsPlatform(platform)).toBe(false);
    }
  });

  it("uses Command on WKWebView Macs and Control on Windows/Linux", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(hasPrimaryModifier(command, "MacIntel")).toBe(true);
    expect(hasPrimaryModifier(control, "MacIntel")).toBe(false);
    for (const platform of ["Win32", "Linux x86_64"]) {
      expect(hasPrimaryModifier(control, platform)).toBe(true);
      expect(hasPrimaryModifier(command, platform)).toBe(false);
    }
  });

  it("does not consume different modifier chords", () => {
    expect(hasPrimaryModifier({ ...command, shiftKey: true }, "MacIntel")).toBe(false);
    expect(hasPrimaryModifier({ ...control, altKey: true }, "Win32")).toBe(false);
    expect(hasPrimaryModifier({ ...command, ctrlKey: true }, "MacIntel")).toBe(false);
  });
});
