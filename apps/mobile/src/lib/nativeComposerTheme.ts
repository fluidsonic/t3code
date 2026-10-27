import { flattenThemeColor, type MobileThemeVariables } from "./mobileTheme";

/** Native chip parsers need opaque hex instead of CSS rgba or platform-specific alpha order. */
export function createNativeComposerTheme(theme: MobileThemeVariables) {
  const surface = flattenThemeColor(theme["--color-composer-surface"], theme["--color-screen"]);
  // In shell mode the composer carries the shell tint, and the `!` square sits on it.
  const shellSurface = flattenThemeColor(theme["--color-shell-tint"], surface);
  return {
    text: flattenThemeColor(theme["--color-foreground"], surface),
    placeholder: flattenThemeColor(theme["--color-placeholder"], surface),
    shellPrefixFill: flattenThemeColor(theme["--color-shell-prefix"], shellSurface),
    shellPrefixText: flattenThemeColor(theme["--color-shell-prefix-foreground"], shellSurface),
  };
}
