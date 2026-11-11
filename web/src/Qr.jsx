import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

export const joinUrl = () => `${location.origin}${import.meta.env.BASE_URL}`

// Black on white whatever the page's theme: phones scan that most reliably.
export function JoinQr({ size = 220 }) {
  const [src, setSrc] = useState('')

  useEffect(() => {
    QRCode.toDataURL(joinUrl(), { margin: 2, width: size * 2 }).then(setSrc)
  }, [size])

  if (!src) return null
  return <img className="qr" src={src} width={size} height={size} alt="QR code to join the game" />
}
