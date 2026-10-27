import { describe, expect, it } from "vite-plus/test";

import { isFocusTakingPressTarget, shouldRefocusComposerOnWindowFocus } from "./ChatView.logic";

/** Whether the composer takes focus back after a press on the marked element returned the window. */
const refocusesAfterPressOn = (html: string) => {
  const host = document.createElement("div");
  host.innerHTML = html;
  const pressed = host.querySelector("[data-pressed]")!;
  return shouldRefocusComposerOnWindowFocus(document.body, isFocusTakingPressTarget(pressed));
};

describe("shouldRefocusComposerOnWindowFocus", () => {
  it("leaves focus to a control whose press returned the window", () => {
    // A menu trigger pressed from inside the browser page opens a menu that takes
    // focus a frame later; refocusing the composer would close it.
    expect(refocusesAfterPressOn(`<button><svg data-pressed></svg></button>`)).toBe(false);
    expect(refocusesAfterPressOn(`<div aria-haspopup="menu" data-pressed></div>`)).toBe(false);
    expect(refocusesAfterPressOn(`<div role="menuitem" data-pressed></div>`)).toBe(false);
    expect(refocusesAfterPressOn(`<a href="/thread"><span data-pressed></span></a>`)).toBe(false);
  });

  it("returns focus to the composer after a press on empty space or text", () => {
    expect(refocusesAfterPressOn(`<div><p data-pressed>Message</p></div>`)).toBe(true);
    // Only scripts focus it, so a press there chose nothing.
    expect(refocusesAfterPressOn(`<div tabindex="-1" data-pressed></div>`)).toBe(true);
  });
});
