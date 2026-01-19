/**
 * Panel Overrides Hook
 * 
 * Manages panel overrides with persistence to localStorage.
 * Includes support for migrating overrides when chain flip occurs.
 */

import { useState, useEffect, useCallback } from 'react';
import { PanelOverride, OverrideConflict } from '@/types/panel-selection';
import { TOOTH } from '@/types/icf';

const STORAGE_KEY_PREFIX = 'omni-icf-panel-overrides-';

export interface UsePanelOverridesResult {
  overrides: Map<string, PanelOverride>;
  conflicts: OverrideConflict[];
  
  // CRUD operations
  setOverride: (override: PanelOverride) => void;
  removeOverride: (panelId: string) => void;
  clearAllOverrides: () => void;
  
  // Lock operations
  lockPanel: (panelId: string) => void;
  unlockPanel: (panelId: string) => void;
  
  // Query
  hasOverride: (panelId: string) => boolean;
  getOverride: (panelId: string) => PanelOverride | undefined;
  isLocked: (panelId: string) => boolean;
  
  // Validation
  validateOverride: (override: Partial<PanelOverride>) => OverrideConflict[];
  
  // Chain flip migration: swap :ext: <-> :int: in panel IDs for a given chain
  migrateOverridesOnChainFlip: (chainId: string) => void;
}

/**
 * Extract the base key from a panel ID by removing the :ext: or :int: token.
 * Format: chain-N:row:side:slot:seedKey
 * Base key: chain-N:row:slot:seedKey (side removed)
 */
function getBaseKey(panelId: string): string {
  return panelId.replace(/:ext:|:int:/, ':');
}

/**
 * Swap the side token in a panel ID.
 * :ext: becomes :int: and vice versa.
 */
function swapSideInPanelId(panelId: string): string {
  if (panelId.includes(':ext:')) {
    return panelId.replace(':ext:', ':int:');
  } else if (panelId.includes(':int:')) {
    return panelId.replace(':int:', ':ext:');
  }
  return panelId;
}

/**
 * Check if a panel ID belongs to a specific chain.
 * Panel ID format: chain-N:row:side:slot:seedKey
 * Chain ID format: chain-N (8 char prefix used in panel ID)
 */
function panelBelongsToChain(panelId: string, chainId: string): boolean {
  const chainPrefix = chainId.slice(0, 8);
  return panelId.startsWith(chainPrefix + ':');
}

