import type React from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";

interface ChromeProps {
  title: string;
  variant: "compact" | "full";
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}

export function EditorChrome({ title, variant, onClose, children, footer }: ChromeProps) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size={variant === "full" ? "xl" : "lg"}
      align="top"
      padded={false}
      footer={footer}
    >
      <div className="p-4 space-y-5">{children}</div>
    </Dialog>
  );
}
