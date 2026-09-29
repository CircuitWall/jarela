import type { UserProfile } from "@/api/types";

export const PROFILE_PRESETS: Array<{ value: NonNullable<UserProfile["preset"]>; label: string; hint: string }> = [
  { value: "home", label: "Home", hint: "Personal AI, mail, calendar, and everyday tasks" },
  { value: "work", label: "Work", hint: "Project coordination, docs, issues, and team workflows" },
  { value: "dev", label: "Developer", hint: "Coding, debugging, tools, and infrastructure-heavy usage" },
  { value: "custom", label: "Everything", hint: "Show the full surface without category filtering" },
];
