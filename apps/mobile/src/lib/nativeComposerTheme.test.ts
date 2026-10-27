import { describe, expect, it } from "vite-plus/test";

import { getMobileThemeVariables } from "./mobileTheme";
import { createNativeComposerTheme } from "./nativeComposerTheme";

describe("native composer colors", () => {
  it("flattens Material You alpha colors over the composer rather than falling back to defaults", () => {
    const theme = createNativeComposerTheme({
      ...getMobileThemeVariables("t3-code", "light"),
      "--color-screen": "#ffffffff",
      "--color-composer-surface": "#ffffffff",
      "--color-placeholder": "#0000009e",
    });
    expect(theme.placeholder).toBe("#616161");
  });

  it("gives the native `!` square opaque violet colors in both appearances", () => {
    for (const appearance of ["light", "dark"] as const) {
      const theme = createNativeComposerTheme(getMobileThemeVariables("t3-code", appearance));
      expect(theme.shellPrefixFill).toMatch(/^#[\da-f]{6}$/);
      expect(theme.shellPrefixText).toMatch(/^#[\da-f]{6}$/);
    }
  });
});
