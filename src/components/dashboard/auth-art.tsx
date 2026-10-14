'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { SpiralScene } from './spiral-scene';

/**
 * The sign-in screen's art (owner, 2026-10-14): the still spiral image and its four words first —
 * on every screen, and the only art on phones, without WebGL or under "reduce motion" — then, where
 * the live motion graphic starts (`SpiralScene`), the still fades away beneath it.
 */
export function AuthArt({ still }: { still: ReactNode }) {
  const [live, setLive] = useState(false);
  const onReady = useCallback(() => setLive(true), []);
  return (
    <>
      <div className={`absolute inset-0 -z-10 transition-opacity duration-700 ${live ? 'opacity-0' : 'opacity-100'}`}>{still}</div>
      <SpiralScene onReady={onReady} />
    </>
  );
}