export function usePanelOverrides(projectId: string | undefined): UsePanelOverridesResult {
  const storageKey = projectId ? `${STORAGE_KEY_PREFIX}${projectId}` : null;
  
  const [overrides, setOverrides] = useState<Map<string, PanelOverride>>(() => {
    if (!storageKey) return new Map();
    
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, PanelOverride>;
        return new Map(Object.entries(parsed));
      }
    } catch (e) {
      console.warn('[usePanelOverrides] Failed to load from localStorage:', e);
    }
    return new Map();
  });
  
  const [conflicts, setConflicts] = useState<OverrideConflict[]>([]);
  
  // Persist to localStorage whenever overrides change
  useEffect(() => {
    if (!storageKey) return;
    
    try {
      const obj: Record<string, PanelOverride> = {};
      overrides.forEach((v, k) => { obj[k] = v; });
      localStorage.setItem(storageKey, JSON.stringify(obj));
    } catch (e) {
      console.warn('[usePanelOverrides] Failed to save to localStorage:', e);
    }
  }, [overrides, storageKey]);
  
  /**
   * Validate an override before applying
   */
  const validateOverride = useCallback((override: Partial<PanelOverride>): OverrideConflict[] => {
    const newConflicts: OverrideConflict[] = [];
    
    // Check cut is multiple of TOOTH
    if (override.cutMm !== undefined) {
      const remainder = override.cutMm % TOOTH;
      if (remainder > 0.1 && Math.abs(TOOTH - remainder) > 0.1) {
        newConflicts.push({
          panelId: override.panelId || 'unknown',
          conflictType: 'cut_not_tooth_multiple',
          message: `Corte ${override.cutMm.toFixed(1)}mm não é múltiplo de TOOTH (${TOOTH.toFixed(2)}mm)`,
          severity: 'error',
        });
      }
    }
    
    // Check corner cut at valid position (would need panel context)
    // This is a placeholder - real validation needs panel position info
    if (override.overrideType === 'CORNER_CUT' && override.anchorOverride) {
      if (override.anchorOverride !== 'center_on_node') {
        // Corner cuts should be at nodes
        // But we can't fully validate without knowing the panel's position
      }
    }
    
    return newConflicts;
  }, []);
  
  /**
   * Set or update an override
   */
  const setOverride = useCallback((override: PanelOverride) => {
    const validationErrors = validateOverride(override);
    
    setOverrides(prev => {
      const next = new Map(prev);
      next.set(override.panelId, {
        ...override,
        updatedAt: new Date().toISOString(),
      });
      return next;
    });
    
    if (validationErrors.length > 0) {
      setConflicts(prev => [
        ...prev.filter(c => c.panelId !== override.panelId),
        ...validationErrors,
      ]);
    } else {
      setConflicts(prev => prev.filter(c => c.panelId !== override.panelId));
    }
  }, [validateOverride]);
  
  /**
   * Remove an override
   */
  const removeOverride = useCallback((panelId: string) => {
    setOverrides(prev => {
      const next = new Map(prev);
      next.delete(panelId);
      return next;
    });
    setConflicts(prev => prev.filter(c => c.panelId !== panelId));
  }, []);
  
  /**
   * Clear all overrides
   */
  const clearAllOverrides = useCallback(() => {
    setOverrides(new Map());
    setConflicts([]);
  }, []);
  
  /**
   * Lock a panel (prevent auto-recalc changes)
   */
  const lockPanel = useCallback((panelId: string) => {
    setOverrides(prev => {
      const next = new Map(prev);
      const existing = next.get(panelId);
      if (existing) {
        next.set(panelId, { ...existing, isLocked: true, updatedAt: new Date().toISOString() });
      } else {
        next.set(panelId, {
          panelId,
          isLocked: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      return next;
    });
  }, []);
  
  /**
   * Unlock a panel
   */
  const unlockPanel = useCallback((panelId: string) => {
    setOverrides(prev => {
      const next = new Map(prev);
      const existing = next.get(panelId);
      if (existing) {
        if (existing.overrideType || existing.anchorOverride || existing.cutMm) {
          // Keep override but unlock
          next.set(panelId, { ...existing, isLocked: false, updatedAt: new Date().toISOString() });
        } else {
          // No other overrides, just remove
          next.delete(panelId);
        }
      }
      return next;
    });
  }, []);
  
  /**
   * Check if panel has any override
   */
  const hasOverride = useCallback((panelId: string): boolean => {
    return overrides.has(panelId);
  }, [overrides]);
  
  /**
   * Get override for panel
   */
  const getOverride = useCallback((panelId: string): PanelOverride | undefined => {
    return overrides.get(panelId);
  }, [overrides]);
  
  /**
   * Check if panel is locked
   */
  const isLocked = useCallback((panelId: string): boolean => {
    return overrides.get(panelId)?.isLocked ?? false;
  }, [overrides]);
  
  /**
   * Migrate overrides when a chain flip occurs.
   * This swaps the :ext: and :int: tokens in panel IDs for all overrides
   * belonging to the specified chain.
   * 
   * Algorithm:
   * 1. Find all overrides for panels in this chain
   * 2. Group by baseKey (same panel, different side)
   * 3. For each pair: swap the overrides between ext and int IDs
   * 4. For single panels: just flip the side in the ID
   */
  const migrateOverridesOnChainFlip = useCallback((chainId: string) => {
    setOverrides(prev => {
      const next = new Map(prev);
      const now = new Date().toISOString();
      
      // Collect all overrides for this chain
      const chainOverrides: Array<[string, PanelOverride]> = [];
      prev.forEach((override, panelId) => {
        if (panelBelongsToChain(panelId, chainId)) {
          chainOverrides.push([panelId, override]);
        }
      });
      
      if (chainOverrides.length === 0) {
        console.log('[usePanelOverrides] migrateOverridesOnChainFlip: no overrides to migrate for chain', chainId);
        return prev; // No changes needed
      }
      
      console.log('[usePanelOverrides] migrateOverridesOnChainFlip: migrating', chainOverrides.length, 'overrides for chain', chainId);
      
      // Group by base key (identify pairs)
      const byBaseKey = new Map<string, Array<[string, PanelOverride]>>();
      chainOverrides.forEach(([panelId, override]) => {
        const baseKey = getBaseKey(panelId);
        if (!byBaseKey.has(baseKey)) {
          byBaseKey.set(baseKey, []);
        }
        byBaseKey.get(baseKey)!.push([panelId, override]);
      });
      
      // Process each group
      byBaseKey.forEach((group) => {
        if (group.length === 2) {
          // PAIR: Swap overrides between ext and int
          const [id1, override1] = group[0];
          const [id2, override2] = group[1];
          
          // Remove old entries
          next.delete(id1);
          next.delete(id2);
          
          // Swap: override1 goes to id2's new swapped ID, etc.
          const newId1 = swapSideInPanelId(id1);
          const newId2 = swapSideInPanelId(id2);
          
          next.set(newId1, { ...override1, panelId: newId1, updatedAt: now });
          next.set(newId2, { ...override2, panelId: newId2, updatedAt: now });
          
          console.log('[usePanelOverrides] Swapped pair:', { id1, id2, newId1, newId2 });
        } else if (group.length === 1) {
          // SINGLE: Just flip the side token
          const [panelId, override] = group[0];
          const newId = swapSideInPanelId(panelId);
          
          // Remove old, add new
          next.delete(panelId);
          next.set(newId, { ...override, panelId: newId, updatedAt: now });
          
          console.log('[usePanelOverrides] Flipped single:', { panelId, newId });
        }
        // If more than 2, something is wrong - just flip each individually
        else if (group.length > 2) {
          group.forEach(([panelId, override]) => {
            const newId = swapSideInPanelId(panelId);
            next.delete(panelId);
            next.set(newId, { ...override, panelId: newId, updatedAt: now });
          });
        }
      });
      
      return next;
    });
    
    // Also update conflicts if any
    setConflicts(prev => {
      return prev.map(conflict => {
        if (panelBelongsToChain(conflict.panelId, chainId)) {
          return { ...conflict, panelId: swapSideInPanelId(conflict.panelId) };
        }
        return conflict;
      });
    });
  }, []);
  
  return {
    overrides,
    conflicts,
    setOverride,
    removeOverride,
    clearAllOverrides,
    lockPanel,
    unlockPanel,
    hasOverride,
    getOverride,
    isLocked,
    validateOverride,
    migrateOverridesOnChainFlip,
  };
}
