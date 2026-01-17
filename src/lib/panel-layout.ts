/**
 * Panel Layout Engine for ICF Walls
 * 
 * RULES:
 * - TOOTH = 1200/17 ≈ 70.588mm (minimum step for cuts/offsets)
 * - Standard panel = 1200mm x 400mm
 * 
 * COLORS:
 * - YELLOW (FULL): full panel
 * - RED (CORNER_CUT): corner/node start cut (only at L/T nodes)
 * - ORANGE (CUT_DOUBLE): adjustment cut in the MIDDLE of run
 * - GREEN (TOPO): topo product (at T-junctions and free ends)
 * 
 * L-CORNER RULES:
 *   - Row 1 (index 0): EXTERIOR = FULL, INTERIOR = CORNER_CUT (1*TOOTH cut)
 *   - Row 2 (index 1): BOTH EXTERIOR and INTERIOR = CORNER_CUT (1*TOOTH cut)
 *   
 * T-JUNCTION RULES:
 *   - "Costas" = continuous wall (main)
 *   - "Perna" = perpendicular branch
 *   - Row 1 (index 0): COSTAS = TOPO at T + full panels; PERNA = full panels from T
 *   - Row 2 (index 1): COSTAS = full panels; PERNA = CORNER_CUT + full panels
 *   
 * FREE ENDS (ponta livre):
 *   - Must have TOPO to close for concrete fill (ALWAYS)
 *   - Cut at end if length not multiple of 1200 (termination cut)
 *   
 * FILL STRATEGY:
 *   - Start from BOTH ends (from nodes)
 *   - Fill with full panels toward middle
 *   - Any adjustment cut (ORANGE) goes in the MIDDLE only
 *   - NEVER place orange cuts near corners/T/ends
 */

import { WallChain, ChainNode } from './wall-chains';
import * as THREE from 'three';
import { PANEL_WIDTH, PANEL_HEIGHT } from '@/types/icf';

// Scale factor: mm to meters
const SCALE = 0.001;

// TOOTH = 1200/17 - minimum cut/offset step (~70.588mm)
export const TOOTH = PANEL_WIDTH / 17;

// Minimum cut length to place a panel
const MIN_CUT_MM = TOOTH;

// Panel types
export type PanelType = 'FULL' | 'CUT_SINGLE' | 'CUT_DOUBLE' | 'CORNER_CUT' | 'TOPO' | 'END_CUT';

// Classified panel placement
export interface ClassifiedPanel {
  matrix: THREE.Matrix4;
  type: PanelType;
  widthMm: number;
  rowIndex: number;
  chainId: string;
  isCornerPiece: boolean;
  isTopoPiece?: boolean;
  isEndPiece?: boolean;
}

// Topo placement for T-junctions and free ends
export interface TopoPlacement {
  matrix: THREE.Matrix4;
  rowIndex: number;
  chainId: string;
  junctionId: string;
  reason: 'T_junction' | 'free_end';
}

// L-junction info
export interface LJunctionInfo {
  nodeId: string;
  x: number;
  y: number;
  primaryChainId: string;
  secondaryChainId: string;
  primaryAngle: number;
  secondaryAngle: number;
}

// T-junction info
export interface TJunctionInfo {
  nodeId: string;
  x: number;
  y: number;
  mainChainIds: [string, string]; // The two colinear chains (costas)
  branchChainId: string;          // The perpendicular branch (perna)
  mainAngle: number;
  branchAngle: number;
}

// Endpoint info for free-end detection
interface EndpointInfo {
  x: number;
  y: number;
  chainId: string;
  isStart: boolean; // true = chain start, false = chain end
  degree: number;   // how many chains connect here
}

/**
 * Detect L-junctions (exactly 2 chains meeting at ~90°)
 * Uses deterministic ordering: lower chainId = primary (exterior role in row 1)
 */
