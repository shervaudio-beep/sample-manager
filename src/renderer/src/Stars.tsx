// 1-5 star rating. Clicking the current rating clears it.

interface Props {
  value: number
  onChange: (rating: number) => void
  size?: 'small' | 'normal'
}

export function Stars({ value, onChange, size = 'normal' }: Props): React.JSX.Element {
  return (
    <span className={`stars ${size}`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={n <= value ? 'on' : ''}
          title={n === value ? 'Clear rating' : `${n} star${n > 1 ? 's' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onChange(n === value ? 0 : n)
          }}
        >
          ★
        </button>
      ))}
    </span>
  )
}
