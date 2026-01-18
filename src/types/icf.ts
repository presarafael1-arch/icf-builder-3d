// ICF System Types for OMNI ICF WALLS 3D PLANNER

// Panel dimensions (in mm)
// Each ICF panel: 1200 x 400mm
export const PANEL_WIDTH = 1200;
export const PANEL_HEIGHT = 400;

// Tooth = 1200/17 ≈ 70.588mm (fundamental unit for ICF system)
export const TOOTH = PANEL_WIDTH / 17; // ≈ 70.588mm

// Foam panel thickness = 1 tooth per side
export const FOAM_THICKNESS = TOOTH; // ≈ 70.59mm per side

// Wall total thickness based on concrete core (centered on DXF line):
// - 150mm concrete option: 4 × tooth = 282.35mm total (foam + 2×tooth betão + foam)
// - 220mm concrete option: 5 × tooth = 352.94mm total (foam + 3×tooth betão + foam)
export const WALL_THICKNESS_150 = TOOTH * 4; // ≈ 282.35mm (for ~150mm concrete)
export const WALL_THICKNESS_220 = TOOTH * 5; // ≈ 352.94mm (for ~220mm concrete)

// Concrete core thickness:
// - 150mm option: 2 × tooth ≈ 141.18mm
// - 220mm option: 3 × tooth ≈ 211.76mm
export const CONCRETE_CORE_150 = TOOTH * 2; // ≈ 141.18mm
export const CONCRETE_CORE_220 = TOOTH * 3; // ≈ 211.76mm

// Legacy constant for backwards compatibility
export const PANEL_THICKNESS = FOAM_THICKNESS;

// Helper function to get total wall thickness based on concrete thickness
export function getWallTotalThickness(concreteThickness: ConcreteThickness): number {
  return concreteThickness === '150' ? WALL_THICKNESS_150 : WALL_THICKNESS_220;
}

// Helper function to get concrete thickness in mm
export function getConcreteThicknessMm(concreteThickness: ConcreteThickness): number {
  return concreteThickness === '150' ? CONCRETE_CORE_150 : CONCRETE_CORE_220;
}

// Core thickness options
export type ConcreteThickness = '150' | '200';

// Corner modes
export type CornerMode = 'overlap_cut' | 'topo';

// Junction types
export type JunctionType = 'L' | 'T' | 'X' | 'end';

// Row types for T-junction alternation
export type RowType = 'type1' | 'type2';

// Opening types
export type OpeningType = 'door' | 'window';

// Project parameters
export interface ProjectParams {
  id: string;
  name: string;
  description?: string;
  concreteThickness: ConcreteThickness;
  wallHeightMm: number;
  rebarSpacingCm: number;
  cornerMode: CornerMode;
  dxfFileUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Wall segment from DXF/editor
export interface WallSegment {
  id: string;
  projectId: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  layerName?: string;
  length: number; // Calculated
  angle: number; // Calculated
}

// Opening (door/window) - Legacy interface for backwards compatibility
export interface Opening {
  id: string;
  wallId: string;
  type: OpeningType;
  widthMm: number;
  heightMm: number;
  sillHeightMm: number;
  positionMm: number; // Position along the wall
  chainId?: string; // Reference to chain for new system
}

// Junction node in the wall graph
export interface Junction {
  id: string;
  x: number;
  y: number;
  type: JunctionType;
  connectedWallIds: string[];
  angles: number[]; // Angles of connected walls
}

// Panel placement in 3D
export interface PanelPlacement {
  id: string;
  wallId: string;
  row: number;
  positionAlongWall: number;
  isCut: boolean;
  cutLength?: number;
  x: number;
  y: number;
  z: number;
  rotationY: number;
}

// Topo placement in 3D
export interface TopoPlacement {
  id: string;
  row: number;
  reason: 'T_junction' | 'X_junction' | 'opening' | 'corner';
  x: number;
  y: number;
  z: number;
  rotationY: number;
  width: number; // Based on concrete thickness
}

// Web placement
export interface WebPlacement {
  id: string;
  wallId: string;
  row: number;
  positionAlongWall: number;
  x: number;
  y: number;
  z: number;
  rotationY: number;
}

// Rebar spacing options (discrete: 20cm standard, 15cm +1 web, 10cm +2 webs)
export type RebarSpacing = 10 | 15 | 20;

// View mode for 3D viewer
export type ViewMode = 'lines' | 'panels' | 'both';

// BOM (Bill of Materials) calculation result
export interface BOMResult {
  // Panels
  panelsCount: number;
  panelsPerFiada?: number; // Panels per row

