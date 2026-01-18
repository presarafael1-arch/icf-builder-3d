/**
 * Panel Overrides Hook
 * 
 * Manages panel overrides with persistence to localStorage
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
    
    // Check orange at valid position (would need panel context)
    // This is a placeholder - real validation needs panel position info
    if (override.overrideType === 'CUT_DOUBLE' && override.anchorOverride) {
      if (override.anchorOverride !== 'center_on_node') {
        // Orange cuts should only be in middle, not at nodes
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
  };
}
