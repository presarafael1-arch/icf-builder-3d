/**
 * Hook for managing manual wall side corrections (EXT/INT flip)
 * 
 * Corrections are stored per project using geometric fingerprints
 * (midpoint + length + angle) instead of wallId to survive DXF re-imports.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';

// Geometric fingerprint for identifying a wall across DXF re-imports
export interface WallFingerprint {
  midX: number;      // meters, centered
  midY: number;      // meters, centered
  length: number;    // meters
  angle: number;     // radians, normalized to [0, π)
}

export interface WallSideCorrection {
  fingerprint: WallFingerprint;
  action: 'flip';    // For now, only flip is supported
  createdAt: number; // timestamp
  label?: string;    // optional user label
}

interface ProjectCorrections {
  projectId: string;
  corrections: WallSideCorrection[];
  updatedAt: number;
}

interface UseWallSideCorrectionsResult {
  // State
  corrections: WallSideCorrection[];
  applyCorrections: boolean;
  
  // Actions
  addCorrection: (fingerprint: WallFingerprint, label?: string) => void;
  removeCorrection: (fingerprint: WallFingerprint) => void;
  clearAllCorrections: () => void;
  setApplyCorrections: (apply: boolean) => void;
  
  // Query
  hasCorrection: (fingerprint: WallFingerprint) => boolean;
  shouldFlip: (fingerprint: WallFingerprint) => boolean;
  
  // Persistence
  exportCorrections: () => string;
  importCorrections: (json: string) => boolean;
}

// Tolerance for fingerprint matching
const TOLERANCE = {
  position: 0.5,    // 500mm tolerance for midpoint
  length: 0.3,      // 300mm tolerance for length
  angle: 0.15,      // ~8.5° tolerance for angle
};

// Storage key prefix
const STORAGE_KEY_PREFIX = 'omni-icf-wall-corrections-';
const APPLY_CORRECTIONS_KEY = 'omni-icf-apply-corrections';

// Normalize angle to [0, π) - walls have 180° symmetry
function normalizeAngle(angle: number): number {
  let a = angle % Math.PI;
  if (a < 0) a += Math.PI;
  return a;
}

// Check if two fingerprints match within tolerance
function fingerprintsMatch(a: WallFingerprint, b: WallFingerprint): boolean {
  const posDist = Math.sqrt((a.midX - b.midX) ** 2 + (a.midY - b.midY) ** 2);
  const lengthDiff = Math.abs(a.length - b.length);
  
  // Angle difference with wrap-around at π
  let angleDiff = Math.abs(normalizeAngle(a.angle) - normalizeAngle(b.angle));
  if (angleDiff > Math.PI / 2) angleDiff = Math.PI - angleDiff;
  
  return (
    posDist <= TOLERANCE.position &&
    lengthDiff <= TOLERANCE.length &&
    angleDiff <= TOLERANCE.angle
  );
}

// Create fingerprint from wall geometry
export function createWallFingerprint(
  midpoint: { x: number; y: number },
  length: number,
  direction: { x: number; y: number }
): WallFingerprint {
  const angle = Math.atan2(direction.y, direction.x);
  return {
    midX: midpoint.x,
    midY: midpoint.y,
    length,
    angle: normalizeAngle(angle),
  };
}

export function useWallSideCorrections(projectId: string | null): UseWallSideCorrectionsResult {
  // Load initial state
  const [corrections, setCorrections] = useState<WallSideCorrection[]>(() => {
    if (!projectId || typeof window === 'undefined') return [];
    try {
      const saved = localStorage.getItem(STORAGE_KEY_PREFIX + projectId);
      if (saved) {
        const parsed: ProjectCorrections = JSON.parse(saved);
        return parsed.corrections || [];
      }
    } catch (e) {
      console.warn('[WallCorrections] Failed to load:', e);
    }
    return [];
  });

  const [applyCorrections, setApplyCorrectionsState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem(APPLY_CORRECTIONS_KEY);
    return saved !== 'false'; // default true
  });

  // Reload corrections when projectId changes
  useEffect(() => {
    if (!projectId || typeof window === 'undefined') {
      setCorrections([]);
      return;
    }
    try {
      const saved = localStorage.getItem(STORAGE_KEY_PREFIX + projectId);
      if (saved) {
        const parsed: ProjectCorrections = JSON.parse(saved);
        setCorrections(parsed.corrections || []);
        console.log(`[WallCorrections] Loaded ${parsed.corrections?.length || 0} corrections for project ${projectId}`);
      } else {
        setCorrections([]);
      }
    } catch (e) {
      console.warn('[WallCorrections] Failed to load:', e);
      setCorrections([]);
    }
  }, [projectId]);

  // Persist corrections when they change
  useEffect(() => {
    if (!projectId || typeof window === 'undefined') return;
    const data: ProjectCorrections = {
      projectId,
      corrections,
      updatedAt: Date.now(),
    };
    try {
      localStorage.setItem(STORAGE_KEY_PREFIX + projectId, JSON.stringify(data));
    } catch (e) {
      console.warn('[WallCorrections] Failed to persist:', e);
    }
  }, [projectId, corrections]);

  // Persist applyCorrections toggle
  const setApplyCorrections = useCallback((apply: boolean) => {
    setApplyCorrectionsState(apply);
    if (typeof window !== 'undefined') {
      localStorage.setItem(APPLY_CORRECTIONS_KEY, String(apply));
    }
  }, []);

  // Add a new correction
  const addCorrection = useCallback((fingerprint: WallFingerprint, label?: string) => {
    setCorrections(prev => {
      // Remove existing correction for same wall (if any)
      const filtered = prev.filter(c => !fingerprintsMatch(c.fingerprint, fingerprint));
      const newCorrection: WallSideCorrection = {
        fingerprint,
        action: 'flip',
        createdAt: Date.now(),
        label,
      };
      console.log(`[WallCorrections] Added correction:`, fingerprint);
      return [...filtered, newCorrection];
    });
  }, []);

  // Remove a correction
  const removeCorrection = useCallback((fingerprint: WallFingerprint) => {
    setCorrections(prev => {
      const filtered = prev.filter(c => !fingerprintsMatch(c.fingerprint, fingerprint));
      if (filtered.length < prev.length) {
        console.log(`[WallCorrections] Removed correction:`, fingerprint);
      }
      return filtered;
    });
  }, []);

  // Clear all corrections
  const clearAllCorrections = useCallback(() => {
    setCorrections([]);
    console.log('[WallCorrections] Cleared all corrections');
  }, []);

  // Check if a wall has a correction
  const hasCorrection = useCallback((fingerprint: WallFingerprint): boolean => {
    return corrections.some(c => fingerprintsMatch(c.fingerprint, fingerprint));
  }, [corrections]);

  // Check if a wall should be flipped (considering applyCorrections toggle)
  const shouldFlip = useCallback((fingerprint: WallFingerprint): boolean => {
    if (!applyCorrections) return false;
    const correction = corrections.find(c => fingerprintsMatch(c.fingerprint, fingerprint));
    return correction?.action === 'flip';
  }, [corrections, applyCorrections]);

  // Export corrections as JSON
  const exportCorrections = useCallback((): string => {
    return JSON.stringify(corrections, null, 2);
  }, [corrections]);

  // Import corrections from JSON
  const importCorrections = useCallback((json: string): boolean => {
    try {
      const imported = JSON.parse(json);
      if (Array.isArray(imported)) {
        setCorrections(imported);
        return true;
      }
    } catch (e) {
      console.error('[WallCorrections] Failed to import:', e);
    }
    return false;
  }, []);

  return {
    corrections,
    applyCorrections,
    addCorrection,
    removeCorrection,
    clearAllCorrections,
    setApplyCorrections,
    hasCorrection,
    shouldFlip,
    exportCorrections,
    importCorrections,
  };
}
