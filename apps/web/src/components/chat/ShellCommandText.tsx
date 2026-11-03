import { cn } from "~/lib/utils";

/**
 * A `! cmd` shell command as the person wrote it, with the `!` drawn as in the composer. `block`
 * lines a multi-line command up under its first line; inline suits single-line previews.
 */
export function ShellCommandText(props: { readonly command: string; readonly block?: boolean }) {
  return (
    <span className={cn("font-mono", props.block && "shell-command-text relative block")}>
      {/* The space is real, so copying the command gives `! cmd`. */}
      <span className="shell-command-lead">
        <span className="shell-command-prefix">!</span>
        <span className="shell-command-gap"> </span>
      </span>
      {props.command}
    </span>
  );
}

/** A faint violet tint over the composer in shell mode and over a sent command. */
export const SHELL_COMMAND_TINT =
  "relative *:relative before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:bg-shell-command-tint";
