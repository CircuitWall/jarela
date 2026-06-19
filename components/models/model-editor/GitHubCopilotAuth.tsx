import { Button } from "@/components/ui/Button";
import { useGitHubCopilotAuth, type DeviceFlow, type GhCopilotState } from "./useGitHubCopilotAuth";

export function GitHubCopilotAuth() {
  const auth = useGitHubCopilotAuth();
  return (
    <div className="p-2.5 rounded-lg bg-surface-3 border border-border text-xs space-y-2">
      <AuthHeader status={auth.status} polling={auth.polling} onSignIn={auth.startSignIn} onSignOut={auth.signOut} />
      {auth.status?.signed_in && !auth.flow && <ConnectedLine status={auth.status} />}
      {auth.flow && <DeviceFlowBlock flow={auth.flow} />}
      {auth.message && <p className="text-emerald-700 dark:text-emerald-400">{auth.message}</p>}
      {auth.error && <p className="text-red-700 dark:text-red-400">{auth.error}</p>}
    </div>
  );
}

interface HeaderProps {
  status: GhCopilotState | null;
  polling: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
}

function AuthHeader({ status, polling, onSignIn, onSignOut }: HeaderProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="text-fg-muted">
        <strong>GitHub Copilot sign-in</strong>
        <p className="text-fg-faint mt-0.5">
          Unlocks full model context windows (vs. the 8k cap on raw PATs via GitHub Models).
        </p>
      </div>
      {status?.signed_in ? (
        <button onClick={onSignOut} className="px-2 py-1 text-[11px] bg-surface text-fg-muted hover:text-red-700 dark:hover:text-red-300 rounded border border-border whitespace-nowrap">
          Sign out
        </button>
      ) : (
        <Button
          onClick={onSignIn}
          disabled={polling}
          size="sm"
          className="whitespace-nowrap"
        >
          {polling ? "Waiting…" : "Sign in"}
        </Button>
      )}
    </div>
  );
}

function ConnectedLine({ status }: { status: GhCopilotState }) {
  return (
    <p className="text-emerald-700 dark:text-emerald-400">
      Connected{status.stored_at ? ` · ${new Date(status.stored_at).toLocaleString()}` : ""}
    </p>
  );
}

function DeviceFlowBlock({ flow }: { flow: DeviceFlow }) {
  return (
    <div className="rounded bg-surface p-2 border border-border space-y-1.5">
      <p className="text-fg-subtle">
        1. Open{" "}
        <a href={flow.verification_uri} target="_blank" rel="noreferrer" className="text-accent underline">
          {flow.verification_uri}
        </a>
      </p>
      <p className="text-fg-subtle">2. Enter this code:</p>
      <div className="flex items-center gap-2">
        <code className="px-2 py-1 bg-surface-2 rounded font-mono text-fg text-sm tracking-wider">
          {flow.user_code}
        </code>
        <button
          onClick={() => { void navigator.clipboard.writeText(flow.user_code).catch(() => {}); }}
          className="text-[10px] text-fg-subtle hover:text-fg"
        >
          Copy
        </button>
      </div>
    </div>
  );
}