export function detectLJunctions(chains: WallChain[]): LJunctionInfo[] {
  const nodeMap = new Map<string, { x: number; y: number; chainIds: string[]; angles: number[]; isStarts: boolean[] }>();
  const TOLERANCE = 20; // mm
  
  const getNodeKey = (x: number, y: number) => {
    const rx = Math.round(x / TOLERANCE) * TOLERANCE;
    const ry = Math.round(y / TOLERANCE) * TOLERANCE;
    return `${rx},${ry}`;
  };
  
  chains.forEach(chain => {
    const angle = Math.atan2(chain.endY - chain.startY, chain.endX - chain.startX);
    
    // Start node
    const startKey = getNodeKey(chain.startX, chain.startY);
    if (!nodeMap.has(startKey)) {
      nodeMap.set(startKey, { x: chain.startX, y: chain.startY, chainIds: [], angles: [], isStarts: [] });
    }
    const startNode = nodeMap.get(startKey)!;
    if (!startNode.chainIds.includes(chain.id)) {
      startNode.chainIds.push(chain.id);
      startNode.angles.push(angle); // outgoing angle
      startNode.isStarts.push(true);
    }
    
    // End node
    const endKey = getNodeKey(chain.endX, chain.endY);
    if (!nodeMap.has(endKey)) {
      nodeMap.set(endKey, { x: chain.endX, y: chain.endY, chainIds: [], angles: [], isStarts: [] });
    }
    const endNode = nodeMap.get(endKey)!;
    if (!endNode.chainIds.includes(chain.id)) {
      endNode.chainIds.push(chain.id);
      endNode.angles.push(angle + Math.PI); // incoming angle (reversed)
      endNode.isStarts.push(false);
    }
  });
  
  const lJunctions: LJunctionInfo[] = [];
  
  nodeMap.forEach((node, key) => {
    if (node.chainIds.length !== 2) return;
    
    // Check if angles are roughly perpendicular
    let angleDiff = Math.abs(node.angles[0] - node.angles[1]);
    // Normalize to [0, π]
    while (angleDiff > Math.PI) angleDiff -= Math.PI;
    const isLShape = Math.abs(angleDiff - Math.PI / 2) < 0.35; // ~20° tolerance
    
    if (!isLShape) return;
    
    // DETERMINISTIC: Lower chainId = primary arm
    const [id1, id2] = node.chainIds;
    const primaryChainId = id1 < id2 ? id1 : id2;
    const secondaryChainId = id1 < id2 ? id2 : id1;
    const primaryIdx = node.chainIds.indexOf(primaryChainId);
    const secondaryIdx = 1 - primaryIdx;
    
    lJunctions.push({
      nodeId: key,
      x: node.x,
      y: node.y,
      primaryChainId,
      secondaryChainId,
      primaryAngle: node.angles[primaryIdx],
      secondaryAngle: node.angles[secondaryIdx],
    });
    
    console.log(`[detectLJunctions] Found L at (${node.x.toFixed(0)}, ${node.y.toFixed(0)}): primary=${primaryChainId}, secondary=${secondaryChainId}`);
  });
  
  return lJunctions;
}

/**
 * Detect T-junctions (exactly 3 chains meeting, 2 colinear + 1 perpendicular)
 */
export function detectTJunctions(chains: WallChain[]): TJunctionInfo[] {
  const nodeMap = new Map<string, { x: number; y: number; chainIds: string[]; angles: number[] }>();
  const TOLERANCE = 20; // mm
  
  const getNodeKey = (x: number, y: number) => {
    const rx = Math.round(x / TOLERANCE) * TOLERANCE;
    const ry = Math.round(y / TOLERANCE) * TOLERANCE;
    return `${rx},${ry}`;
  };
  
  const getChainAngle = (chain: WallChain) => Math.atan2(chain.endY - chain.startY, chain.endX - chain.startX);
  
  chains.forEach(chain => {
    const angle = getChainAngle(chain);
    
    // Start node
    const startKey = getNodeKey(chain.startX, chain.startY);
    if (!nodeMap.has(startKey)) {
      nodeMap.set(startKey, { x: chain.startX, y: chain.startY, chainIds: [], angles: [] });
    }
    const startNode = nodeMap.get(startKey)!;
    if (!startNode.chainIds.includes(chain.id)) {
      startNode.chainIds.push(chain.id);
      startNode.angles.push(angle);
    }
    
    // End node
    const endKey = getNodeKey(chain.endX, chain.endY);
    if (!nodeMap.has(endKey)) {
      nodeMap.set(endKey, { x: chain.endX, y: chain.endY, chainIds: [], angles: [] });
    }
    const endNode = nodeMap.get(endKey)!;
    if (!endNode.chainIds.includes(chain.id)) {
      endNode.chainIds.push(chain.id);
      endNode.angles.push(angle + Math.PI); // Reverse angle for end
    }
  });
  
  const tJunctions: TJunctionInfo[] = [];
  
  nodeMap.forEach((node, key) => {
    if (node.chainIds.length !== 3) return;
    
    // Find the two colinear chains (MAIN/costas) and the perpendicular one (BRANCH/perna)
    const { chainIds, angles } = node;
    
    let mainPair: [number, number] | null = null;
    let branchIdx: number = -1;
    
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        let diff = Math.abs(angles[i] - angles[j]);
        while (diff > Math.PI) diff -= Math.PI;
        // Close to 0 or π means colinear (opposite directions)
        if (diff < 0.35 || Math.abs(diff - Math.PI) < 0.35) {
          mainPair = [i, j];
          branchIdx = 3 - i - j; // The remaining index
          break;
        }
      }
      if (mainPair) break;
    }
    
    if (!mainPair || branchIdx < 0) return;
    
    tJunctions.push({
      nodeId: key,
      x: node.x,
      y: node.y,
      mainChainIds: [chainIds[mainPair[0]], chainIds[mainPair[1]]],
      branchChainId: chainIds[branchIdx],
      mainAngle: angles[mainPair[0]],
      branchAngle: angles[branchIdx],
    });
  });
  
  return tJunctions;
}

