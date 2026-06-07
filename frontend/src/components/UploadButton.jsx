import { useState } from 'react'
import Button from './Button'
import UploadModal from './UploadModal'

/**
 * Thin trigger that opens the full UploadModal. Keeps the same
 * `onUploadComplete` contract so every existing call site works unchanged.
 */
export default function UploadButton({ onUploadComplete, children, ...buttonProps }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)} {...buttonProps}>
        {children || '+ Upload clip'}
      </Button>
      {open && (
        <UploadModal
          onClose={() => setOpen(false)}
          onUploadComplete={onUploadComplete}
        />
      )}
    </>
  )
}