  // Tarugos
  tarugosBase: number;
  tarugosAdjustments: number; // Sum of L, T, X adjustments
  tarugosTotal: number;

  // Injection tarugos
  tarugosInjection: number;

  // Topos
  toposUnits: number;
  toposMeters: number;
  toposByReason: {
    tJunction: number;
    xJunction: number;
    openings: number;
    corners: number;
  };

  // Webs
  websTotal: number;
  websPerRow: number;
  websPerPanel?: number; // 2, 3, or 4 based on rebar spacing

  // Grids (stabilization)
  gridsTotal: number;
  gridsPerRow: number;
  gridRows: number[]; // Which rows have grids (0-indexed)
  gridType: ConcreteThickness; // 150 or 200

  // Cuts
  cutsCount: number;
  cutsLengthMm: number;
  wasteTotal?: number; // Total waste in mm

  // Summary
  numberOfRows: number;
  totalWallLength: number;
  junctionCounts: {
    L: number;
    T: number;
    X: number;
    end: number;
  };

  // Chains (for chain-based calculation)
  chainsCount?: number;

  // Diagnostics (bin packing)
  totalChainLengthMm?: number;
  wastePct?: number; // waste / supplied (from bin packing)
  expectedPanelsApprox?: number; // minimum theoretical: ceil(totalLength/1200) * fiadas
  minPanelsPerFiada?: number; // ceil(totalLength/1200)
  binsUsedPerFiada?: number; // bins from FFD packing
  sumFullPanelsPerFiada?: number; // full panels before packing
  remaindersCount?: number; // number of chains with remainder
  roundingWasteMmPerFiada?: number; // waste per fiada from packing
}

// 3D Viewer settings
export interface ViewerSettings {
  // View mode
  viewMode: ViewMode; // 'lines' | 'panels' | 'both'

  // Debug / sanity layers
  showDXFLines: boolean; // Draw imported walls as line segments (gray, debug)
  showChains: boolean; // Draw consolidated chains (cyan, thicker)
  showHelpers: boolean; // Axes + bbox helpers (debug)

  // Render layers
  showPanels: boolean;
  showTopos: boolean;
  showWebs: boolean;
  showTarugos: boolean;
  showOpenings: boolean;
  showJunctions: boolean;
  showGrid: boolean;
  showGrids: boolean; // Stabilization grids

  // View / params
  currentRow: number;
  maxRows: number;
  wireframe: boolean;
  rebarSpacing: RebarSpacing;
  concreteThickness: ConcreteThickness;
  
  // Panel geometry mode
  highFidelityPanels: boolean; // Use detailed/GLB geometry instead of simple boxes (default OFF)
  showOutlines: boolean; // Show panel outlines (default ON)
  
  // Debug visualization options (panel inspection)
  showSeeds: boolean; // Show seed markers at junction nodes
  showNodeAxes: boolean; // Show T-junction axes
  showRunSegments: boolean; // Different colors per run
  showIndexFromSeed: boolean; // Overlay index numbers
  showMiddleZone: boolean; // Zone where orange cuts are allowed
  showThicknessDetection: boolean; // Show wall thickness detection info
  showLJunctionArrows: boolean; // Show primary/secondary arrows at L-junctions
}

// DXF parsing result
export interface DXFParseResult {
  walls: Array<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    layer: string;
  }>;
  layers: string[];
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
}
