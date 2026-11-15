import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { createWorkspaceFocusController } from "../lib/workspaceFocus";
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

it("keeps keyboard focus on a sidebar row on window return, but not a clicked row", async () => {
  const list = document.createElement("ul");
  const row = (name: string) => {
    const element = document.createElement("div");
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    element.dataset.sidebarRow = name;
    element.textContent = name;
    list.append(element);
    return element;
  };
  const clicked = row("Clicked thread");
  const tabbed = row("Tabbed thread");
  document.body.append(list);
  using _list = { [Symbol.dispose]: () => list.remove() };

  await userEvent.click(clicked);
  expect(document.activeElement).toBe(clicked);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement, false)).toBe(true);

  await userEvent.tab();
  expect(document.activeElement).toBe(tabbed);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement, false)).toBe(false);
});

it("keeps focus in a region with its own keys on window return", async () => {
  const region = document.createElement("div");
  region.tabIndex = -1;
  region.setAttribute("aria-keyshortcuts", "J K");
  region.textContent = "Guide prose";
  document.body.append(region);
  using _region = { [Symbol.dispose]: () => region.remove() };

  await userEvent.click(region);
  expect(document.activeElement).toBe(region);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement, false)).toBe(false);
});

it("refocuses the composer on window return from a clicked area after a bare key press", async () => {
  const controller = createWorkspaceFocusController(document);
  const root = document.createElement("div");
  root.innerHTML =
    '<nav data-workspace-area="sidebar" data-workspace-order="0" tabindex="-1"><button>Thread</button></nav>' +
    '<section data-workspace-area="conversation" data-workspace-order="1" tabindex="-1" style="height: 200px"></section>';
  document.body.append(root);
  using _root = {
    [Symbol.dispose]: () => {
      controller.dispose();
      root.remove();
    },
  };
  const conversation = root.querySelector("section")!;

  await userEvent.click(conversation);
  expect(document.activeElement).toBe(conversation);
  // A window switch can deliver a lone modifier key without moving focus.
  await userEvent.keyboard("{Shift}");
  expect(
    shouldRefocusComposerOnWindowFocus(document.activeElement, false),
    "a clicked area counts as reached from the keyboard after a bare key press",
  ).toBe(true);

  await userEvent.keyboard("{F6}");
  controller.move(-1);
  await userEvent.keyboard("{F6}");
  controller.move(1);
  expect(document.activeElement).toBe(conversation);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement, false)).toBe(false);
});
