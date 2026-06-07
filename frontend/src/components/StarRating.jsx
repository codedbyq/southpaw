import { useState } from 'react'

export default function StarRating({ value, onChange, readonly = false, size = 'md' }) {
  const [hovered, setHovered] = useState(null)

  const starSize = size === 'sm' ? 'text-lg' : 'text-2xl'
  const active = hovered ?? value ?? 0

  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(star => (
        <button
          key={star}
          type="button"
          disabled={readonly}
          onClick={() => !readonly && onChange?.(star)}
          onMouseEnter={() => !readonly && setHovered(star)}
          onMouseLeave={() => !readonly && setHovered(null)}
          className={`${starSize} transition-colors ${
            readonly ? 'cursor-default' : 'cursor-pointer'
          } ${star <= active ? 'text-gold' : 'text-line2'}`}
        >
          ★
        </button>
      ))}
    </div>
  )
}