/**
 * Detect free ends (endpoints with degree 1 - only one chain connects)
 */
function detectFreeEnds(chains: WallChain[]): EndpointInfo[] {
  const nodeMap = new Map<string, EndpointInfo[]>();
  const TOLERANCE = 20; // mm
  
  const getNodeKey = (x: number, y: number) => {
    const rx = Math.round(x / TOLERANCE) * TOLERANCE;
    const ry = Math.round(y / TOLERANCE) * TOLERANCE;
    return `${rx},${ry}`;
  };
  
  chains.forEach(chain => {
    // Start
    const startKey = getNodeKey(chain.startX, chain.startY);
    if (!nodeMap.has(startKey)) nodeMap.set(startKey, []);
    nodeMap.get(startKey)!.push({ x: chain.startX, y: chain.startY, chainId: chain.id, isStart: true, degree: 0 });
    
    // End
    const endKey = getNodeKey(chain.endX, chain.endY);
    if (!nodeMap.has(endKey)) nodeMap.set(endKey, []);
    nodeMap.get(endKey)!.push({ x: chain.endX, y: chain.endY, chainId: chain.id, isStart: false, degree: 0 });
  });
  
  const freeEnds: EndpointInfo[] = [];
  
  nodeMap.forEach((endpoints) => {
    // Count unique chains at this node
    const uniqueChainIds = new Set(endpoints.map(e => e.chainId));
    const degree = uniqueChainIds.size;
    
    // Free end = only 1 chain connects here
    if (degree === 1) {
      endpoints.forEach(ep => {
        freeEnds.push({ ...ep, degree: 1 });
      });
    }
  });
  
  return freeEnds;
}

/**
 * Get detailed endpoint info for a chain
 */
