// ICF System Calculations for OMNI ICF WALLS 3D PLANNER

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
 * Identify junctions from wall segments
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
 * Calculate webs per row based on rebar spacing
 */
export function calculateWebsPerRow(rebarSpacingCm: number): number {
  return Math.ceil(20 / rebarSpacingCm) * 2;
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
 * Calculate complete BOM for a project
 */
export function calculateBOM(
  walls: WallSegment[],
  openings: Opening[],
  wallHeightMm: number,
  rebarSpacingCm: number,
  concreteThickness: ConcreteThickness,
  cornerMode: 'overlap_cut' | 'topo'
): BOMResult {
  const junctions = identifyJunctions(walls);
  const numberOfRows = calculateNumberOfRows(wallHeightMm);
  
  // Count junction types
  const junctionCounts = {
    L: junctions.filter(j => j.type === 'L').length,
    T: junctions.filter(j => j.type === 'T').length,
    X: junctions.filter(j => j.type === 'X').length,
    end: junctions.filter(j => j.type === 'end').length
  };
  
  // Calculate total wall length and panels
  let totalWallLength = 0;
  let totalPanels = 0;
  let totalCuts = 0;
  let totalCutLength = 0;
  
  walls.forEach(wall => {
    const length = calculateWallLength(wall);
    totalWallLength += length;
    
    const { fullPanels, cutLength, hasCut } = calculatePanelsForWall(length);
    totalPanels += fullPanels + (hasCut ? 1 : 0);
    
    if (hasCut) {
      totalCuts++;
      totalCutLength += cutLength;
    }
  });
  
  // Multiply by number of rows
  totalPanels *= numberOfRows;
  totalCuts *= numberOfRows;
  totalCutLength *= numberOfRows;
  
  // Calculate tarugos
  // Base: 2 tarugos per panel
  const tarugosBase = totalPanels * 2;
  
  // Adjustments per junction type (per row)
  // L: -1 per corner
  // T: +1 per T
  // X: +2 per X
  const adjustmentPerRow = 
    (junctionCounts.L * -1) +
    (junctionCounts.T * 1) +
    (junctionCounts.X * 2);
  
  const tarugosAdjustments = adjustmentPerRow * numberOfRows;
  const tarugosTotal = tarugosBase + tarugosAdjustments;
  
  // Injection tarugos (1 per meter of wall per row)
  const tarugosInjection = Math.ceil((totalWallLength / 1000) * numberOfRows);
  
  // Calculate webs
  const websPerRow = calculateWebsPerRow(rebarSpacingCm);
  const websTotal = websPerRow * numberOfRows * walls.length;
  const websExtra = rebarSpacingCm < 20 ? 
    Math.ceil((20 - rebarSpacingCm) / rebarSpacingCm) * numberOfRows * walls.length : 0;
  
  // Calculate topos
  let toposByReason = {
    tJunction: 0,
    xJunction: 0,
    openings: 0,
    corners: 0
  };
  
  // Topos for T and X junctions (alternating rows)
  const alternatingRows = Math.floor(numberOfRows / 2);
  toposByReason.tJunction = junctionCounts.T * alternatingRows;
  toposByReason.xJunction = junctionCounts.X * alternatingRows;
  
  // Topos for corners (if topo mode)
  if (cornerMode === 'topo') {
    toposByReason.corners = junctionCounts.L * alternatingRows;
  }
  
  // Topos for openings
  openings.forEach(opening => {
    const { units } = calculateToposForOpening(opening, concreteThickness);
    toposByReason.openings += units;
  });
  
  const toposUnits = 
    toposByReason.tJunction + 
    toposByReason.xJunction + 
    toposByReason.openings + 
    toposByReason.corners;
  
  const topoWidthM = parseInt(concreteThickness) / 1000;
  const toposMeters = toposUnits * topoWidthM * PANEL_HEIGHT / 1000;
  
  return {
    panelsCount: totalPanels,
    tarugosBase,
    tarugosAdjustments,
    tarugosTotal,
    tarugosInjection,
    toposUnits,
    toposMeters,
    toposByReason,
    websTotal: websTotal + websExtra,
    websPerRow,
    websExtra,
    cutsCount: totalCuts,
    cutsLengthMm: totalCutLength,
    numberOfRows,
    totalWallLength,
    junctionCounts
  };
}
