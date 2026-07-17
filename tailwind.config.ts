import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      // LexiCard design system — tokens resolve to CSS variables (channel triplets)
      // defined in globals.css, so they flip between dark (:root) and light (:root.light).
      colors: {
        surface: {
          DEFAULT: 'rgb(var(--c-surface) / <alpha-value>)',        // cards / panels
          deep:    'rgb(var(--c-surface-deep) / <alpha-value>)',   // page / nav backdrop
          raised:  'rgb(var(--c-surface-raised) / <alpha-value>)', // inputs / chips
        },
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',         // main action / brand
          soft:    'rgb(var(--c-accent-soft) / <alpha-value>)',    // soft accent text
          muted:   'rgb(var(--c-accent-muted) / <alpha-value>)',   // hover / pressed
        },
        ink: {
          DEFAULT: 'rgb(var(--c-ink) / <alpha-value>)',            // primary text
          muted:   'rgb(var(--c-ink-muted) / <alpha-value>)',      // secondary text
          faint:   'rgb(var(--c-ink-faint) / <alpha-value>)',      // muted / hint text
        },
        // Hairlines & subtle fills — white on dark, dark on light (see --c-line).
        line:      'rgb(var(--c-line) / <alpha-value>)',
        highlight: 'rgb(var(--c-highlight) / <alpha-value>)',      // warm-yellow accent
        success:   'rgb(var(--c-success) / <alpha-value>)',
        warning:   'rgb(var(--c-warning) / <alpha-value>)',
        danger:    'rgb(var(--c-danger) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        card: '12px',
      },
    },
  },
  plugins: [],
}

export default config
