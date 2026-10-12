import React from 'react';

export const sproutPath = 'M17 7h8v5h-3v3h-5ZM7 10h7v3h3v5h-6v-3H7ZM14 15h4v10h-4Z';

export default function Mark({ small = false }) {
  return <span className={`mark ${small ? 'mark-small' : ''}`} aria-hidden="true"><svg viewBox="0 0 32 32" shapeRendering="crispEdges"><path fill="#75ac45" d="M2 2h28v28H2Z" /><path fill="#a1d46b" d="M2 2h28v5H7v23H2Z" /><path fill="#426b31" d="M25 7h5v23H7v-5h18Z" /><path fill="#f5f5de" d={sproutPath} /></svg></span>;
}