function getChainEndpointInfo(
  chain: WallChain,
  lJunctions: LJunctionInfo[],
  tJunctions: TJunctionInfo[],
  freeEnds: EndpointInfo[],
  tolerance: number = 25
): { 
  startType: 'L' | 'T' | 'free' | 'none';
  endType: 'L' | 'T' | 'free' | 'none';
  startL: LJunctionInfo | null;
  endL: LJunctionInfo | null;
  startT: TJunctionInfo | null;
  endT: TJunctionInfo | null;
  // For L: is this chain the "primary" (exterior in row 1)?
  isPrimaryAtStart: boolean;
  isPrimaryAtEnd: boolean;
  // For T: is this chain the "branch" (perna)?
  isBranchAtStart: boolean;
  isBranchAtEnd: boolean;
  // For free ends
  hasFreeStart: boolean;
  hasFreeEnd: boolean;
} {
  let startType: 'L' | 'T' | 'free' | 'none' = 'none';
  let endType: 'L' | 'T' | 'free' | 'none' = 'none';
  let startL: LJunctionInfo | null = null;
  let endL: LJunctionInfo | null = null;
  let startT: TJunctionInfo | null = null;
  let endT: TJunctionInfo | null = null;
  let isPrimaryAtStart = false;
  let isPrimaryAtEnd = false;
  let isBranchAtStart = false;
  let isBranchAtEnd = false;
  let hasFreeStart = false;
  let hasFreeEnd = false;
  
  // Check L-junctions
  for (const lj of lJunctions) {
    const distToStart = Math.sqrt((chain.startX - lj.x) ** 2 + (chain.startY - lj.y) ** 2);
    const distToEnd = Math.sqrt((chain.endX - lj.x) ** 2 + (chain.endY - lj.y) ** 2);
    
    if (distToStart < tolerance) {
      startType = 'L';
      startL = lj;
      isPrimaryAtStart = lj.primaryChainId === chain.id;
    }
    if (distToEnd < tolerance) {
      endType = 'L';
      endL = lj;
      isPrimaryAtEnd = lj.primaryChainId === chain.id;
    }
  }
  
  // Check T-junctions
  for (const tj of tJunctions) {
    const distToStart = Math.sqrt((chain.startX - tj.x) ** 2 + (chain.startY - tj.y) ** 2);
    const distToEnd = Math.sqrt((chain.endX - tj.x) ** 2 + (chain.endY - tj.y) ** 2);
    
    if (distToStart < tolerance) {
      startType = 'T';
      startT = tj;
      isBranchAtStart = tj.branchChainId === chain.id;
    }
    if (distToEnd < tolerance) {
      endType = 'T';
      endT = tj;
      isBranchAtEnd = tj.branchChainId === chain.id;
    }
  }
  
  // Check free ends
  for (const fe of freeEnds) {
    if (fe.chainId !== chain.id) continue;
    
    if (fe.isStart) {
      if (startType === 'none') startType = 'free';
      hasFreeStart = true;
    } else {
      if (endType === 'none') endType = 'free';
      hasFreeEnd = true;
    }
  }
  
  return {
    startType, endType,
    startL, endL, startT, endT,
    isPrimaryAtStart, isPrimaryAtEnd,
    isBranchAtStart, isBranchAtEnd,
    hasFreeStart, hasFreeEnd
  };
}

/**
 * Round a length to nearest TOOTH multiple (for clean cuts)
 */
function roundToTooth(mm: number): number {
  return Math.round(mm / TOOTH) * TOOTH;
}

/**
 * Determine the start reservation (cap) for a chain endpoint
 * 
 * L-CORNER RULES:
 *   - Row 1 (index 0): primary (exterior) = FULL, secondary (interior) = 1*TOOTH cut (RED)
 *   - Row 2 (index 1): both = 1*TOOTH cut (RED)
 *   
 * T-JUNCTION RULES:
 *   - Row 1 (index 0): COSTAS = TOPO + FULL panels; PERNA = FULL from T
 *   - Row 2 (index 1): COSTAS = FULL panels; PERNA = all RED cuts
 *   
 * FREE END:
 *   - Always TOPO to close
 *   - Panel length may need end cut if not multiple of 1200
 */
interface CapResult {
  reservationMm: number;
  type: PanelType;
  addTopo: boolean;
  topoId: string;
}

