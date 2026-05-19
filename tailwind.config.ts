import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "hsl(220 14% 8%)",
          muted: "hsl(220 14% 11%)",
          card: "hsl(220 14% 13%)",
        },
        fg: {
          DEFAULT: "hsl(220 10% 96%)",
          muted: "hsl(220 8% 65%)",
          subtle: "hsl(220 8% 45%)",
        },
        border: {
          DEFAULT: "hsl(220 13% 20%)",
          strong: "hsl(220 13% 30%)",
        },
        accent: {
          DEFAULT: "hsl(220 90% 60%)",
          hover: "hsl(220 90% 65%)",
        },
        success: "hsl(142 70% 45%)",
        warning: "hsl(38 92% 55%)",
        danger: "hsl(0 80% 60%)",
        temperature: {
          cold: "hsl(200 80% 55%)",
          cool: "hsl(170 60% 50%)",
          warm: "hsl(38 92% 55%)",
          hot: "hsl(15 85% 55%)",
          critical: "hsl(0 80% 55%)",
        },
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "monospace"],
      },
      borderRadius: {
        DEFAULT: "0.5rem",
      },
    },
  },
  plugins: [],
};

export default config;
