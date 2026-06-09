import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#2d2d2d',
          deep:    '#1e1e1e',
          raised:  '#3a3a3a',
        },
        accent: {
          DEFAULT: '#7c6af7',
          soft:    '#a89cf7',
          muted:   '#4a3f9e',
        },
        ink: {
          DEFAULT: '#f0ede8',
          muted:   '#a0998f',
          faint:   '#5a5550',
        },
        success: '#4caf82',
        warning: '#f5a623',
        danger:  '#e05c5c',
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
