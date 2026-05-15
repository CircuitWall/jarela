/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
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