function getStartCap(
  chain: WallChain,
  endpointInfo: ReturnType<typeof getChainEndpointInfo>,
  row: number
): CapResult {
  const isRow1 = row === 0;  // Index 0 = Row 1
  const isRow2 = row === 1;  // Index 1 = Row 2
  
  let reservationMm = PANEL_WIDTH;
  let type: PanelType = 'FULL';
  let addTopo = false;
  let topoId = '';
  
  switch (endpointInfo.startType) {
    case 'L':
      // =============================================
      // L-CORNER RULES (at chain START):
      // - Row 1 (index 0): EXTERIOR (primary) = FULL, INTERIOR (secondary) = CORNER_CUT
      // - Row 2 (index 1): BOTH = CORNER_CUT (all 4 panels)
      // =============================================
      if (isRow1) {
        // ROW 1: exterior = FULL, interior = CORNER_CUT (RED)
        if (endpointInfo.isPrimaryAtStart) {
          // PRIMARY chain = exterior arm → FULL panel
          reservationMm = PANEL_WIDTH;
          type = 'FULL';
          console.log(`[L-CORNER START] Row 1, chain ${chain.id}: PRIMARY (exterior) → FULL`);
        } else {
          // SECONDARY chain = interior arm → CORNER_CUT (1*TOOTH cut)
          reservationMm = PANEL_WIDTH - TOOTH;
          type = 'CORNER_CUT';
          console.log(`[L-CORNER START] Row 1, chain ${chain.id}: SECONDARY (interior) → CORNER_CUT`);
        }
      } else if (isRow2) {
        // ROW 2: ALL 4 panels get CORNER_CUT (both exterior and interior)
        reservationMm = PANEL_WIDTH - TOOTH;
        type = 'CORNER_CUT';
        console.log(`[L-CORNER START] Row 2, chain ${chain.id}: CORNER_CUT (always)`);
      } else {
        // Other rows: alternate pattern like row 1 / row 2
        if (row % 2 === 0) {
          // Even rows (0, 2, 4...) behave like Row 1
          if (endpointInfo.isPrimaryAtStart) {
            reservationMm = PANEL_WIDTH;
            type = 'FULL';
          } else {
            reservationMm = PANEL_WIDTH - TOOTH;
            type = 'CORNER_CUT';
          }
        } else {
          // Odd rows (1, 3, 5...) behave like Row 2
          reservationMm = PANEL_WIDTH - TOOTH;
          type = 'CORNER_CUT';
        }
      }
      break;
      
    case 'T':
      // T-JUNCTION
      if (endpointInfo.isBranchAtStart) {
        // This chain is the BRANCH (perna)
        if (isRow1) {
          // Row 1: perna starts with FULL
          reservationMm = PANEL_WIDTH;
          type = 'FULL';
        } else if (isRow2) {
          // Row 2: perna gets corner cut
          reservationMm = PANEL_WIDTH - TOOTH;
          type = 'CORNER_CUT';
        } else {
          // Alternate
          if (row % 2 === 0) {
            reservationMm = PANEL_WIDTH;
            type = 'FULL';
          } else {
            reservationMm = PANEL_WIDTH - TOOTH;
            type = 'CORNER_CUT';
          }
        }
      } else {
        // This chain is MAIN (costas)
        if (isRow1) {
          // Row 1: costas gets TOPO at T-junction
          reservationMm = PANEL_WIDTH;
          type = 'FULL';
          addTopo = true;
          topoId = endpointInfo.startT?.nodeId || `T-start-${chain.id}`;
        } else {
          // Row 2: costas just continues with FULL
          reservationMm = PANEL_WIDTH;
          type = 'FULL';
        }
      }
      break;
      
    case 'free':
      // FREE END - always TOPO to close
      reservationMm = PANEL_WIDTH;
      type = 'FULL';
      addTopo = true;
      topoId = `free-start-${chain.id}`;
      break;
      
    default:
      // No special node - just use FULL panel
      reservationMm = PANEL_WIDTH;
      type = 'FULL';
  }
  
  return { reservationMm, type, addTopo, topoId };
}

function getEndCap(
  chain: WallChain,
  endpointInfo: ReturnType<typeof getChainEndpointInfo>,
  row: number
): CapResult {
  const isRow1 = row === 0;
  const isRow2 = row === 1;
  
  let reservationMm = PANEL_WIDTH;
  let type: PanelType = 'FULL';
  let addTopo = false;
  let topoId = '';
  
  switch (endpointInfo.endType) {
    case 'L':
      // =============================================
      // L-CORNER RULES (at chain END):
      // - Row 1 (index 0): EXTERIOR (primary) = FULL, INTERIOR (secondary) = CORNER_CUT
      // - Row 2 (index 1): BOTH = CORNER_CUT (all 4 panels)
      // =============================================
      if (isRow1) {
        // ROW 1: exterior = FULL, interior = CORNER_CUT (RED)
        if (endpointInfo.isPrimaryAtEnd) {
          // PRIMARY chain = exterior arm → FULL panel
          reservationMm = PANEL_WIDTH;
          type = 'FULL';
          console.log(`[L-CORNER END] Row 1, chain ${chain.id}: PRIMARY (exterior) → FULL`);
        } else {
          // SECONDARY chain = interior arm → CORNER_CUT (1*TOOTH cut)
          reservationMm = PANEL_WIDTH - TOOTH;
          type = 'CORNER_CUT';
          console.log(`[L-CORNER END] Row 1, chain ${chain.id}: SECONDARY (interior) → CORNER_CUT`);
        }
      } else if (isRow2) {
        // ROW 2: ALL 4 panels get CORNER_CUT (both exterior and interior)
        reservationMm = PANEL_WIDTH - TOOTH;
        type = 'CORNER_CUT';
        console.log(`[L-CORNER END] Row 2, chain ${chain.id}: CORNER_CUT (always)`);
      } else {
        // Other rows: alternate pattern
        if (row % 2 === 0) {
          if (endpointInfo.isPrimaryAtEnd) {
            reservationMm = PANEL_WIDTH;
            type = 'FULL';
          } else {
            reservationMm = PANEL_WIDTH - TOOTH;
            type = 'CORNER_CUT';
          }
        } else {
          reservationMm = PANEL_WIDTH - TOOTH;
          type = 'CORNER_CUT';
        }
      }
      break;
      
    case 'T':
      if (endpointInfo.isBranchAtEnd) {
        if (isRow1) {
          reservationMm = PANEL_WIDTH;
          type = 'FULL';
        } else if (isRow2) {
          reservationMm = PANEL_WIDTH - TOOTH;
          type = 'CORNER_CUT';
        } else {
          if (row % 2 === 0) {
            reservationMm = PANEL_WIDTH;
            type = 'FULL';
          } else {
            reservationMm = PANEL_WIDTH - TOOTH;
            type = 'CORNER_CUT';
          }
        }
      } else {
        // MAIN (costas)
        if (isRow1) {
          reservationMm = PANEL_WIDTH;
          type = 'FULL';
          addTopo = true;
          topoId = endpointInfo.endT?.nodeId || `T-end-${chain.id}`;
        } else {
          reservationMm = PANEL_WIDTH;
          type = 'FULL';
        }
      }
      break;
      
    case 'free':
      reservationMm = PANEL_WIDTH;
      type = 'FULL';
      addTopo = true;
      topoId = `free-end-${chain.id}`;
      break;
      
    default:
      reservationMm = PANEL_WIDTH;
      type = 'FULL';
  }
  
  return { reservationMm, type, addTopo, topoId };
}

