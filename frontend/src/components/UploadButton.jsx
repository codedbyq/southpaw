import { useState, useRef } from 'react'
import { useAuth } from '@clerk/react'
import { useApi } from '../api/client'

const ACCEPTED_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo']

export default function UploadButton({ onUploadComplete }) {
  const { getToken } = useAuth()
  const api = useApi()
  const fileInputRef = useRef(null)
  const [state, setState] = useState('idle')     // idle | uploading | processing | complete | error
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Unsupported file type. Please upload an MP4 or MOV file.')
      return
    }

    setError(null)
    setState('uploading')
    setProgress(0)

    try {
      // Step 1 — get presigned URL
      const { clip_id, upload_url } = await api.post('/uploads/init', {
        filename: file.name,
        content_type: file.type,
      })

      // Step 2 — upload directly to S3
      await uploadToS3(file, upload_url, (pct) => setProgress(pct))

      // Step 3 — notify backend
      const { job_id } = await api.post('/uploads/complete', { clip_id })

      // Step 4 — get token and open SSE stream
      const token = await getToken()
      setState('processing')
      setProgress(0)

      await listenToJobProgress(job_id, token, (data) => {
        if (data.status === 'processing') {
          setProgress(data.progress)
        } else if (data.status === 'complete') {
          setState('complete')
          setProgress(100)
        } else if (data.status === 'failed') {
          setError('Processing failed — please try again')
          setState('error')
        }
      })
      
      if (onUploadComplete) onUploadComplete()
    
    } catch (err) {
      console.error(err)
      setError(err.message)
      setState('error')
    } finally {
      fileInputRef.current.value = ''
    }
  }

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="video/mp4,video/quicktime,video/x-msvideo"
        className="hidden"
        onChange={handleFileChange}
      />

      {(state === 'idle' || state === 'complete' || state === 'error') && (
        <button
          onClick={() => {
            setState('idle')
            setError(null)
            fileInputRef.current?.click()
          }}
          className="px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-500 transition-colors"
        >
          Upload clip
        </button>
      )}

      {state === 'uploading' && (
        <div className="flex items-center gap-3">
          <div className="w-40 h-2 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-500 transition-all duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-sm text-gray-400">Uploading {progress}%</span>
        </div>
      )}

      {state === 'processing' && (
        <div className="flex items-center gap-3">
          <div className="w-40 h-2 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-violet-500 transition-all duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-sm text-gray-400">Analysing {progress}%</span>
        </div>
      )}

      {error && (
        <p className="mt-2 text-sm text-red-400">{error}</p>
      )}

      {state === 'complete' && (
        <p className="mt-2 text-sm text-green-400">Processing complete!</p>
      )}
    </div>
  )
}


function uploadToS3(file, presignedUrl, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status === 200) resolve()
      else reject(new Error(`S3 upload failed with status ${xhr.status}`))
    })

    xhr.addEventListener('error', () => reject(new Error('S3 upload failed')))

    xhr.open('PUT', presignedUrl)
    xhr.setRequestHeader('Content-Type', file.type)
    xhr.send(file)
  })
}


function listenToJobProgress(jobId, token, onData) {
  return new Promise((resolve, reject) => {
    const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
    const source = new EventSource(
      `${API_URL}/jobs/${jobId}/stream?token=${token}`
    )

    source.onmessage = (event) => {
      const data = JSON.parse(event.data)
      onData(data)
      if (data.status === 'complete' || data.status === 'failed') {
        source.close()
        resolve()
      }
    }

    source.onerror = () => {
      source.close()
      reject(new Error('SSE connection lost'))
    }
  })
}