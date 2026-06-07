// COCO 17 keypoint indices
const KEYPOINT_NAMES = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle'
]

// Pairs of keypoint indices to draw limb lines between
const SKELETON_CONNECTIONS = [
  [0, 1], [0, 2], [1, 3], [2, 4],           // face
  [5, 6],                                     // shoulders
  [5, 7], [7, 9],                             // left arm
  [6, 8], [8, 10],                            // right arm
  [5, 11], [6, 12],                           // torso
  [11, 12],                                   // hips
  [11, 13], [13, 15],                         // left leg
  [12, 14], [14, 16],                         // right leg
]

// Electric Kiwi strike data-viz ramp — punches glow lime/green, kicks burn orange
const STRIKE_COLORS = {
  jab:            '#ccff00',  // electric lime (lead hand = brand)
  cross:          '#dfff00',  // volt
  hook:           '#88ff00',  // green
  roundhouse_kick:'#ff6b00',  // deep orange kick
  rear_kick:      '#ff9500',  // amber kick
}

const DEFAULT_SKELETON_COLOR = '#ccff00'   // electric lime pose skeleton
const MUTED_SKELETON_COLOR   = '#333333'   // line-2 — for non-selected subjects
const JOINT_RADIUS = 2
const VISIBILITY_THRESHOLD = 0.3

/**
 * Build a time-indexed lookup from keypoint JSON for O(log n) frame lookup.
 * Call once on mount.
 */
export function buildIndex(framesData) {
  return framesData.map(f => f.timestamp)  // sorted array of timestamps
}

/**
 * Binary search — find the closest frame index for a given timestamp.
 */
export function lookupFrame(timestamps, currentTime) {
  let lo = 0
  let hi = timestamps.length - 1

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (timestamps[mid] < currentTime) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo
}

/**
 * Main draw function — called on every rAF tick.
 */
export function drawFrame(canvas, frame, activeSubject, showLabels) {
  if (!canvas || !frame) return

  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // Use actual video render area, not full canvas
  const width = canvas._renderWidth || canvas.width
  const height = canvas._renderHeight || canvas.height
  const offsetX = canvas._offsetX || 0
  const offsetY = canvas._offsetY || 0

  const skeletons = frame.skeletons || []

  skeletons.forEach((skeleton) => {
    const isActive = skeleton.id === activeSubject
    const color = isActive ? DEFAULT_SKELETON_COLOR : MUTED_SKELETON_COLOR
    drawSkeleton(ctx, skeleton.keypoints, color, width, height, offsetX, offsetY)
  })

  if (showLabels && frame.strikes && frame.strikes.length > 0) {
    frame.strikes.forEach(strike => {
      const activeSkeletonKps = skeletons.find(s => s.id === activeSubject)?.keypoints
      if (activeSkeletonKps) {
        drawStrikeLabel(ctx, strike.type, activeSkeletonKps, width, height, offsetX, offsetY)
      }
    })
  }
}

function drawSkeleton(ctx, keypoints, color, width, height, offsetX, offsetY) {
  if (!keypoints || keypoints.length === 0) return

  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.globalAlpha = 0.8

  SKELETON_CONNECTIONS.forEach(([i, j]) => {
    const a = keypoints[i]
    const b = keypoints[j]
    if (!a || !b) return
    if (a.visibility < VISIBILITY_THRESHOLD || b.visibility < VISIBILITY_THRESHOLD) return

    ctx.beginPath()
    ctx.moveTo(offsetX + a.x * width, offsetY + a.y * height)
    ctx.lineTo(offsetX + b.x * width, offsetY + b.y * height)
    ctx.stroke()
  })

  ctx.fillStyle = color
  ctx.globalAlpha = 1.0

  keypoints.forEach((kp) => {
    if (!kp || kp.visibility < VISIBILITY_THRESHOLD) return
    ctx.beginPath()
    ctx.arc(offsetX + kp.x * width, offsetY + kp.y * height, JOINT_RADIUS, 0, Math.PI * 2)
    ctx.fill()
  })
}

function drawStrikeLabel(ctx, strikeType, keypoints, width, height, offsetX, offsetY) {
  const nose = keypoints[0]
  if (!nose || nose.visibility < VISIBILITY_THRESHOLD) return

  const x = offsetX + nose.x * width
  const y = offsetY + nose.y * height - 20

  const label = strikeType.replace('_', ' ').toUpperCase()
  const color = STRIKE_COLORS[strikeType] || '#ffffff'

  ctx.font = 'bold 13px sans-serif'
  ctx.fillStyle = color
  ctx.globalAlpha = 1.0
  ctx.textAlign = 'center'
  ctx.fillText(label, x, y)
}

/**
 * Find which skeleton is closest to a canvas click point.
 * Used for subject selection.
 */
export function findClosestSkeleton(skeletons, clickX, clickY, canvas) {
  const width = canvas._renderWidth || canvas.width
  const height = canvas._renderHeight || canvas.height
  const offsetX = canvas._offsetX || 0
  const offsetY = canvas._offsetY || 0

  let closest = null
  let minDist = Infinity

  skeletons.forEach((skeleton) => {
    skeleton.keypoints.forEach((kp) => {
      if (!kp || kp.visibility < VISIBILITY_THRESHOLD) return
      const dx = offsetX + kp.x * width - clickX
      const dy = offsetY + kp.y * height - clickY
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < minDist) {
        minDist = dist
        closest = skeleton.id
      }
    })
  })

  return minDist < 40 ? closest : null
}