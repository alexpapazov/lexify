import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      // LexiCard dark-mode design system (cool blue-violet neutrals, blue→violet
      // primary, yellow highlight accent). See the Figma "Dark Mode Color System".
      colors: {
        surface: {
          DEFAULT: '#19182E', // Card (N300)
          deep:    '#13141F', // App BG (N200) — page/nav backdrop
          raised:  '#202240', // Elevated (N400) — inputs, chips
        },
        accent: {
          DEFAULT: '#4A4BD8', // Primary P300 — main action / brand
          soft:    '#868CF0', // P200 — hover fill / soft accent text
          muted:   '#3432B0', // P400 — deep/pressed
        },
        ink: {
          DEFAULT: '#E6E8F5', // N900 — primary text
          muted:   '#A6A3C8', // N800 — secondary text
          faint:   '#7D80A8', // N700 — muted/hint text
        },
        highlight: '#F5C518', // warm-yellow accent — celebration / streaks only
        success:   '#22C90A',
        warning:   '#F07340', // orange (distinct from the yellow highlight)
        danger:    '#F05068',
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
