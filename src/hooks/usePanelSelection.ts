/**
 * Panel Selection Hook
 * 
 * Manages panel selection state for the 3D viewer
 */

import { useState, useCallback } from 'react';
import { PanelSelectionState, ExtendedPanelData } from '@/types/panel-selection';

export interface UsePanelSelectionResult {
  selection: PanelSelectionState;
  
  // Selection operations
  selectPanel: (panelId: string | null) => void;
  hoverPanel: (panelId: string | null) => void;
  highlightPanels: (panelIds: string[]) => void;
  clearSelection: () => void;
  
  // Queries
  isSelected: (panelId: string) => boolean;
  isHovered: (panelId: string) => boolean;
  isHighlighted: (panelId: string) => boolean;
}

export function usePanelSelection(): UsePanelSelectionResult {
  const [selection, setSelection] = useState<PanelSelectionState>({
    selectedPanelId: null,
    hoveredPanelId: null,
    highlightedPanelIds: [],
  });
  
  const selectPanel = useCallback((panelId: string | null) => {
    setSelection(prev => ({
      ...prev,
      selectedPanelId: panelId,
    }));
  }, []);
  
  const hoverPanel = useCallback((panelId: string | null) => {
    setSelection(prev => ({
      ...prev,
      hoveredPanelId: panelId,
    }));
  }, []);
  
  const highlightPanels = useCallback((panelIds: string[]) => {
    setSelection(prev => ({
      ...prev,
      highlightedPanelIds: panelIds,
    }));
  }, []);
  
  const clearSelection = useCallback(() => {
    setSelection({
      selectedPanelId: null,
      hoveredPanelId: null,
      highlightedPanelIds: [],
    });
  }, []);
  
  const isSelected = useCallback((panelId: string): boolean => {
    return selection.selectedPanelId === panelId;
  }, [selection.selectedPanelId]);
  
  const isHovered = useCallback((panelId: string): boolean => {
    return selection.hoveredPanelId === panelId;
  }, [selection.hoveredPanelId]);
  
  const isHighlighted = useCallback((panelId: string): boolean => {
    return selection.highlightedPanelIds.includes(panelId);
  }, [selection.highlightedPanelIds]);
  
  return {
    selection,
    selectPanel,
    hoverPanel,
    highlightPanels,
    clearSelection,
    isSelected,
    isHovered,
    isHighlighted,
  };
}