/**
 * Layout panels for a chain interval with proper L/T/free-end rules
 * 
 * FILL STRATEGY:
 * 1. Determine cap at START based on junction type
 * 2. Determine cap at END based on junction type  
 * 3. Fill from BOTH ends with full panels toward middle
 * 4. Put any adjustment cut (CUT_DOUBLE/ORANGE) ONLY in the MIDDLE
 */
export function layoutPanelsForChainWithJunctions(
  chain: WallChain,
  intervalStart: number,
  intervalEnd: number,
  row: number,
  lJunctions: LJunctionInfo[],
  tJunctions: TJunctionInfo[],
  freeEnds: EndpointInfo[]
): { panels: ClassifiedPanel[]; topos: TopoPlacement[] } {
  const panels: ClassifiedPanel[] = [];
  const topos: TopoPlacement[] = [];
  const intervalLength = intervalEnd - intervalStart;
  
  if (intervalLength < MIN_CUT_MM) return { panels, topos };
  
  const angle = Math.atan2(chain.endY - chain.startY, chain.endX - chain.startX);
  const dirX = (chain.endX - chain.startX) / chain.lengthMm;
  const dirY = (chain.endY - chain.startY) / chain.lengthMm;
  
  const endpointInfo = getChainEndpointInfo(chain, lJunctions, tJunctions, freeEnds);
  
  // Helper to create panel
  const createPanel = (centerPos: number, width: number, type: PanelType, isCorner: boolean = false, isEnd: boolean = false): ClassifiedPanel => {
    const posX = chain.startX + dirX * centerPos;
    const posZ = chain.startY + dirY * centerPos;
    const posY = row * PANEL_HEIGHT + PANEL_HEIGHT / 2;

    const matrix = new THREE.Matrix4();
    matrix.compose(
      new THREE.Vector3(posX * SCALE, posY * SCALE, posZ * SCALE),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
      new THREE.Vector3(width / PANEL_WIDTH, 1, 1)
    );

    return { matrix, type, widthMm: width, rowIndex: row, chainId: chain.id, isCornerPiece: isCorner, isEndPiece: isEnd };
  };
  
  // Helper to create TOPO
  const createTopo = (posAlongChain: number, reason: 'T_junction' | 'free_end', junctionId: string): TopoPlacement => {
    const posX = chain.startX + dirX * posAlongChain;
    const posZ = chain.startY + dirY * posAlongChain;
    const posY = row * PANEL_HEIGHT + PANEL_HEIGHT / 2;
    
    const matrix = new THREE.Matrix4();
    matrix.compose(
      new THREE.Vector3(posX * SCALE, posY * SCALE, posZ * SCALE),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
      new THREE.Vector3(1, 1, 1)
    );
    
    return { matrix, rowIndex: row, chainId: chain.id, junctionId, reason };
  };
  
  // ============= GET CAPS (START AND END RESERVATIONS) =============
  const isAtChainStart = intervalStart === 0;
  const isAtChainEnd = intervalEnd === chain.lengthMm;
  
  // Left (start) cap
  let leftCap: CapResult = { reservationMm: PANEL_WIDTH, type: 'FULL', addTopo: false, topoId: '' };
  if (isAtChainStart) {
    leftCap = getStartCap(chain, endpointInfo, row);
  }
  
  // Right (end) cap
  let rightCap: CapResult = { reservationMm: PANEL_WIDTH, type: 'FULL', addTopo: false, topoId: '' };
  if (isAtChainEnd) {
    rightCap = getEndCap(chain, endpointInfo, row);
  }
  
  // ============= HANDLE VERY SHORT INTERVALS =============
  const totalReservations = (isAtChainStart ? leftCap.reservationMm : 0) + (isAtChainEnd ? rightCap.reservationMm : 0);
  
  if (intervalLength <= PANEL_WIDTH || totalReservations >= intervalLength) {
    // Just place one panel covering the interval
    const centerPos = intervalStart + intervalLength / 2;
    const type: PanelType = intervalLength < PANEL_WIDTH ? 'CUT_DOUBLE' : (isAtChainStart ? leftCap.type : 'FULL');
    const isCorner = isAtChainStart && leftCap.type === 'CORNER_CUT';
    panels.push(createPanel(centerPos, intervalLength, type, isCorner));
    
    // Add TOPOs if needed
    if (isAtChainStart && leftCap.addTopo) {
      topos.push(createTopo(intervalStart, endpointInfo.startType === 'free' ? 'free_end' : 'T_junction', leftCap.topoId));
    }
    if (isAtChainEnd && rightCap.addTopo) {
      topos.push(createTopo(intervalEnd, endpointInfo.endType === 'free' ? 'free_end' : 'T_junction', rightCap.topoId));
    }
    
    return { panels, topos };
  }
  
  // ============= PLACE LEFT CAP (if at chain start) =============
  let leftEdge = intervalStart;
  
  if (isAtChainStart && leftCap.reservationMm >= MIN_CUT_MM) {
    const capWidth = Math.min(leftCap.reservationMm, intervalLength);
    const centerPos = leftEdge + capWidth / 2;
    panels.push(createPanel(centerPos, capWidth, leftCap.type, leftCap.type === 'CORNER_CUT'));
    leftEdge += capWidth;
    
    if (leftCap.addTopo) {
      topos.push(createTopo(intervalStart, endpointInfo.startType === 'free' ? 'free_end' : 'T_junction', leftCap.topoId));
    }
  }
  
  // ============= PLACE RIGHT CAP (if at chain end) =============
  let rightEdge = intervalEnd;
  
  if (isAtChainEnd && rightCap.reservationMm >= MIN_CUT_MM) {
    const capWidth = Math.min(rightCap.reservationMm, intervalEnd - leftEdge);
    rightEdge = intervalEnd - capWidth;
    const centerPos = rightEdge + capWidth / 2;
    panels.push(createPanel(centerPos, capWidth, rightCap.type, rightCap.type === 'CORNER_CUT'));
    
    if (rightCap.addTopo) {
      topos.push(createTopo(intervalEnd, endpointInfo.endType === 'free' ? 'free_end' : 'T_junction', rightCap.topoId));
    }
  }
  
  // ============= FILL MIDDLE FROM BOTH ENDS =============
  const middleLength = rightEdge - leftEdge;
  
  if (middleLength >= MIN_CUT_MM) {
    const fullPanelCount = Math.floor(middleLength / PANEL_WIDTH);
    const remainder = middleLength - (fullPanelCount * PANEL_WIDTH);
    
    if (fullPanelCount === 0 && remainder > 0) {
      // Only a cut piece in the middle
      if (remainder >= MIN_CUT_MM) {
        const centerPos = leftEdge + remainder / 2;
        panels.push(createPanel(centerPos, remainder, 'CUT_DOUBLE', false));
      }
    } else {
      // Fill from BOTH ends toward middle
      // Split full panels between left and right
      const leftCount = Math.floor(fullPanelCount / 2);
      const rightCount = fullPanelCount - leftCount;
      
      let cursor = leftEdge;
      
      // Place LEFT side full panels
      for (let i = 0; i < leftCount; i++) {
        const centerPos = cursor + PANEL_WIDTH / 2;
        panels.push(createPanel(centerPos, PANEL_WIDTH, 'FULL', false));
        cursor += PANEL_WIDTH;
      }
      
      // Place MIDDLE cut piece (if any) - CUT_DOUBLE (ORANGE)
      // This is the ONLY place where ORANGE cuts go!
      if (remainder >= MIN_CUT_MM) {
        const centerPos = cursor + remainder / 2;
        panels.push(createPanel(centerPos, remainder, 'CUT_DOUBLE', false));
        cursor += remainder;
      }
      
      // Place RIGHT side full panels
      for (let i = 0; i < rightCount; i++) {
        const centerPos = cursor + PANEL_WIDTH / 2;
        panels.push(createPanel(centerPos, PANEL_WIDTH, 'FULL', false));
        cursor += PANEL_WIDTH;
      }
    }
  }
  
  return { panels, topos };
}

