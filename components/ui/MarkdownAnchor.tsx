"use client";

import type { AnchorHTMLAttributes, ReactNode } from "react";
import type { Components } from "react-markdown";
import { parseHref } from "@/lib/ui/navigate";

export type MarkdownAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  /** react-markdown's AST node; stripped before the props reach the DOM. */
  node?: unknown;
};

// Rendered markdown links leave the app in a new window so a click can never
// navigate the SPA away from its state. In-app links (tab/hash/thread routes)
// keep switching in place, and in-app actions (image lightbox, local-file
// preview) keep their own handlers in MessageContent's renderer.
export function MarkdownAnchor({ href, children, ...rest }: MarkdownAnchorProps): ReactNode {
  if (!href) return children;
  const anchorProps = { ...rest };
  delete anchorProps.node;
  const external = parseHref(href).external;
  return (
    <a
      {...anchorProps}
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
    >
      {children}
    </a>
  );
}

/** Components map for plain markdown surfaces (recaps, previews). */
export const MARKDOWN_COMPONENTS: Components = { a: MarkdownAnchor };
