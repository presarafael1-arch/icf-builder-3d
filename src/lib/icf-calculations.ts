// ICF System Calculations for OMNI ICF WALLS 3D PLANNER
// Updated to use chain-based calculation for accurate BOM

import { 
  PANEL_WIDTH, 
  PANEL_HEIGHT, 
  WallSegment, 
  Junction, 
  Opening, 
  BOMResult,
  ConcreteThickness,
  JunctionType
} from '@/types/icf';
import { buildWallChains, calculateBOMFromChains, ChainsResult, WallChainOptions } from './wall-chains';

/**
 * Calculate the number of rows based on wall height
 */
export function calculateNumberOfRows(wallHeightMm: number): number {
  return Math.ceil(wallHeightMm / PANEL_HEIGHT);
}

/**
 * Calculate the length of a wall segment
 */
export function calculateWallLength(wall: WallSegment): number {
  return Math.sqrt(
    Math.pow(wall.endX - wall.startX, 2) + 
    Math.pow(wall.endY - wall.startY, 2)
  );
}

/**
 * Calculate the angle of a wall segment (in radians)
 */
export function calculateWallAngle(wall: WallSegment): number {
  return Math.atan2(wall.endY - wall.startY, wall.endX - wall.startX);
}

/**
 * Calculate number of panels needed for a wall segment
 */
export function calculatePanelsForWall(wallLengthMm: number): { 
  fullPanels: number; 
  cutLength: number; 
  hasCut: boolean 
} {
  const fullPanels = Math.floor(wallLengthMm / PANEL_WIDTH);
  const remainder = wallLengthMm % PANEL_WIDTH;
  
  return {
    fullPanels,
    cutLength: remainder,
    hasCut: remainder > 0
  };
}

/**
 * Identify junctions from wall segments (legacy - for compatibility)
 */
export function identifyJunctions(walls: WallSegment[]): Junction[] {
  const pointMap = new Map<string, { x: number; y: number; wallIds: string[]; angles: number[] }>();
  
  // Tolerance for point matching (in mm)
  const TOLERANCE = 10;
  
  const getPointKey = (x: number, y: number): string => {
    const roundedX = Math.round(x / TOLERANCE) * TOLERANCE;
    const roundedY = Math.round(y / TOLERANCE) * TOLERANCE;
    return `${roundedX},${roundedY}`;
  };
  
  walls.forEach(wall => {
    const startKey = getPointKey(wall.startX, wall.startY);
    const endKey = getPointKey(wall.endX, wall.endY);
    const angle = calculateWallAngle(wall);
    
    // Start point
    if (!pointMap.has(startKey)) {
      pointMap.set(startKey, { 
        x: wall.startX, 
        y: wall.startY, 
        wallIds: [], 
        angles: [] 
      });
    }
    const startPoint = pointMap.get(startKey)!;
    startPoint.wallIds.push(wall.id);
    startPoint.angles.push(angle);
    
    // End point
    if (!pointMap.has(endKey)) {
      pointMap.set(endKey, { 
        x: wall.endX, 
        y: wall.endY, 
        wallIds: [], 
        angles: [] 
      });
    }
    const endPoint = pointMap.get(endKey)!;
    endPoint.wallIds.push(wall.id);
    endPoint.angles.push(angle + Math.PI); // Reverse angle for end point
  });
  
  const junctions: Junction[] = [];
  let junctionId = 0;
  
  pointMap.forEach((point) => {
    const wallCount = point.wallIds.length;
    let type: JunctionType;
    
    if (wallCount === 1) {
      type = 'end';
    } else if (wallCount === 2) {
      type = 'L';
    } else if (wallCount === 3) {
      type = 'T';
    } else {
      type = 'X';
    }
    
    junctions.push({
      id: `junction-${junctionId++}`,
      x: point.x,
      y: point.y,
      type,
      connectedWallIds: point.wallIds,
      angles: point.angles
    });
  });
  
  return junctions;
}

/**
 * Calculate webs per panel based on rebar spacing
 * 20cm = 2 webs (standard), 15cm = 3 webs (+1), 10cm = 4 webs (+2)
 */
export function calculateWebsPerPanel(rebarSpacingCm: number): number {
  if (rebarSpacingCm <= 10) return 4;
  if (rebarSpacingCm <= 15) return 3;
  return 2; // 20cm or more
}

/**
 * Get webs label for UI
 */
export function getWebsLabel(rebarSpacingCm: number): string {
  if (rebarSpacingCm === 20) return '20 cm (standard, 2 webs)';
  if (rebarSpacingCm === 15) return '15 cm (+1 web extra, 3 webs)';
  if (rebarSpacingCm === 10) return '10 cm (+2 webs extra, 4 webs)';
  return `${rebarSpacingCm} cm`;
}

/**
 * Calculate webs per row based on rebar spacing (legacy)
 */
export function calculateWebsPerRow(rebarSpacingCm: number): number {
  return calculateWebsPerPanel(rebarSpacingCm);
}

/**
 * Calculate grid rows for stabilization
 * Default: bottom, middle, and top rows
 */
export function calculateGridRows(numberOfRows: number): number[] {
  if (numberOfRows <= 1) return [0];
  if (numberOfRows === 2) return [0, 1];
  
  const middleRow = Math.floor(numberOfRows / 2);
  return [0, middleRow, numberOfRows - 1];
}

/**
 * Calculate grids per row based on total wall length
 * Grids are sold in 3m units
 */
export function calculateGridsPerRow(totalWallLengthMm: number): number {
  const totalLengthM = totalWallLengthMm / 1000;
  return Math.ceil(totalLengthM / 3.0);
}

/**
 * Calculate topos needed for openings
 */
