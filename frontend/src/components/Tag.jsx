/**
 * Sharp 4px rectangular tag — the signature Electric Kiwi badge.
 * Tinted text on a ~12% tint of the same hue, uppercase, 10px bold.
 *
 *   <Tag tone="boxing|muaythai|mma|pads|spar|success|warning|danger|gold|muted">
 *   <SportTag sport="boxing" />        — maps app sport values
 *   <SessionTypeTag type="sparring" /> — maps app session_type values
 */
export default function Tag({ tone = 'muted', className = '', children }) {
  return <span className={`tag tag-${tone} ${className}`}>{children}</span>
}

const SPORT_MAP = {
  boxing:    ['boxing', 'Boxing'],
  muay_thai: ['muaythai', 'Muay Thai'],
  muaythai:  ['muaythai', 'Muay Thai'],
  mma:       ['mma', 'MMA'],
}

const TYPE_MAP = {
  sparring: ['spar', 'Sparring'],
  pads:     ['pads', 'Pads'],
  bag:      ['boxing', 'Bag'],
  shadow:   ['mma', 'Shadow'],
}

function pretty(v) {
  return (v || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function SportTag({ sport, className }) {
  const [tone, label] = SPORT_MAP[sport] || ['muted', pretty(sport)]
  return <Tag tone={tone} className={className}>{label}</Tag>
}

export function SessionTypeTag({ type, className }) {
  if (!type) return null
  const [tone, label] = TYPE_MAP[type] || ['spar', pretty(type)]
  return <Tag tone={tone} className={className}>{label}</Tag>
}
