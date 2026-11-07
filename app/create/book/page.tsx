'use client'

/**
 * /create/book → /media (Media Intake Stage C, 2026-11-06).
 *
 * The book-page wizard moved into the Media LOG — intake is a log entry now, not a create flow.
 * This stub survives so old links and muscle memory keep working.
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function BookIntakeRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace('/media') }, [router])
  return null
}
