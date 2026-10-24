import { AuthTerminalOperateScope, type EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentServerConfig } from "./entities";
import { serverEnvironment } from "./server";
import { readEnvironmentScope, useEnvironmentScope } from "./session";

/**
 * Whether this device can send new `! cmd` shell commands to the environment: terminal access
 * and the environment's opt-in. Commands already in a thread render and stop regardless.
 */
export function useCanRunShellCommands(environmentId: EnvironmentId | null): boolean {
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const config = useEnvironmentServerConfig(environmentId);
  return canOperateTerminal && config?.settings.enableShellCommands === true;
}

export function readCanRunShellCommands(environmentId: EnvironmentId): boolean {
  return (
    readEnvironmentScope(environmentId, AuthTerminalOperateScope) &&
    appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.settings
      .enableShellCommands === true
  );
}
