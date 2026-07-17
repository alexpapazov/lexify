import { redirect } from 'next/navigation'

// No standalone home page — the app opens straight into Study.
export default function Home() {
  redirect('/study')
}
