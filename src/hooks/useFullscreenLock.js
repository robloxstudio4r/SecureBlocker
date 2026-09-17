import { useEffect, useState } from 'react'

export function useFullscreenLock(enabled = true) {
  const [escaped, setEscaped] = useState(false)

  useEffect(() => {
    if (!enabled) return
    const onFsChange = () => {
      if (!document.fullscreenElement) setEscaped(true)
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [enabled])

  const requestLock = async () => {
    try {
      await document.documentElement.requestFullscreen()
      setEscaped(false)
    } catch {}
  }

  return { escaped, requestLock }
}
