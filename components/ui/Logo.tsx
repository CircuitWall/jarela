"use client";

import type { ImgHTMLAttributes } from "react";
import { getAppLogoLight, getAppLogoDark } from "@/lib/env/app-config";

type LogoProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  alt?: string;
};

// Theme-aware app mark. Renders both color variants and lets CSS pick which
// one is visible based on the active theme — `dark:` here resolves through
// the same `data-theme` attribute that ThemeContext writes on <html>, so a
// manual Light/Dark override is honored alongside the OS preference.
//
// Sources come from the brand config, so a rebranded overlay swaps the mark
// via NEXT_PUBLIC_APP_LOGO_LIGHT / _DARK (or by dropping replacement files
// into public/ under the same names).
export function Logo({ alt = "", className = "", ...rest }: LogoProps) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={getAppLogoLight()}
        alt={alt}
        className={`${className} block dark:hidden`}
        {...rest}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={getAppLogoDark()}
        alt=""
        aria-hidden
        className={`${className} hidden dark:block`}
        {...rest}
      />
    </>
  );
}