/**
 * Generate all panel and topo placements for visible rows
 */
export function generatePanelLayout(
  chains: WallChain[],
  visibleRows: number,
  maxRows: number,
  getIntervalsForRow: (chain: WallChain, row: number) => { start: number; end: number }[]
): {
  panelsByType: Record<PanelType, ClassifiedPanel[]>;
  allPanels: ClassifiedPanel[];
  allTopos: TopoPlacement[];
  stats: {
    lJunctions: number;
    tJunctions: number;
    freeEnds: number;
    cornerTemplatesApplied: number;
    toposPlaced: number;
    effectiveOffset: number;
  };
} {
  const lJunctions = detectLJunctions(chains);
  const tJunctions = detectTJunctions(chains);
  const freeEnds = detectFreeEnds(chains);
  
  console.log('[generatePanelLayout] Detected:', {
    lJunctions: lJunctions.length,
    tJunctions: tJunctions.length,
    freeEnds: freeEnds.length,
    chainsCount: chains.length,
    visibleRows,
    maxRows,
  });
  
  const panelsByType: Record<PanelType, ClassifiedPanel[]> = {
    FULL: [],
    CUT_SINGLE: [],
    CUT_DOUBLE: [],
    CORNER_CUT: [],
    TOPO: [],
    END_CUT: [],
  };
  const allPanels: ClassifiedPanel[] = [];
  const allTopos: TopoPlacement[] = [];
  let cornerTemplatesApplied = 0;
  
  let chainsProcessed = 0;
  let intervalsProcessed = 0;
  
  chains.forEach((chain) => {
    if (chain.lengthMm < 50) {
      console.log('[generatePanelLayout] Skipping short chain:', chain.id, chain.lengthMm);
      return;
    }
    chainsProcessed++;
    
    for (let row = 0; row < Math.min(visibleRows, maxRows); row++) {
      const intervals = getIntervalsForRow(chain, row);
      
      if (row === 0 && chainsProcessed === 1) {
        console.log('[generatePanelLayout] First chain intervals:', { chainId: chain.id, lengthMm: chain.lengthMm, intervals });
      }
      
      intervals.forEach((interval) => {
        intervalsProcessed++;
        const { panels, topos } = layoutPanelsForChainWithJunctions(
          chain,
          interval.start,
          interval.end,
          row,
          lJunctions,
          tJunctions,
          freeEnds
        );
        
        if (row === 0 && intervalsProcessed === 1) {
          console.log('[generatePanelLayout] First interval result:', { panels: panels.length, topos: topos.length });
        }
        
        panels.forEach(panel => {
          panelsByType[panel.type].push(panel);
          allPanels.push(panel);
          if (panel.isCornerPiece) cornerTemplatesApplied++;
        });
        
        allTopos.push(...topos);
      });
    }
  });
  
  console.log('[generatePanelLayout] Processed:', { chainsProcessed, intervalsProcessed, panelsTotal: allPanels.length });
  
  return {
    panelsByType,
    allPanels,
    allTopos,
    stats: {
      lJunctions: lJunctions.length,
      tJunctions: tJunctions.length,
      freeEnds: freeEnds.length,
      cornerTemplatesApplied,
      toposPlaced: allTopos.length,
      effectiveOffset: TOOTH, // Report TOOTH as the effective offset step
    },
  };
}
