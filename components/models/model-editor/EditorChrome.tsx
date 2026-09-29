import type React from "react";
import { Dialog } from "@/components/ui/Dialog";

interface Props {
  title: string;
  wide: boolean;
  onClose: () => void;
  expertToggle: React.ReactNode | null;
  children: React.ReactNode;
  footer: React.ReactNode;
  overlays?: React.ReactNode;
}

export function EditorChrome({ title, wide, onClose, expertToggle, children, footer, overlays }: Props) {
  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={title}
        size={wide ? "xl" : "lg"}
        align="top"
        padded={false}
        footer={footer}
      >
        <div className="p-4 space-y-3.5">
          {expertToggle}
          {children}
        </div>
      </Dialog>
      {overlays}
    </>
  );
}
