import type { Metadata } from 'next'
import './globals.css'
import { Navbar } from '@/components/nav/Navbar'

export const metadata: Metadata = {
  title: 'Lexify',
  description: 'Vocabulary learning with spaced repetition.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen flex flex-col">
        <Navbar />
        <main className="flex-1 px-4 py-8 max-w-5xl mx-auto w-full">
          {children}
        </main>
      </body>
    </html>
  )
}
