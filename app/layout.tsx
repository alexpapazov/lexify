import type { Metadata, Viewport } from 'next'
import './globals.css'
import { Navbar } from '@/components/nav/Navbar'
import { AuthWall } from '@/components/AuthWall'
import { Tour } from '@/components/Tour'
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister'

export const metadata: Metadata = {
  title: 'Lexify',
  description: 'Vocabulary learning with spaced repetition.',
  applicationName: 'Lexify',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Lexify' },
  icons: { apple: '/icons/apple-touch-icon.png' },
  other: { 'apple-mobile-web-app-capable': 'yes' },
}

export const viewport: Viewport = {
  themeColor: '#12121a',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
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
        <ServiceWorkerRegister />
        <Navbar />
        <main className="flex-1 px-4 py-8 max-w-5xl mx-auto w-full">
          <AuthWall>{children}</AuthWall>
        </main>
        <Tour />
      </body>
    </html>
  )
}
