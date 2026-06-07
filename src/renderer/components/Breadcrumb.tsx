interface BreadcrumbSegment {
  label: string;
  /** If omitted, the segment renders as plain text (the current page). */
  onClick?: () => void;
}

interface BreadcrumbProps {
  segments: BreadcrumbSegment[];
}

export function Breadcrumb({ segments }: BreadcrumbProps) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      {segments.map((s, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={`${i}-${s.label}`} className="breadcrumb-item">
            {s.onClick && !isLast ? (
              <button className="breadcrumb-link" onClick={s.onClick}>
                {s.label}
              </button>
            ) : (
              <span className={isLast ? 'breadcrumb-current' : 'breadcrumb-text'}>
                {s.label}
              </span>
            )}
            {!isLast && <span className="breadcrumb-sep">/</span>}
          </span>
        );
      })}
    </nav>
  );
}
