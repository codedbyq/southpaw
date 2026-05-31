import { UserButton } from '@clerk/react'
import UploadButton from '../components/UploadButton'

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <span className="font-bold text-lg tracking-tight">Southpaw</span>
        <UserButton />
      </nav>
      <main className="max-w-4xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-2xl font-semibold">Your clips</h2>
          <UploadButton />
        </div>
        {/* Clip list goes here later */}
        <div className="text-gray-500 text-sm">No clips yet. Upload your first clip to get started.</div>
      </main>
    </div>
  )
}