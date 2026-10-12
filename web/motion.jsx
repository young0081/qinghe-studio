import React from 'react';

export function PixelActivity({ className = '' }) {
  return <span className={`pixel-activity ${className}`} aria-hidden="true"><i /><i /><i /></span>;
}

export function PixelLoader({ label, detail, compact = false }) {
  return <div className={`pixel-loader ${compact ? 'pixel-loader-compact' : ''}`} role="status" aria-live="polite" aria-label={label}>
    {compact ? <PixelActivity /> : <div className="pixel-loader-scene" aria-hidden="true">
      <span className="pixel-loader-spark spark-first" /><span className="pixel-loader-spark spark-second" />
      <div className="pixel-loader-blocks">{Array.from({ length: 9 }, (_, index) => <i key={index} style={{ '--block': index }} />)}</div>
      <span className="pixel-loader-ground" />
    </div>}
    <div className="pixel-loader-copy"><strong>{label}</strong>{detail && <p>{detail}</p>}</div>
    {!compact && <div className="pixel-loader-track" aria-hidden="true"><span /></div>}
  </div>;
}

export function SkeletonRows({ count = 4 }) {
  return <div className="skeleton-rows" aria-hidden="true">{Array.from({ length: count }, (_, index) => <div className="skeleton-row" key={index} style={{ '--row': index }}><i /><span><b /><b /></span></div>)}</div>;
}
