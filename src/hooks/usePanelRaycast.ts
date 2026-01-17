/**
 * Panel Raycast Hook
 * 
 * Handles raycast picking for InstancedMesh panels in the 3D viewer
 */

import { useCallback, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { ThreeEvent } from '@react-three/fiber';
import { ClassifiedPanel, TopoPlacement, PanelType } from '@/lib/panel-layout';
import { ExtendedPanelData, CoreConcreteMm, getTopoType, coreThicknessToWallThickness } from '@/types/panel-selection';

export interface PanelLookupEntry {
  instanceId: number;
  panelId: string;
  meshType: 'FULL' | 'CUT_SINGLE' | 'CUT_DOUBLE' | 'CORNER_CUT' | 'TOPO';
  panelData: ExtendedPanelData;
}

export interface UsePanelRaycastResult {
  // Lookup table operations
  buildLookupTable: (
    panelsByType: Record<PanelType, ClassifiedPanel[]>,
    allPanels: ClassifiedPanel[],
    allTopos: TopoPlacement[],
    coreConcreteMm: CoreConcreteMm
  ) => void;
  
  // Lookup operations
  getPanelByInstanceId: (meshType: PanelType | 'TOPO', instanceId: number) => PanelLookupEntry | null;
  getPanelById: (panelId: string) => ExtendedPanelData | null;
  getAllPanels: () => ExtendedPanelData[];
  
  // Click handler factory
  handleMeshClick: (meshType: PanelType | 'TOPO', onSelect: (panelId: string) => void) => (event: ThreeEvent<MouseEvent>) => void;
}

export function usePanelRaycast(): UsePanelRaycastResult {
  // Store lookup tables in refs to avoid re-renders
  const lookupByInstance = useRef<Map<string, PanelLookupEntry>>(new Map());
  const lookupById = useRef<Map<string, ExtendedPanelData>>(new Map());
  
  const buildLookupTable = useCallback((
    panelsByType: Record<PanelType, ClassifiedPanel[]>,
    allPanels: ClassifiedPanel[],
    allTopos: TopoPlacement[],
    coreConcreteMm: CoreConcreteMm
  ) => {
    const byInstance = new Map<string, PanelLookupEntry>();
    const byId = new Map<string, ExtendedPanelData>();
    
    const wallOuterThicknessMm = coreThicknessToWallThickness(coreConcreteMm);
    const topoType = getTopoType(coreConcreteMm);
    
    // Process each mesh type separately (since each InstancedMesh has its own instanceId space)
    const meshTypes: PanelType[] = ['FULL', 'CUT_SINGLE', 'CUT_DOUBLE', 'CORNER_CUT'];
    
    meshTypes.forEach((meshType) => {
      const panels = panelsByType[meshType] || [];
      panels.forEach((panel, instanceId) => {
        const panelId = panel.panelId || `${panel.chainId}:${panel.rowIndex}:exterior:${instanceId}:auto`;
        
        const extendedData: ExtendedPanelData = {
          panelId,
          parsedId: {
            chainId: panel.chainId,
            rowIndex: panel.rowIndex,
            side: 'exterior',
            slotIndex: instanceId,
            seedKey: 'auto',
          },
          startMm: panel.startMm ?? 0,
          endMm: panel.endMm ?? (panel.startMm ?? 0) + (panel.widthMm || 1200),
          lengthMm: panel.widthMm || 1200,
          widthMm: panel.widthMm || 1200,
          cutLeftMm: panel.cutLeftMm ?? 0,
          cutRightMm: panel.cutRightMm ?? 0,
          type: panel.type,
          isCornerPiece: panel.type === 'CORNER_CUT',
          isEndPiece: panel.type === 'END_CUT',
          isTopoPiece: panel.type === 'TOPO',
          chainId: panel.chainId,
          rowIndex: panel.rowIndex,
          rowParity: (panel.rowIndex % 2 === 0) ? 1 : 2,
          side: 'exterior',
          seedOrigin: panel.seedOrigin || 'none',
          nearestNodeId: panel.nearestNodeId || null,
          nearestNodeType: null,
          distanceToNodeMm: 0,
          position: panel.position || 'middle',
          ruleApplied: panel.ruleApplied || 'Standard layout',
          coreConcreteMm,
          wallOuterThicknessMm,
          topoType: panel.type === 'TOPO' ? topoType : null,
          hasOverride: false,
          isLocked: false,
        };
        
        const lookupKey = `${meshType}:${instanceId}`;
        byInstance.set(lookupKey, {
          instanceId,
          panelId,
          meshType: meshType as 'FULL' | 'CUT_SINGLE' | 'CUT_DOUBLE' | 'CORNER_CUT',
          panelData: extendedData,
        });
        
        byId.set(panelId, extendedData);
      });
    });
    
    // Process TOPOs
    allTopos.forEach((topo, instanceId) => {
      const panelId = `topo:${topo.junctionId || instanceId}`;
      const topoWidth = coreConcreteMm; // Topo width based on core thickness
      
      const extendedData: ExtendedPanelData = {
        panelId,
        parsedId: {
          chainId: topo.chainId || 'topo',
          rowIndex: topo.rowIndex,
          side: 'exterior',
          slotIndex: instanceId,
          seedKey: 'topo',
        },
        startMm: 0,
        endMm: topoWidth,
        lengthMm: topoWidth,
        widthMm: topoWidth,
        cutLeftMm: 0,
        cutRightMm: 0,
        type: 'TOPO',
        isCornerPiece: false,
        isEndPiece: false,
        isTopoPiece: true,
        chainId: topo.chainId || 'topo',
        rowIndex: topo.rowIndex,
        rowParity: (topo.rowIndex % 2 === 0) ? 1 : 2,
        side: 'exterior',
        seedOrigin: topo.reason === 'T_junction' ? 'T_junction' : 'free_end',
        nearestNodeId: topo.junctionId || null,
        nearestNodeType: topo.reason === 'T_junction' ? 'T' : 'end',
        distanceToNodeMm: 0,
        position: 'middle',
        ruleApplied: `Topo: ${topo.reason}`,
        coreConcreteMm,
        wallOuterThicknessMm,
        topoType,
        hasOverride: false,
        isLocked: false,
      };
      
      const lookupKey = `TOPO:${instanceId}`;
      byInstance.set(lookupKey, {
        instanceId,
        panelId,
        meshType: 'TOPO',
        panelData: extendedData,
      });
      
      byId.set(panelId, extendedData);
    });
    
    lookupByInstance.current = byInstance;
    lookupById.current = byId;
    
    console.log('[usePanelRaycast] Lookup table built:', {
      totalEntries: byInstance.size,
      panelEntries: byId.size,
    });
  }, []);
  
  const getPanelByInstanceId = useCallback((meshType: PanelType | 'TOPO', instanceId: number): PanelLookupEntry | null => {
    const key = `${meshType}:${instanceId}`;
    return lookupByInstance.current.get(key) || null;
  }, []);
  
  const getPanelById = useCallback((panelId: string): ExtendedPanelData | null => {
    return lookupById.current.get(panelId) || null;
  }, []);
  
  const getAllPanels = useCallback((): ExtendedPanelData[] => {
    return Array.from(lookupById.current.values());
  }, []);
  
  const handleMeshClick = useCallback((
    meshType: PanelType | 'TOPO',
    onSelect: (panelId: string) => void
  ) => {
    return (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      
      const instanceId = event.instanceId;
      if (instanceId === undefined) {
        console.log('[usePanelRaycast] Click event has no instanceId');
        return;
      }
      
      const entry = getPanelByInstanceId(meshType, instanceId);
      if (entry) {
        console.log('[usePanelRaycast] Panel clicked:', {
          meshType,
          instanceId,
          panelId: entry.panelId,
        });
        onSelect(entry.panelId);
      } else {
        console.log('[usePanelRaycast] No panel found for:', { meshType, instanceId });
      }
    };
  }, [getPanelByInstanceId]);
  
  return {
    buildLookupTable,
    getPanelByInstanceId,
    getPanelById,
    getAllPanels,
    handleMeshClick,
  };
}
