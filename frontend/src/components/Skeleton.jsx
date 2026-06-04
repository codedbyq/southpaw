// Base pulse element
function Pulse({ className }) {
  return <div className={`bg-gray-800 animate-pulse rounded ${className}`} />
}

// ─── Reusable shapes ──────────────────────────────────────────────────────────

export function SkeletonLine({ width = 'w-full', height = 'h-4', className = '' }) {
  return <Pulse className={`${width} ${height} ${className}`} />
}

// ─── Page-level skeletons ──────────────────────────────────────────────────────

export function StatsBarSkeleton() {
  return (
    <div className="grid grid-cols-4 gap-3 mb-10">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
          <Pulse className="w-6 h-6 rounded" />
          <Pulse className="w-16 h-7 rounded" />
          <Pulse className="w-20 h-3 rounded" />
          <Pulse className="w-14 h-3 rounded" />
        </div>
      ))}
    </div>
  )
}

export function SessionCardSkeleton() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="space-y-2">
          <Pulse className="w-40 h-4 rounded" />
          <div className="flex gap-2">
            <Pulse className="w-16 h-5 rounded-full" />
            <Pulse className="w-20 h-5 rounded-full" />
          </div>
        </div>
        <Pulse className="w-16 h-8 rounded-lg" />
      </div>
      <div className="grid grid-cols-4 gap-3 mt-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="space-y-1">
            <Pulse className="w-10 h-5 rounded" />
            <Pulse className="w-16 h-3 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function ClipCardSkeleton() {
  return (
    <div className="flex items-center justify-between p-4 bg-gray-900 rounded-xl border border-gray-800">
      <div className="flex items-center gap-4">
        <Pulse className="w-16 h-12 rounded-lg flex-shrink-0" />
        <div className="space-y-2">
          <Pulse className="w-48 h-4 rounded" />
          <Pulse className="w-24 h-3 rounded" />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Pulse className="w-16 h-6 rounded-full" />
        <Pulse className="w-14 h-7 rounded-lg" />
      </div>
    </div>
  )
}

export function CoachCardSkeleton() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-start gap-4">
        <Pulse className="w-14 h-14 rounded-full flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <Pulse className="w-36 h-5 rounded" />
          <Pulse className="w-full h-3 rounded" />
          <Pulse className="w-4/5 h-3 rounded" />
          <div className="flex gap-2 mt-2">
            <Pulse className="w-16 h-5 rounded-full" />
            <Pulse className="w-20 h-5 rounded-full" />
            <Pulse className="w-14 h-5 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  )
}

export function SessionDetailSkeleton() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-3">
        <Pulse className="w-64 h-8 rounded" />
        <div className="flex gap-2">
          <Pulse className="w-20 h-6 rounded-full" />
          <Pulse className="w-24 h-6 rounded-full" />
        </div>
      </div>
      {/* Metrics row */}
      <div className="grid grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
            <Pulse className="w-14 h-6 rounded" />
            <Pulse className="w-20 h-3 rounded" />
          </div>
        ))}
      </div>
      {/* Clip cards */}
      <div className="space-y-3">
        <Pulse className="w-24 h-5 rounded" />
        {[...Array(2)].map((_, i) => <ClipCardSkeleton key={i} />)}
      </div>
    </div>
  )
}

export function PlayerSkeleton() {
  return (
    <div className="space-y-6">
      {/* Video area */}
      <Pulse className="w-full aspect-video rounded-xl" />
      {/* Timeline */}
      <div className="space-y-2">
        <Pulse className="w-24 h-3 rounded" />
        <Pulse className="w-full h-8 rounded-lg" />
      </div>
      {/* Strike summary */}
      <div className="flex gap-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Pulse className="w-3 h-3 rounded-full" />
            <Pulse className="w-20 h-3 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function ReviewCardSkeleton() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-start gap-4">
      <Pulse className="w-16 h-12 rounded-lg flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <Pulse className="w-40 h-4 rounded" />
          <Pulse className="w-16 h-5 rounded-full" />
        </div>
        <Pulse className="w-32 h-3 rounded" />
      </div>
      <div className="space-y-2">
        <Pulse className="w-24 h-7 rounded-lg" />
        <Pulse className="w-24 h-7 rounded-lg" />
      </div>
    </div>
  )
}

export function CoachProfileSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Pulse className="w-48 h-5 rounded" />
        <Pulse className="w-full h-24 rounded-xl" />
      </div>
      <div className="space-y-3">
        <Pulse className="w-32 h-5 rounded" />
        <div className="flex flex-wrap gap-2">
          {[...Array(5)].map((_, i) => <Pulse key={i} className="w-20 h-7 rounded-full" />)}
        </div>
      </div>
      <div className="space-y-2">
        <Pulse className="w-40 h-5 rounded" />
        <Pulse className="w-32 h-10 rounded-xl" />
      </div>
    </div>
  )
}
