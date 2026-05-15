import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./contexts/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        surface: "#09090b",
        "surface-2": "#18181b",
        "surface-3": "#27272a",
        border: "#3f3f46",
        accent: "#2563eb",
        "accent-hover": "#1d4ed8",
      },
    },
  },
  plugins: [],
};
export default config;