export function calculateToposForOpening(
  opening: Opening, 
  concreteThickness: ConcreteThickness
): { units: number; meters: number } {
  const rowsAffected = Math.ceil(opening.heightMm / PANEL_HEIGHT);
  const topoWidth = parseInt(concreteThickness); // 150 or 200 mm
  
  // 2 topos per side (left and right of opening)
  const units = 2 * rowsAffected;
  const meters = 2 * (opening.widthMm / 1000) * rowsAffected;
  
  return { units, meters };
}

/**
 * Build chains from walls and return the result for reuse
 */
export function getWallChains(walls: WallSegment[], options?: WallChainOptions): ChainsResult {
  return buildWallChains(walls, options);
}

/**
 * Calculate complete BOM for a project using chain-based calculation
 * HARD RULE:
 * - If chains exist, BOM uses ONLY chains.
 * - If chains are empty, fallback to segment-based estimation (and mark as fallback via chainsCount=0).
 */
export function calculateBOM(
  walls: WallSegment[],
  openings: Opening[],
  wallHeightMm: number,
  rebarSpacingCm: number,
  concreteThickness: ConcreteThickness,
  cornerMode: 'overlap_cut' | 'topo',
  gridSettings?: { base: boolean; mid: boolean; top: boolean }
): BOMResult {
  const numberOfRows = calculateNumberOfRows(wallHeightMm);

  // Use auto-tuned chains for best results
  // This tries conservative, normal, aggressive and picks the one with lowest wastePct
  const autoTunedResult = require('./wall-chains').buildWallChainsAutoTuned(walls);
  const chainsResult = autoTunedResult;

  const hasChains = chainsResult.chains.length > 0;

  // Use chain-based calculation (preferred)
  const chainBOM = hasChains
    ? calculateBOMFromChains(
        chainsResult,
        numberOfRows,
        rebarSpacingCm as 10 | 15 | 20,
        parseInt(concreteThickness),
        cornerMode,
        gridSettings || { base: true, mid: false, top: false }
      )
    : null;

  // Add openings topos (current opening rule in this file)
  let openingsTopos = 0;
  let openingsToposMeters = 0;
  openings.forEach((opening) => {
    const { units, meters } = calculateToposForOpening(opening, concreteThickness);
    openingsTopos += units;
    openingsToposMeters += meters;
  });

  if (!chainBOM) {
    // Fallback: do NOT attempt full old logic; provide safe minimal values + warning-friendly stats.
    // This keeps the UI functional while clearly indicating fallback.
    const totalWallLength = walls.reduce((sum, w) => sum + calculateWallLength(w), 0);
    const expectedPanelsApprox = Math.ceil(totalWallLength / PANEL_WIDTH) * numberOfRows;

    return {
      panelsCount: expectedPanelsApprox,
      panelsPerFiada: Math.ceil(totalWallLength / PANEL_WIDTH),

      tarugosBase: expectedPanelsApprox * 2,
      tarugosAdjustments: 0,
      tarugosTotal: expectedPanelsApprox * 2,
      tarugosInjection: expectedPanelsApprox,

      toposUnits: openingsTopos,
      toposMeters: openingsToposMeters,
      toposByReason: {
        tJunction: 0,
        xJunction: 0,
        openings: openingsTopos,
        corners: 0,
      },

      websTotal: expectedPanelsApprox * calculateWebsPerPanel(rebarSpacingCm),
      websPerRow: calculateWebsPerPanel(rebarSpacingCm),
      websPerPanel: calculateWebsPerPanel(rebarSpacingCm),

      gridsTotal: Math.ceil((totalWallLength / 1000) / 3) * 1,
      gridsPerRow: Math.ceil((totalWallLength / 1000) / 3),
      gridRows: [0],
      gridType: concreteThickness,

      cutsCount: 0,
      cutsLengthMm: 0,
      wasteTotal: 0,

      numberOfRows,
      totalWallLength,
      junctionCounts: { L: 0, T: 0, X: 0, end: 0 },
      chainsCount: 0,

      // extra diagnostics fields (optional)
      expectedPanelsApprox,
      wastePct: 0,
      totalChainLengthMm: totalWallLength,
    } as BOMResult;
  }

  return {
    panelsCount: chainBOM.panelsCount,
    panelsPerFiada: chainBOM.panelsPerFiada,

    tarugosBase: chainBOM.tarugosBase,
    tarugosAdjustments: chainBOM.tarugosAdjustments,
    tarugosTotal: chainBOM.tarugosTotal,

    tarugosInjection: chainBOM.tarugosInjection,

    toposUnits: chainBOM.toposUnits + openingsTopos,
    toposMeters: chainBOM.toposMeters + openingsToposMeters,
    toposByReason: {
      ...chainBOM.toposByReason,
      openings: openingsTopos,
    },

    websTotal: chainBOM.websTotal,
    websPerRow: chainBOM.websPerPanel,
    websPerPanel: chainBOM.websPerPanel,

    gridsTotal: chainBOM.gridsTotal,
    gridsPerRow: chainBOM.gridsPerFiada,
    gridRows: chainBOM.gridRows,
    gridType: concreteThickness,

    cutsCount: chainBOM.cutsCount,
    cutsLengthMm: chainBOM.wasteTotal,
    wasteTotal: chainBOM.wasteTotal,

    numberOfRows: chainBOM.numberOfRows,
    totalWallLength: chainBOM.totalWallLength,
    junctionCounts: chainBOM.junctionCounts,

    chainsCount: chainBOM.chainsCount,

    // diagnostics
    wastePct: chainBOM.wastePct,
    expectedPanelsApprox: chainBOM.expectedPanelsApprox,
    totalChainLengthMm: chainBOM.totalWallLength,
  } as BOMResult;
}
