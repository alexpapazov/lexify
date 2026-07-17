import type { Metadata } from 'next'
import './globals.css'
import { Navbar } from '@/components/nav/Navbar'

export const metadata: Metadata = {
  title: 'Lexify',
  description: 'Vocabulary learning with spaced repetition.',
}

// Applies the saved theme before first paint (no flash). Dark is the default;
// only an explicit 'light' preference adds the class. See globals.css :root.light.
const THEME_INIT = `try{if(localStorage.getItem('lexify-theme')==='light')document.documentElement.classList.add('light')}catch(e){}`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-screen flex flex-col">
        <Navbar />
        <main className="flex-1 px-4 py-8 max-w-5xl mx-auto w-full">
          {children}
        </main>
      </body>
    </html>
  )
}
