import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        sidebar: "var(--sidebar-bg)",
        "chat-bg": "var(--chat-bg)",
        "panel-bg": "var(--panel-bg)",
        border: "var(--border-color)",
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        accent: "var(--accent)",
        "accent-soft": "var(--accent-soft)",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "monospace"]
      }
    }
  },
  plugins: [require("@tailwindcss/typography")]
} satisfies Config;
