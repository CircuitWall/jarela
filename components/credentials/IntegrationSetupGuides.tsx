"use client";

import dynamic from "next/dynamic";
import { useState, type ComponentType } from "react";

const loading = () => <p role="status" className="px-3 py-2.5">Loading setup guide...</p>;
const GmailContent = dynamic(() => import("./IntegrationSetupGuideContent").then((m) => m.GmailSetupGuideContent), { loading });
const OutlookContent = dynamic(() => import("./IntegrationSetupGuideContent").then((m) => m.OutlookSetupGuideContent), { loading });
const ClaudeContent = dynamic(() => import("./IntegrationSetupGuideContent").then((m) => m.ClaudeCodeSetupGuideContent), { loading });

function SetupGuide({ Content, title = "Setup guide (first-time only)" }: { Content: ComponentType; title?: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <details className="rounded border border-border/60 bg-surface-3/40 text-xs text-fg-muted"
      onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-fg hover:bg-surface-3">
        {title}
      </summary>
      {opened && <Content />}
    </details>
  );
}

export function GmailSetupGuide() {
  return <SetupGuide Content={GmailContent} />;
}

export function OutlookSetupGuide() {
  return <SetupGuide Content={OutlookContent} />;
}

export function ClaudeCodeSetupGuide() {
  return <SetupGuide Content={ClaudeContent} title="Setup guide" />;
}
