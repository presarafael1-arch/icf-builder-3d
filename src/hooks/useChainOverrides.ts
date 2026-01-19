/**
 * Chain Overrides Hook
 * 
 * Manages chain-level overrides including exterior/interior side flipping
 * with persistence to localStorage
 */

import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY_PREFIX = 'omni-icf-chain-overrides-';

export interface ChainOverride {
  chainId: string;
  /** If true, swaps exterior<->interior classification for this chain */
  flipSide: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UseChainOverridesResult {
  overrides: Map<string, ChainOverride>;
  
  // Side flip operations
  isFlipped: (chainId: string) => boolean;
  toggleFlip: (chainId: string) => void;
  setFlip: (chainId: string, flip: boolean) => void;
  
  // Clear
  clearAllOverrides: () => void;
  
  // For passing to panel layout
  getFlippedChainIds: () => Set<string>;
}

export function useChainOverrides(projectId: string | undefined): UseChainOverridesResult {
  const storageKey = projectId ? `${STORAGE_KEY_PREFIX}${projectId}` : null;
  
  const [overrides, setOverrides] = useState<Map<string, ChainOverride>>(() => {
    if (!storageKey) return new Map();
    
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, ChainOverride>;
        return new Map(Object.entries(parsed));
      }
    } catch (e) {
      console.warn('[useChainOverrides] Failed to load from localStorage:', e);
    }
    return new Map();
  });
  
  // Persist to localStorage whenever overrides change
  useEffect(() => {
    if (!storageKey) return;
    
    try {
      const obj: Record<string, ChainOverride> = {};
      overrides.forEach((v, k) => { obj[k] = v; });
      localStorage.setItem(storageKey, JSON.stringify(obj));
    } catch (e) {
      console.warn('[useChainOverrides] Failed to save to localStorage:', e);
    }
  }, [overrides, storageKey]);
  
  /**
   * Check if a chain has its side flipped
   */
  const isFlipped = useCallback((chainId: string): boolean => {
    return overrides.get(chainId)?.flipSide ?? false;
  }, [overrides]);
  
  /**
   * Toggle the flip state of a chain
   */
  const toggleFlip = useCallback((chainId: string) => {
    setOverrides(prev => {
      const next = new Map(prev);
      const existing = next.get(chainId);
      const now = new Date().toISOString();
      
      if (existing) {
        if (!existing.flipSide) {
          // Turn on flip
          next.set(chainId, { ...existing, flipSide: true, updatedAt: now });
        } else {
          // Turn off flip - remove if no other overrides
          next.delete(chainId);
        }
      } else {
        // Create new override with flip on
        next.set(chainId, {
          chainId,
          flipSide: true,
          createdAt: now,
          updatedAt: now,
        });
      }
      return next;
    });
  }, []);
  
  /**
   * Set flip state explicitly
   */
  const setFlip = useCallback((chainId: string, flip: boolean) => {
    setOverrides(prev => {
      const next = new Map(prev);
      const now = new Date().toISOString();
      
      if (flip) {
        const existing = next.get(chainId);
        if (existing) {
          next.set(chainId, { ...existing, flipSide: true, updatedAt: now });
        } else {
          next.set(chainId, {
            chainId,
            flipSide: true,
            createdAt: now,
            updatedAt: now,
          });
        }
      } else {
        // Remove override if flip is off
        next.delete(chainId);
      }
      return next;
    });
  }, []);
  
  /**
   * Clear all chain overrides
   */
  const clearAllOverrides = useCallback(() => {
    setOverrides(new Map());
  }, []);
  
  /**
   * Get Set of chain IDs that are flipped (for passing to panel layout)
   */
  const getFlippedChainIds = useCallback((): Set<string> => {
    const flipped = new Set<string>();
    overrides.forEach((override, chainId) => {
      if (override.flipSide) {
        flipped.add(chainId);
      }
    });
    return flipped;
  }, [overrides]);
  
  return {
    overrides,
    isFlipped,
    toggleFlip,
    setFlip,
    clearAllOverrides,
    getFlippedChainIds,
  };
}
