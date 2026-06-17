import { describe, it, expect } from "vitest";
import { narrationRequestsCheck } from "./checkDetect";

describe("narrationRequestsCheck", () => {
  it("detects the exact bug: a prose Deception check with no tool call", () => {
    expect(
      narrationRequestsCheck(
        "To sell the bluff and make the window escape before the guards recover, Ren needs to attempt a Deception check.",
      ),
    ).toBe(true);
  });

  it("detects common skill-check phrasings", () => {
    expect(narrationRequestsCheck("Make a Stealth check to slip past the sleeping guard.")).toBe(true);
    expect(narrationRequestsCheck("Roll an Insight check.")).toBe(true);
    expect(narrationRequestsCheck("Give me a Perception check, everyone.")).toBe(true);
  });

  it("detects saving throws and ability saves", () => {
    expect(narrationRequestsCheck("This calls for a Wisdom saving throw.")).toBe(true);
    expect(narrationRequestsCheck("She must make a DC 15 Dexterity save.")).toBe(true);
  });

  it("detects a check requested without an explicit verb (the game term alone)", () => {
    expect(narrationRequestsCheck("A Perception check is needed before you can spot the tripwire.")).toBe(true);
  });

  it("is case-insensitive and sees through markdown + voice tags", () => {
    expect(narrationRequestsCheck("make a deception check")).toBe(true);
    expect(
      narrationRequestsCheck("**Ren** needs to attempt a **Deception** check to fool them."),
    ).toBe(true);
    expect(
      narrationRequestsCheck('[[GM|neutral]]"Give me a stealth check."[[/]]'),
    ).toBe(true);
  });

  it("does NOT fire on incidental uses of 'check' or 'save'", () => {
    expect(narrationRequestsCheck("You make camp and check your supplies before nightfall.")).toBe(false);
    expect(narrationRequestsCheck("No check is needed; you slip past with ease.")).toBe(false);
    expect(narrationRequestsCheck("The party makes their way to the checkpoint at the city gate.")).toBe(false);
    expect(narrationRequestsCheck("Orin saves his last arrow for the wolf.")).toBe(false);
  });

  it("does NOT fire on plain narration with no check", () => {
    expect(narrationRequestsCheck("The torchlight flickers across the damp stone walls as you descend.")).toBe(false);
    expect(narrationRequestsCheck("")).toBe(false);
  });
});
