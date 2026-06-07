/**
 * Electric Kiwi button. One place owns the text-black-on-lime rule, the
 * Barlow Condensed display font, and the lime hover glow.
 *
 *   <Button variant="primary|outline|secondary|ghost|danger" size="sm|md">
 *
 * Renders an <a>/<Link> if `as` is passed, otherwise a <button>. All native
 * props (onClick, disabled, type, title…) pass through.
 */
const VARIANTS = {
  primary: 'btn-primary',
  outline: 'btn-outline',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
}

const SIZES = {
  sm: 'text-[13px] px-3 py-1.5',
  md: 'text-[15px] px-5 py-2.5',
  lg: 'text-base px-6 py-3',
}

export default function Button({
  variant = 'primary',
  size = 'md',
  as: Comp = 'button',
  className = '',
  children,
  ...props
}) {
  const classes = `btn ${VARIANTS[variant] || VARIANTS.primary} ${SIZES[size] || SIZES.md} ${className}`
  return (
    <Comp className={classes} {...props}>
      {children}
    </Comp>
  )
}
