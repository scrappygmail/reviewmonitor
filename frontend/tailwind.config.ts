import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Bright, clean, premium — cool slate base with a confident
        // signal-blue accent (matches "review alerts" domain: trust +
        // urgency) and a warning-amber reserved only for negative badges.
        ink: "#0F172A",
        paper: "#FAFBFF",
        surface: "#FFFFFF",
        line: "#E7EAF3",
        muted: "#64748B",
        brand: {
          50: "#EEF2FF",
          100: "#E0E7FF",
          400: "#6366F1",
          500: "#4F46E5",
          600: "#4338CA",
        },
        alert: {
          50: "#FEF3F2",
          400: "#F87171",
          500: "#EF4444",
          600: "#DC2626",
        },
      },
      fontFamily: {
        display: ["'Sora'", "sans-serif"],
        body: ["'Inter'", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.08)",
      },
      borderRadius: {
        xl2: "1.25rem",
      },
    },
  },
  plugins: [],
};
export default config;
