/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        pulse: {
          bg: "#0a0e17",
          "bg-alt": "#060a12",
          surface: "#111827",
          "surface-hover": "#162033",
          border: "#1e293b",
          "border-light": "#2a3a50",
          accent: "#3b82f6",
          "accent-dim": "#1e40af",
          success: "#10b981",
          warning: "#f59e0b",
          danger: "#ef4444",
          muted: "#64748b",
          "muted-light": "#94a3b8",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      animation: {
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
        "slide-in": "slide-in 0.3s ease-out",
        "fade-in": "fade-in 0.4s ease-out",
        "count-up": "count-up 0.6s ease-out",
      },
      keyframes: {
        "pulse-glow": {
          "0%, 100%": { boxShadow: "0 0 5px rgba(59,130,246,0.3)" },
          "50%": { boxShadow: "0 0 20px rgba(59,130,246,0.6)" },
        },
        "slide-in": {
          from: { transform: "translateX(100%)", opacity: "0" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "count-up": {
          from: { opacity: "0", transform: "scale(0.8)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
      },
    },
  },
  plugins: [],
};
