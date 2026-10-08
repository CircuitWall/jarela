"use client";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { settleConfirm, useActiveConfirm } from "@/lib/ui/confirm";

// Mounted once in AppShell; renders whichever confirmAction() is pending.
export function ConfirmHost() {
  const active = useActiveConfirm();
  if (!active) return null;
  const { id, title, message, confirmLabel, cancelLabel, destructive } = active;
  const cancel = () => settleConfirm(id, false);
  return (
    <Dialog
      open
      onClose={cancel}
      title={title ?? (destructive ? "Are you sure?" : "Confirm")}
      size="sm"
      align="center"
      level="topmost"
      footer={
        <div className="flex justify-end gap-2 px-4 pb-4">
          <Button variant="ghost" onClick={cancel} autoFocus={destructive}>
            {cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={() => settleConfirm(id, true)}
            autoFocus={!destructive}
          >
            {confirmLabel ?? (destructive ? "Delete" : "Confirm")}
          </Button>
        </div>
      }
    >
      <p className="text-sm text-fg-muted whitespace-pre-line">{message}</p>
    </Dialog>
  );
}
