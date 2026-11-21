"use client";

import { Fragment, type ReactNode } from "react";
import { LocalFileAction } from "./LocalFileAction";
import { isLocalFileToken } from "@/lib/ui/local-file";

const URL_TOKEN_RE = /^https?:\/\/\S+$/i;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}'"»]+$/;

function splitToken(token: string): { core: string; suffix: string } {
  const match = TRAILING_PUNCTUATION_RE.exec(token);
  if (!match) return { core: token, suffix: "" };
  return { core: token.slice(0, token.length - match[0].length), suffix: match[0] };
}

// Plain-text transcript rows (tool steps, delegate turns, raw payloads) keep
// their references usable: web URLs open in a new window and file paths open
// with the OS default app. Prose is preserved verbatim between tokens.
export function LinkifiedText({ text }: { text: string }): ReactNode {
  const parts = text.split(/(\s+)/);
  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null;
        if (/^\s+$/.test(part)) return <Fragment key={index}>{part}</Fragment>;
        const { core, suffix } = splitToken(part);
        if (!core) return <Fragment key={index}>{part}</Fragment>;
        if (URL_TOKEN_RE.test(core)) {
          return (
            <Fragment key={index}>
              <a
                href={core}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-600 dark:text-sky-300 underline decoration-dotted hover:decoration-solid break-all"
              >
                {core}
              </a>
              {suffix}
            </Fragment>
          );
        }
        if (isLocalFileToken(core)) {
          return (
            <Fragment key={index}>
              <LocalFileAction
                href={core}
                showIcon={false}
                className="text-sky-600 dark:text-sky-300"
              >
                {core}
              </LocalFileAction>
              {suffix}
            </Fragment>
          );
        }
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}
