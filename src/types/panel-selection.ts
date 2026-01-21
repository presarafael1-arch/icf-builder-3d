/**
 * Panel Selection & Override System Types
 * 
 * Provides stable panel IDs, overrides, and selection capabilities
 */

import { PanelType, ChainClassification } from '@/lib/panel-layout';

// Core thickness detection from DXF wall spacing
export type CoreConcreteMm = 150 | 220;
export type WallOuterThicknessMm = 282 | 353; // 4×tooth or 5×tooth

// TOPO product types based on core concrete thickness
export type TopoType = 'TOPO_150' | 'TOPO_220';

// Junction/seed origin types
export type SeedOrigin = 'L_junction' | 'T_junction' | 'X_junction' | 'free_end' | 'middle' | 'none';

// Side of the wall (for dual-panel systems)
export type PanelSide = 'interior' | 'exterior';

// Panel position context
export type PanelPosition = 'first_from_node' | 'last_before_node' | 'middle' | 'single';

/**
 * Stable Panel ID structure
 * Format: `${chainId}:${rowIndex}:${side}:${slotIndex}:${seedKey}`
 */
export interface StablePanelId {
  chainId: string;
  rowIndex: number;
  side: PanelSide;
  slotIndex: number; // Position from start of chain in this row
  seedKey: string; // Hash of seed anchor (node A / node B / free end)
}

/**
 * Extended panel data with stable ID and context
 */
export interface ExtendedPanelData {
  // Stable ID (deterministic, survives recalc)
  panelId: string;
  parsedId: StablePanelId;
  
  // Position & geometry
  startMm: number;
  endMm: number;
  lengthMm: number;
  widthMm: number;
  cutLeftMm: number;
  cutRightMm: number;
  
  // Type & classification
  type: PanelType;
  isCornerPiece: boolean;
  isEndPiece: boolean;
  isTopoPiece: boolean;
  
  // Context
  chainId: string;
  rowIndex: number;
  rowParity: 1 | 2; // 1 = odd rows (0,2,4...), 2 = even rows (1,3,5...)
  side: PanelSide;
  chainClassification: ChainClassification;
  
  // Junction context
  seedOrigin: SeedOrigin;
  nearestNodeId: string | null;
  nearestNodeType: 'L' | 'T' | 'X' | 'end' | null;
  distanceToNodeMm: number;
  position: PanelPosition;
  
  // Rule applied (human-readable)
  ruleApplied: string;
  
  // Thickness context
  coreConcreteMm: CoreConcreteMm;
  wallOuterThicknessMm: WallOuterThicknessMm;
  topoType: TopoType | null;
  
  // Override tracking
  hasOverride: boolean;
  isLocked: boolean;
}

/**
 * Panel override definition
 */
export interface PanelOverride {
  panelId: string;
  
  // Type override
  overrideType?: PanelType;
  
  // Anchor/position override
  anchorOverride?: 'center_on_node' | 'first_after_node' | 'last_before_node' | null;
  
  // Position offset override (in mm, applied to startMm)
  offsetMm?: number;
  
  // Width override (in mm, for adjusting cuts)
  widthMm?: number;
  
  // Cut override (must be multiple of TOOTH)
  cutMm?: number;
  
  // Lock (prevent auto-recalc from changing this panel)
  isLocked: boolean;
  
  // Timestamps
  createdAt: string;
  updatedAt: string;
}

/**
 * Override conflict information
 */
export interface OverrideConflict {
  panelId: string;
  conflictType: 'overlap' | 'invalid_orange_position' | 'cut_not_tooth_multiple' | 'topo_at_wrong_position';
  message: string;
  severity: 'warning' | 'error';
}

/**
 * Selection state for the viewer
 */
export interface PanelSelectionState {
  selectedPanelId: string | null;
  hoveredPanelId: string | null;
  highlightedPanelIds: string[];
}

/**
 * Panel lookup table for instanceId -> panelId mapping
 */
export interface PanelLookupTable {
  // Maps instanceMesh instanceId to panelId
  instanceToPanel: Map<number, string>;
  // Maps panelId to extended data
  panelData: Map<string, ExtendedPanelData>;
  // Maps panelId to override
  overrides: Map<string, PanelOverride>;
}

/**
 * Wall thickness detection result
 */
export interface ThicknessDetectionResult {
  detected: boolean;
  wallOuterThicknessMm: WallOuterThicknessMm | null;
  coreConcreteMm: CoreConcreteMm | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  detectionMethod: 'parallel_lines' | 'user_input' | 'project_setting' | 'default' | 'manual_selection';
  message: string;
}

/**
 * Debug visualization options
 */
export interface DebugVisualizationOptions {
  showSeeds: boolean;
  showNodeAxes: boolean;
  showRunSegments: boolean;
  showIndexFromSeed: boolean;
  showMiddleZone: boolean;
  showWallThicknessDetection: boolean;
}

/**
 * Generate stable panel ID from components
 */
export function generatePanelId(
  chainId: string,
  rowIndex: number,
  side: PanelSide,
  slotIndex: number,
  seedKey: string
): string {
  return `${chainId}:${rowIndex}:${side}:${slotIndex}:${seedKey}`;
}

/**
 * Parse stable panel ID into components
 */
export function parsePanelId(panelId: string): StablePanelId | null {
  const parts = panelId.split(':');
  if (parts.length !== 5) return null;
  
  return {
    chainId: parts[0],
    rowIndex: parseInt(parts[1], 10),
    side: parts[2] as PanelSide,
    slotIndex: parseInt(parts[3], 10),
    seedKey: parts[4],
  };
}

/**
 * Get topo type based on core concrete thickness
 */
export function getTopoType(coreConcreteMm: CoreConcreteMm): TopoType {
  return coreConcreteMm === 150 ? 'TOPO_150' : 'TOPO_220';
}

/**
 * Convert wall outer thickness to core concrete thickness
 * Using tooth-based measurements: 4×tooth (282mm) or 5×tooth (353mm)
 */
export function wallThicknessToCoreThickness(wallThicknessMm: number): CoreConcreteMm | null {
  // 4×tooth ≈ 282mm → 150mm core
  if (Math.abs(wallThicknessMm - 282) < 20) return 150;
  // 5×tooth ≈ 353mm → 220mm core
  if (Math.abs(wallThicknessMm - 353) < 20) return 220;
  return null;
}

/**
 * Convert core concrete thickness to wall outer thickness
 */
export function coreThicknessToWallThickness(coreConcreteMm: CoreConcreteMm): WallOuterThicknessMm {
  return coreConcreteMm === 150 ? 282 : 353;
}
