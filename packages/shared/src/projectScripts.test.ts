import { describe, expect, it } from "vite-plus/test";

import { canEditInTerminal } from "./projectScripts.ts";

describe("canEditInTerminal", () => {
  it("allows only a single line, which can't run before Enter", () => {
    expect(canEditInTerminal("git push --force-with-lease")).toBe(true);
    expect(canEditInTerminal("cd app\nvp i")).toBe(false);
    expect(canEditInTerminal("cd app\r\nvp i")).toBe(false);
    expect(canEditInTerminal("echo done\r")).toBe(false);
  });
});
