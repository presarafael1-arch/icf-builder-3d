/**
 * Panel Layout Engine for ICF Walls
 * 
 * RULES:
 * - TOOTH = 1200/17 ≈ 70.588mm (minimum step for cuts/offsets)
 * - Standard panel = 1200mm x 400mm
 * - Wall block = 2 panels (ext + int) + concrete between
 * 
 * COLORS:
 * - YELLOW (FULL): full panel 1200mm
 * - RED (CORNER_CUT): corner/node start cut (only at L/T nodes)
 * - ORANGE (CUT_DOUBLE): adjustment cut in the MIDDLE of run
 * - GREEN (TOPO): topo product (at T-junctions and free ends)
 * 
 * CRITICAL CORNER CLOSURE RULES:
 * ==============================
 * Corners MUST always start at the physical corner vertex.
 * 
 * L-CORNER (90° junction between 2 chains):
 *   Row 1 (index 0, odd rows):
 *     - EXTERIOR: FULL panel starts exactly at corner
 *     - INTERIOR: CORNER_CUT (1*TOOTH shorter) to align with exterior
 *   Row 2 (index 1, even rows):
 *     - BOTH sides: CORNER_CUT (1*TOOTH shorter) for interlocking
 *   
 * The cut on interior allows the panels to interlock properly and
 * ensures concrete can fill the corner without gaps.
 *   
 * T-JUNCTION RULES:
 *   - "Costas" = continuous wall (main)
 *   - "Perna" = perpendicular branch
 *   - Row 1: COSTAS = TOPO at T + full panels; PERNA = full panels from T
 *   - Row 2: COSTAS = full panels; PERNA = CORNER_CUT + full panels
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
import { 
  PANEL_WIDTH, 
  PANEL_HEIGHT, 
  FOAM_THICKNESS,
  TOOTH,
  getWallTotalThickness,
  getHalfConcreteOffset,
  ConcreteThickness 
} from '@/types/icf';

// Scale factor: mm to meters
const SCALE = 0.001;

// Minimum cut length to place a panel (1 tooth)
const MIN_CUT_MM = TOOTH;

// Panel types
export type PanelType = 'FULL' | 'CUT_SINGLE' | 'CUT_DOUBLE' | 'CORNER_CUT' | 'TOPO' | 'END_CUT';

// Side of the wall (for dual-panel layout)
export type WallSide = 'exterior' | 'interior';

// Classified panel placement (with stable ID support)
export interface ClassifiedPanel {
  matrix: THREE.Matrix4;
  type: PanelType;
  widthMm: number;
  rowIndex: number;
  chainId: string;
  isCornerPiece: boolean;
  isTopoPiece?: boolean;
  isEndPiece?: boolean;
  side?: WallSide; // Which side of the wall this panel is on
  
  // Stable ID components (for panel selection)
  panelId?: string;
  slotIndex?: number;
  startMm?: number;
  endMm?: number;
  cutLeftMm?: number;
  cutRightMm?: number;
  seedOrigin?: 'L_junction' | 'T_junction' | 'X_junction' | 'free_end' | 'middle' | 'none';
  nearestNodeId?: string;
  nearestNodeType?: 'L' | 'T' | 'X' | 'end' | null;
  distanceToNodeMm?: number;
  position?: 'first_from_node' | 'last_before_node' | 'middle' | 'single';
  ruleApplied?: string;
  
  // Debug: L-corner offset info
  lCornerOffsetMm?: number; // Offset applied at L-corner (negative = extends past, positive = starts after)
  isPrimaryArm?: boolean;   // True if this is the PRIMARY arm at an L-corner
  isExtendingArm?: boolean; // True if this arm is the one extending past the corner for this row
}

// Topo placement for T-junctions and free ends
// TOPO closes the gap between exterior and interior panels at wall ends
export interface TopoPlacement {
  matrix: THREE.Matrix4;
  rowIndex: number;
  chainId: string;
  junctionId: string;
  reason: 'T_junction' | 'free_end';
  side?: 'exterior' | 'interior' | 'closing'; // 'closing' = closes both sides at free end
  widthMm: number; // Width of topo based on concrete thickness
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

// X-junction info (4 or more chains meeting at a point)
export interface XJunctionInfo {
  nodeId: string;
  x: number;
  y: number;
  chainIds: string[];
  angles: number[];
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
 * Uses geometric winding to determine primary (exterior) vs secondary (interior):
 * - Primary arm is the one where counter-clockwise rotation reaches the secondary arm
 * - This corresponds to the "exterior" face of an L-corner in typical floor plans
 */
export function detectLJunctions(chains: WallChain[]): LJunctionInfo[] {
  const nodeMap = new Map<string, { x: number; y: number; chainIds: string[]; angles: number[]; isStarts: boolean[] }>();
  const TOLERANCE = 300; // mm - must be larger than wall thickness to group parallel wall endpoints
  
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
    
    // GEOMETRIC WINDING: Determine primary (exterior) vs secondary (interior)
    // 
    // To ensure CONSISTENT results regardless of chain order in the node,
    // we sort chains by their outward angle first, then apply the winding rule.
    //
    // L-CORNER EXTERIOR RULE:
    // At an L-corner, the "exterior" arm is the one where the corner's convex 
    // (outside) angle faces. This is determined by the signed angle between arms.
    
    const angle0 = node.angles[0];
    const angle1 = node.angles[1];
    
    // Normalize angles to [0, 2π)
    const normAngle = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const norm0 = normAngle(angle0);
    const norm1 = normAngle(angle1);
    
    // Sort indices by normalized angle for consistent ordering
    const sortedIndices = norm0 <= norm1 ? [0, 1] : [1, 0];
    const sortedAngle0 = node.angles[sortedIndices[0]];
    const sortedAngle1 = node.angles[sortedIndices[1]];
    
    // Direction vectors pointing outward from junction (sorted order)
    const dir0 = { x: Math.cos(sortedAngle0), y: Math.sin(sortedAngle0) };
    const dir1 = { x: Math.cos(sortedAngle1), y: Math.sin(sortedAngle1) };
    
    // 2D cross product: dir0 × dir1 = dir0.x * dir1.y - dir0.y * dir1.x
    const cross = dir0.x * dir1.y - dir0.y * dir1.x;
    
    // WINDING RULE (with sorted chains):
    // For an L-corner, the EXTERIOR arm gets FULL panels in row 1.
    // The exterior is the convex (outside) face of the corner.
    // After sorting by angle, if cross > 0, the first (smaller angle) chain is exterior.
    // If cross < 0, the second chain is exterior.
    let primarySortedIdx: number;
    
    if (Math.abs(cross) < 0.1) {
      // Nearly parallel - fallback to first
      primarySortedIdx = 0;
    } else if (cross > 0) {
      // CCW from dir0 to dir1: dir0 (first sorted) is exterior
      primarySortedIdx = 0;
    } else {
      // CW: dir1 (second sorted) is exterior
      primarySortedIdx = 1;
    }
    
    // Map back to original indices
    const primaryIdx = sortedIndices[primarySortedIdx];
    const secondaryIdx = sortedIndices[1 - primarySortedIdx];
    
    const primaryChainId = node.chainIds[primaryIdx];
    const secondaryChainId = node.chainIds[secondaryIdx];
    
    lJunctions.push({
      nodeId: key,
      x: node.x,
      y: node.y,
      primaryChainId,
      secondaryChainId,
      primaryAngle: node.angles[primaryIdx],
      secondaryAngle: node.angles[secondaryIdx],
    });
  });
  
  return lJunctions;
}

/**
 * Detect T-junctions (exactly 3 chains meeting, 2 colinear + 1 perpendicular)
 */
export function detectTJunctions(chains: WallChain[]): TJunctionInfo[] {
  const nodeMap = new Map<string, { x: number; y: number; chainIds: string[]; angles: number[] }>();
  const TOLERANCE = 300; // mm - must be larger than wall thickness to group parallel wall endpoints
  
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
 * Detect X-junctions (4 or more chains meeting at a point)
 */
export function detectXJunctions(chains: WallChain[]): XJunctionInfo[] {
  const nodeMap = new Map<string, { x: number; y: number; chainIds: string[]; angles: number[] }>();
  const TOLERANCE = 300; // mm - must be larger than wall thickness to group parallel wall endpoints
  
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
      endNode.angles.push(angle + Math.PI);
    }
  });
  
  const xJunctions: XJunctionInfo[] = [];
  
  nodeMap.forEach((node, key) => {
    // X-junction = 4 or more chains meeting
    if (node.chainIds.length >= 4) {
      xJunctions.push({
        nodeId: key,
        x: node.x,
        y: node.y,
        chainIds: node.chainIds,
        angles: node.angles,
      });
    }
  });
  
  return xJunctions;
}

/**
 * Detect free ends (endpoints with degree 1 - only one chain connects)
 */
function detectFreeEnds(chains: WallChain[]): EndpointInfo[] {
  const nodeMap = new Map<string, EndpointInfo[]>();
  const TOLERANCE = 300; // mm - must be larger than wall thickness to group parallel wall endpoints
  
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
  startOffsetMm: number; // Offset to apply to panel start position (for avoiding overlap at corners)
  // Debug info for L-corner visualization
  isPrimaryArm?: boolean;
  isExtendingArm?: boolean;
}

/**
 * Get start cap for a chain endpoint
 * 
 * CRITICAL: At L-corners, panels must start AT the corner vertex.
 * - Row 1: Exterior = FULL from corner, Interior = CORNER_CUT (1*TOOTH cut)
 * - Row 2+: Both = CORNER_CUT for interlocking
 * 
 * The interior cut creates the offset needed for proper exterior/interior alignment.
 * After the first panel, both sides continue with FULL panels.
 */
function getStartCap(
  chain: WallChain,
  endpointInfo: ReturnType<typeof getChainEndpointInfo>,
  row: number,
  side: WallSide = 'exterior',
  concreteThickness: ConcreteThickness = '150'
): CapResult {
  const isRow1 = row === 0;  // Index 0 = Row 1
  const isRow2 = row === 1;  // Index 1 = Row 2
  const isOddRow = row % 2 === 0; // 0, 2, 4... (visual rows 1, 3, 5...)
  
  let reservationMm = PANEL_WIDTH;
  let type: PanelType = 'FULL';
  let addTopo = false;
  let topoId = '';
  let startOffsetMm = 0; // Offset from corner vertex where panel actually starts
  
  switch (endpointInfo.startType) {
    case 'L': {
      // =============================================
      // L-CORNER (chain START)
      // 
      // Target behaviour (as per debugging screenshots):
      // - Row 1:
      //   - EXTERIOR: one arm must advance 1*TOOTH to eliminate the outside gap
      //   - INTERIOR: must go "para dentro" by 2*TOOTH and be cut by 2*TOOTH
      // - Rows 2+: keep simple interlock by swapping which arm "extends".
      // 
      // NOTE: Offsets are along-chain (X direction in chain space).
      // Per-side separation (exterior/interior) is handled later by the perpendicular offset.
      // =============================================
      const wallHalfThickness = getWallTotalThickness(concreteThickness) / 2;

      // Which arm is the "extending" arm for this row (interlock alternation)
      const extendingArmIsPrimary = isOddRow; // row0,2,4... => primary extends; row1,3,5... => secondary extends
      const isExtendingArm = endpointInfo.isPrimaryAtStart ? extendingArmIsPrimary : !extendingArmIsPrimary;
      const isPrimaryArm = endpointInfo.isPrimaryAtStart;

      if (isRow1) {
        if (side === 'exterior') {
          // EXTERIOR ROW 1: offset -2*TOOTH para o corner (avança 2 tooth)
          reservationMm = PANEL_WIDTH;
          type = 'FULL';
          startOffsetMm = -2 * TOOTH;
        } else {
          // INTERIOR ROW 1: offset +2*TOOTH (afasta do corner) e corta 2*TOOTH
          reservationMm = PANEL_WIDTH - 2 * TOOTH;
          type = 'CORNER_CUT';
          startOffsetMm = 2 * TOOTH;
        }
      } else {
        // Rows 2+: keep both as FULL, alternating who extends
        reservationMm = PANEL_WIDTH;
        type = 'FULL';
        startOffsetMm = isExtendingArm ? -wallHalfThickness : 0;
      }

      return { reservationMm, type, addTopo, topoId, startOffsetMm, isPrimaryArm, isExtendingArm };
    }
      
    case 'T':
      // =============================================
      // T-JUNCTION RULES:
      // MAIN (costas): continuous wall - panels continue with TOPO at junction
      // BRANCH (perna): perpendicular - cut to meet main wall flush
      // 
      // Branch is always cut by 1×TOOTH to fit against main wall
      // Main wall continues, TOPO fills the gap at junction
      // =============================================
      if (endpointInfo.isBranchAtStart) {
        // This chain is the BRANCH (perna) - always cut to meet main flush
        // Cut by 1×TOOTH so it doesn't overlap with main wall panels
        reservationMm = PANEL_WIDTH - TOOTH;
        type = 'CORNER_CUT';
      } else {
        // This chain is MAIN (costas) - continues through junction
        reservationMm = PANEL_WIDTH;
        type = 'FULL';
        // Add TOPO at T-junction to close the branch connection
        addTopo = true;
        topoId = endpointInfo.startT?.nodeId || `T-start-${chain.id}`;
      }
      break;
      
    case 'free':
      // FREE END - always TOPO to close for concrete
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
  
  return { reservationMm, type, addTopo, topoId, startOffsetMm };
}

function getEndCap(
  chain: WallChain,
  endpointInfo: ReturnType<typeof getChainEndpointInfo>,
  row: number,
  side: WallSide = 'exterior',
  concreteThickness: ConcreteThickness = '150'
): CapResult {
  const isRow1 = row === 0;
  const isOddRow = row % 2 === 0; // 0, 2, 4...
  
  let reservationMm = PANEL_WIDTH;
  let type: PanelType = 'FULL';
  let addTopo = false;
  let topoId = '';
  let startOffsetMm = 0;
  
  switch (endpointInfo.endType) {
    case 'L': {
      // =============================================
      // L-CORNER (chain END)
      // Same rules as START, but offsets are applied from the chain end.
      // =============================================
      const wallHalfThicknessEnd = getWallTotalThickness(concreteThickness) / 2;

      const extendingArmIsPrimary = isOddRow;
      const isExtendingArm = endpointInfo.isPrimaryAtEnd ? extendingArmIsPrimary : !extendingArmIsPrimary;
      const isPrimaryArm = endpointInfo.isPrimaryAtEnd;

      if (isRow1) {
        if (side === 'exterior') {
          // EXTERIOR ROW 1: offset -2*TOOTH para o corner (avança 2 tooth)
          reservationMm = PANEL_WIDTH;
          type = 'FULL';
          startOffsetMm = -2 * TOOTH;
        } else {
          // INTERIOR ROW 1: offset +2*TOOTH (afasta do corner) e corta 2*TOOTH
          reservationMm = PANEL_WIDTH - 2 * TOOTH;
          type = 'CORNER_CUT';
          startOffsetMm = 2 * TOOTH;
        }
      } else {
        // Rows 2+: keep both as FULL, alternating who extends
        reservationMm = PANEL_WIDTH;
        type = 'FULL';
        startOffsetMm = isExtendingArm ? -wallHalfThicknessEnd : 0;
      }

      return { reservationMm, type, addTopo, topoId, startOffsetMm, isPrimaryArm, isExtendingArm };
    }
      
    case 'T':
      // =============================================
      // T-JUNCTION at chain END - same rules as start
      // Branch is cut to meet main wall flush
      // =============================================
      if (endpointInfo.isBranchAtEnd) {
        // BRANCH (perna) - cut by 1×TOOTH to fit against main
        reservationMm = PANEL_WIDTH - TOOTH;
        type = 'CORNER_CUT';
      } else {
        // MAIN (costas) - continues through
        reservationMm = PANEL_WIDTH;
        type = 'FULL';
        addTopo = true;
        topoId = endpointInfo.endT?.nodeId || `T-end-${chain.id}`;
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
  
  return { reservationMm, type, addTopo, topoId, startOffsetMm };
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
  freeEnds: EndpointInfo[],
  side: WallSide = 'exterior',
  concreteThickness: ConcreteThickness = '150'
): { panels: ClassifiedPanel[]; topos: TopoPlacement[] } {
  const panels: ClassifiedPanel[] = [];
  const topos: TopoPlacement[] = [];
  const intervalLength = intervalEnd - intervalStart;
  
  if (intervalLength < MIN_CUT_MM) return { panels, topos };
  
  const angle = Math.atan2(chain.endY - chain.startY, chain.endX - chain.startX);
  const dirX = (chain.endX - chain.startX) / chain.lengthMm;
  const dirY = (chain.endY - chain.startY) / chain.lengthMm;
  
  const endpointInfo = getChainEndpointInfo(chain, lJunctions, tJunctions, freeEnds);
  
  // Slot counter for stable IDs
  let slotCounter = 0;
  
  // Side short code for IDs
  const sideCode = side === 'exterior' ? 'ext' : 'int';
  
  // Helper to determine seed origin
  const getSeedOrigin = (isStart: boolean, isEnd: boolean): ClassifiedPanel['seedOrigin'] => {
    if (isStart) {
      if (endpointInfo.startType === 'L') return 'L_junction';
      if (endpointInfo.startType === 'T') return 'T_junction';
      if (endpointInfo.startType === 'free') return 'free_end';
    }
    if (isEnd) {
      if (endpointInfo.endType === 'L') return 'L_junction';
      if (endpointInfo.endType === 'T') return 'T_junction';
      if (endpointInfo.endType === 'free') return 'free_end';
    }
    return 'middle';
  };
  
  // Helper to get nearest node info
  const getNearestNode = (posAlongChain: number): { id: string | null; type: 'L' | 'T' | 'end' | null; distance: number } => {
    const distToStart = posAlongChain;
    const distToEnd = chain.lengthMm - posAlongChain;
    
    if (distToStart <= distToEnd) {
      if (endpointInfo.startL) return { id: endpointInfo.startL.nodeId, type: 'L', distance: distToStart };
      if (endpointInfo.startT) return { id: endpointInfo.startT.nodeId, type: 'T', distance: distToStart };
      if (endpointInfo.hasFreeStart) return { id: `free-start-${chain.id}`, type: 'end', distance: distToStart };
    } else {
      if (endpointInfo.endL) return { id: endpointInfo.endL.nodeId, type: 'L', distance: distToEnd };
      if (endpointInfo.endT) return { id: endpointInfo.endT.nodeId, type: 'T', distance: distToEnd };
      if (endpointInfo.hasFreeEnd) return { id: `free-end-${chain.id}`, type: 'end', distance: distToEnd };
    }
    return { id: null, type: null, distance: Math.min(distToStart, distToEnd) };
  };
  
  // Helper to create panel with stable ID
  // NOTE: startPos is the position along the chain where the panel STARTS (edge closest to chain start)
  // The panel's center is at startPos + width/2
  // For interior panels, we offset perpendicular to the wall direction
  const createPanel = (
    startPos: number, 
    width: number, 
    type: PanelType, 
    isCorner: boolean = false, 
    isEnd: boolean = false,
    ruleApplied: string = 'auto'
  ): ClassifiedPanel => {
    const endPos = startPos + width;
    const centerPos = startPos + width / 2;
    
    // Base position along the wall centerline
    let posX = chain.startX + dirX * centerPos;
    let posZ = chain.startY + dirY * centerPos;
    const posY = row * PANEL_HEIGHT + PANEL_HEIGHT / 2;
    
    // Offset panels from DXF center line
    // Structure: [exterior foam] [concrete core] [interior foam]
    // DXF line is at the CENTER of the wall
    // 
    // For 150mm concrete (2 teeth core):
    //   - Half concrete = 1 tooth from center
    //   - Foam panel = 1 tooth thick
    //   - Exterior panel inner face at: center - 1 tooth
    //   - Interior panel inner face at: center + 1 tooth
    //
    // For 220mm concrete (3 teeth core):
    //   - Half concrete = 1.5 teeth from center
    //   - Foam panel = 1 tooth thick
    //   - Exterior panel inner face at: center - 1.5 teeth
    //   - Interior panel inner face at: center + 1.5 teeth
    
    // Use the concreteThickness parameter passed from settings
    const halfConcreteOffset = getHalfConcreteOffset(concreteThickness);
    
    // Perpendicular unit vector (90° CW from wall direction)
    // Positive perpendicular = "right" side when looking along wall direction
    const perpX = -dirY;
    const perpZ = dirX;
    
    if (side === 'interior') {
      // Interior panel: offset to the positive perpendicular side (inside of building)
      // Position at center + halfConcreteOffset (inner face of foam touches concrete)
      const offsetMm = halfConcreteOffset + FOAM_THICKNESS / 2; // Center of foam panel
      posX += perpX * offsetMm;
      posZ += perpZ * offsetMm;
    } else {
      // Exterior panel: offset to the negative perpendicular side (outside of building)
      // Position at center - halfConcreteOffset (inner face of foam touches concrete)
      const offsetMm = -(halfConcreteOffset + FOAM_THICKNESS / 2); // Center of foam panel
      posX += perpX * offsetMm;
      posZ += perpZ * offsetMm;
    }

    const matrix = new THREE.Matrix4();
    matrix.compose(
      new THREE.Vector3(posX * SCALE, posY * SCALE, posZ * SCALE),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
      new THREE.Vector3(width / PANEL_WIDTH, 1, 1)
    );
    
    // Stable ID components - use sideCode for ext/int distinction
    const slotIndex = slotCounter++;
    const seedKey = `${endpointInfo.startType}-${endpointInfo.endType}`.slice(0, 8);
    const panelId = `${chain.id.slice(0, 8)}:${row}:${sideCode}:${slotIndex}:${seedKey}`;
    
    // Node context
    const nearestNode = getNearestNode(centerPos);
    const isAtStart = startPos <= TOOTH;
    const isAtEnd = endPos >= chain.lengthMm - TOOTH;
    
    // Position classification
    let position: ClassifiedPanel['position'] = 'middle';
    if (isAtStart && isAtEnd) position = 'single';
    else if (isAtStart) position = 'first_from_node';
    else if (isAtEnd) position = 'last_before_node';
    
    // Calculate cuts (how much was removed from full panel width)
    const cutLeftMm = type === 'CORNER_CUT' || type === 'CUT_DOUBLE' ? PANEL_WIDTH - width : 0;
    const cutRightMm = type === 'CUT_DOUBLE' ? PANEL_WIDTH - width : 0;

    return { 
      matrix, 
      type, 
      widthMm: width, 
      rowIndex: row, 
      chainId: chain.id, 
      isCornerPiece: isCorner, 
      isEndPiece: isEnd,
      side, // Include which side this panel is on
      // Stable ID data
      panelId,
      slotIndex,
      startMm: startPos,
      endMm: endPos,
      cutLeftMm,
      cutRightMm,
      seedOrigin: getSeedOrigin(isAtStart, isAtEnd),
      nearestNodeId: nearestNode.id,
      nearestNodeType: nearestNode.type,
      distanceToNodeMm: nearestNode.distance,
      position,
      ruleApplied,
    };
  };
  
  // Helper to create TOPO
  // TOPO at free ends: closes BOTH sides (exterior + interior) - bridges the gap
  // TOPO at T-junctions: positioned per side
  const createTopo = (
    posAlongChain: number, 
    reason: 'T_junction' | 'free_end', 
    junctionId: string,
    topoSide: 'exterior' | 'interior' | 'closing' = 'closing'
  ): TopoPlacement => {
    const halfConcreteOffset = getHalfConcreteOffset(concreteThickness);
    
    // TOPO width based on concrete thickness:
    // - 150mm: 2×TOOTH (~141.18mm)
    // - 220mm: 3×TOOTH (~211.76mm)
    const topoWidthMm = concreteThickness === '150' ? TOOTH * 2 : TOOTH * 3;
    
    // TOPO at free ends: offset 1 TOOTH inward (flush with end, facing inside)
    // The TOPO sits at the very end of the wall, but shifted inward by 1 TOOTH
    // so its outer face is flush with the wall end
    let posAlongChainAdjusted = posAlongChain;
    if (reason === 'free_end') {
      // Determine direction: if at chain start (pos=0), offset forward; if at chain end, offset backward
      if (posAlongChain < chain.lengthMm / 2) {
        // At chain START - offset forward (into the wall) by half the topo width
        posAlongChainAdjusted = posAlongChain + topoWidthMm / 2;
      } else {
        // At chain END - offset backward (into the wall) by half the topo width
        posAlongChainAdjusted = posAlongChain - topoWidthMm / 2;
      }
    }
    
    let posX = chain.startX + dirX * posAlongChainAdjusted;
    let posZ = chain.startY + dirY * posAlongChainAdjusted;
    const posY = row * PANEL_HEIGHT + PANEL_HEIGHT / 2;
    
    // Perpendicular direction (for offset)
    const perpX = -dirY;
    const perpZ = dirX;
    
    // For closing TOPO at free ends: positioned at CENTER of wall (on DXF line)
    // For side-specific TOPOs: offset like panels
    if (topoSide === 'interior') {
      const offsetMm = halfConcreteOffset + FOAM_THICKNESS / 2;
      posX += perpX * offsetMm;
      posZ += perpZ * offsetMm;
    } else if (topoSide === 'exterior') {
      const offsetMm = -(halfConcreteOffset + FOAM_THICKNESS / 2);
      posX += perpX * offsetMm;
      posZ += perpZ * offsetMm;
    }
    // 'closing' stays on center line
    
    const matrix = new THREE.Matrix4();
    // Scale X by topoWidth (along wall), Y by panel height, Z by concrete core thickness
    // TOPO fits INSIDE the foam panels (between interior faces), not on the exterior
    // So Z = concrete core = topoWidthMm (2×TOOTH for 150mm, 3×TOOTH for 220mm)
    // This is reduced by 1×TOOTH on each side compared to full wall thickness
    const concreteCoreThickness = topoWidthMm; // Same as concrete core
    const zScale = topoSide === 'closing' ? concreteCoreThickness : FOAM_THICKNESS;
    
    matrix.compose(
      new THREE.Vector3(posX * SCALE, posY * SCALE, posZ * SCALE),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
      new THREE.Vector3(topoWidthMm * SCALE, PANEL_HEIGHT * SCALE, zScale * SCALE)
    );
    
    return { 
      matrix, 
      rowIndex: row, 
      chainId: chain.id, 
      junctionId, 
      reason,
      side: topoSide,
      widthMm: topoWidthMm,
    };
  };
  
  // ============= GET CAPS (START AND END RESERVATIONS) =============
  const isAtChainStart = intervalStart === 0;
  const isAtChainEnd = intervalEnd === chain.lengthMm;
  
  // Left (start) cap - pass side for correct L-corner rules
  let leftCap: CapResult = { reservationMm: PANEL_WIDTH, type: 'FULL', addTopo: false, topoId: '', startOffsetMm: 0 };
  if (isAtChainStart) {
    leftCap = getStartCap(chain, endpointInfo, row, side, concreteThickness);
  }
  
  // Right (end) cap - pass side for correct L-corner rules
  let rightCap: CapResult = { reservationMm: PANEL_WIDTH, type: 'FULL', addTopo: false, topoId: '', startOffsetMm: 0 };
  if (isAtChainEnd) {
    rightCap = getEndCap(chain, endpointInfo, row, side, concreteThickness);
  }
  
  // ============= HANDLE VERY SHORT INTERVALS =============
  const totalReservations = (isAtChainStart ? leftCap.reservationMm : 0) + (isAtChainEnd ? rightCap.reservationMm : 0);
  
  // CRITICAL: Panel width MUST NEVER exceed PANEL_WIDTH (1200mm)
  // Account for offsets at both ends
  const effectiveStart = intervalStart + leftCap.startOffsetMm;
  const effectiveEnd = intervalEnd - rightCap.startOffsetMm;
  const effectiveLength = effectiveEnd - effectiveStart;
  
  if (effectiveLength <= PANEL_WIDTH && effectiveLength >= MIN_CUT_MM) {
    // Interval fits in one panel (possibly cut)
    const panelWidth = Math.min(effectiveLength, PANEL_WIDTH);
    const type: PanelType = panelWidth < PANEL_WIDTH ? 'CUT_DOUBLE' : (isAtChainStart ? leftCap.type : 'FULL');
    const isCorner = isAtChainStart && leftCap.type === 'CORNER_CUT';
    panels.push(createPanel(effectiveStart, panelWidth, type, isCorner));
    
    // Add TOPOs if needed - at free ends, TOPO closes both sides (only add once from exterior)
    if (isAtChainStart && leftCap.addTopo && side === 'exterior') {
      const isFreeEnd = endpointInfo.startType === 'free';
      const topoSide = isFreeEnd ? 'closing' : side; // Free ends close both, T-junctions are per-side
      topos.push(createTopo(intervalStart, isFreeEnd ? 'free_end' : 'T_junction', leftCap.topoId, topoSide));
    }
    if (isAtChainEnd && rightCap.addTopo && side === 'exterior') {
      const isFreeEnd = endpointInfo.endType === 'free';
      const topoSide = isFreeEnd ? 'closing' : side;
      topos.push(createTopo(intervalEnd, isFreeEnd ? 'free_end' : 'T_junction', rightCap.topoId, topoSide));
    }
    
    return { panels, topos };
  } else if (effectiveLength < MIN_CUT_MM) {
    // Interval too small after offsets - just add TOPOs if needed
    if (isAtChainStart && leftCap.addTopo && side === 'exterior') {
      const isFreeEnd = endpointInfo.startType === 'free';
      const topoSide = isFreeEnd ? 'closing' : side;
      topos.push(createTopo(intervalStart, isFreeEnd ? 'free_end' : 'T_junction', leftCap.topoId, topoSide));
    }
    if (isAtChainEnd && rightCap.addTopo && side === 'exterior') {
      const isFreeEnd = endpointInfo.endType === 'free';
      const topoSide = isFreeEnd ? 'closing' : side;
      topos.push(createTopo(intervalEnd, isFreeEnd ? 'free_end' : 'T_junction', rightCap.topoId, topoSide));
    }
    return { panels, topos };
  }
  
  // ============= PLACE LEFT CAP (if at chain start) =============
  // Apply startOffsetMm to avoid overlap at L-corners
  let leftEdge = intervalStart + leftCap.startOffsetMm;
  
  // DEBUG: Log L-corner offsets
  if (isAtChainStart && endpointInfo.startType === 'L' && row === 0) {
    console.log(`[L-CORNER START] chain=${chain.id.slice(0,8)} side=${side} isPrimary=${leftCap.isPrimaryArm} isExtending=${leftCap.isExtendingArm} offset=${leftCap.startOffsetMm.toFixed(1)}mm type=${leftCap.type} width=${leftCap.reservationMm}mm`);
  }
  
  if (isAtChainStart && leftCap.reservationMm >= MIN_CUT_MM) {
    // CRITICAL: Cap width MUST NEVER exceed PANEL_WIDTH (1200mm)
    // Also account for the offset reducing available space
    const availableLength = intervalLength - leftCap.startOffsetMm;
    const capWidth = Math.min(leftCap.reservationMm, availableLength, PANEL_WIDTH);
    if (capWidth >= MIN_CUT_MM) {
      panels.push(createPanel(leftEdge, capWidth, leftCap.type, leftCap.type === 'CORNER_CUT'));
      leftEdge += capWidth;
    }
    
    if (leftCap.addTopo && side === 'exterior') {
      const isFreeEnd = endpointInfo.startType === 'free';
      const topoSide = isFreeEnd ? 'closing' : side;
      topos.push(createTopo(intervalStart, isFreeEnd ? 'free_end' : 'T_junction', leftCap.topoId, topoSide));
    }
  }
  
  // ============= PLACE RIGHT CAP (if at chain end) =============
  // Apply startOffsetMm for right cap (offset from the end)
  let rightEdge = intervalEnd - rightCap.startOffsetMm;
  
  if (isAtChainEnd && rightCap.reservationMm >= MIN_CUT_MM) {
    // CRITICAL: Cap width MUST NEVER exceed PANEL_WIDTH (1200mm)
    const availableLength = rightEdge - leftEdge;
    const capWidth = Math.min(rightCap.reservationMm, availableLength, PANEL_WIDTH);
    if (capWidth >= MIN_CUT_MM) {
      rightEdge = rightEdge - capWidth;
      panels.push(createPanel(rightEdge, capWidth, rightCap.type, rightCap.type === 'CORNER_CUT'));
    }
    
    if (rightCap.addTopo && side === 'exterior') {
      const isFreeEnd = endpointInfo.endType === 'free';
      const topoSide = isFreeEnd ? 'closing' : side;
      topos.push(createTopo(intervalEnd, isFreeEnd ? 'free_end' : 'T_junction', rightCap.topoId, topoSide));
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
        panels.push(createPanel(leftEdge, remainder, 'CUT_DOUBLE', false));
      }
    } else {
      // Fill from BOTH ends toward middle
      // Split full panels between left and right
      const leftCount = Math.floor(fullPanelCount / 2);
      const rightCount = fullPanelCount - leftCount;
      
      let cursor = leftEdge;
      
      // Place LEFT side full panels
      for (let i = 0; i < leftCount; i++) {
        panels.push(createPanel(cursor, PANEL_WIDTH, 'FULL', false));
        cursor += PANEL_WIDTH;
      }
      
      // Place MIDDLE cut piece (if any) - CUT_DOUBLE (ORANGE)
      // This is the ONLY place where ORANGE cuts go!
      if (remainder >= MIN_CUT_MM) {
        panels.push(createPanel(cursor, remainder, 'CUT_DOUBLE', false));
        cursor += remainder;
      }
      
      // Place RIGHT side full panels
      for (let i = 0; i < rightCount; i++) {
        panels.push(createPanel(cursor, PANEL_WIDTH, 'FULL', false));
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
  getIntervalsForRow: (chain: WallChain, row: number) => { start: number; end: number }[],
  concreteThickness: ConcreteThickness = '150'
): {
  panelsByType: Record<PanelType, ClassifiedPanel[]>;
  allPanels: ClassifiedPanel[];
  allTopos: TopoPlacement[];
  stats: {
    lJunctions: number;
    tJunctions: number;
    xJunctions: number;
    freeEnds: number;
    cornerTemplatesApplied: number;
    toposPlaced: number;
    effectiveOffset: number;
  };
} {
  const lJunctions = detectLJunctions(chains);
  const tJunctions = detectTJunctions(chains);
  const xJunctions = detectXJunctions(chains);
  const freeEnds = detectFreeEnds(chains);
  
  console.log('[generatePanelLayout] Detected:', {
    lJunctions: lJunctions.length,
    tJunctions: tJunctions.length,
    xJunctions: xJunctions.length,
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
  
  try {
    chains.forEach((chain) => {
      if (chain.lengthMm < 50) {
        return;
      }
      chainsProcessed++;
      
      for (let row = 0; row < Math.min(visibleRows, maxRows); row++) {
        const intervals = getIntervalsForRow(chain, row);
        
        // Process BOTH sides: exterior and interior
        const sides: WallSide[] = ['exterior', 'interior'];
        
        sides.forEach((side) => {
          intervals.forEach((interval) => {
            intervalsProcessed++;
            const { panels, topos } = layoutPanelsForChainWithJunctions(
              chain,
              interval.start,
              interval.end,
              row,
              lJunctions,
              tJunctions,
              freeEnds,
              side,
              concreteThickness
            );
            
            panels.forEach(panel => {
              panelsByType[panel.type].push(panel);
              allPanels.push(panel);
              if (panel.isCornerPiece) cornerTemplatesApplied++;
            });
            
            // Only add topos once (from exterior side) to avoid duplicates
            if (side === 'exterior') {
              allTopos.push(...topos);
            }
          });
        });
      }
    });
  } catch (error) {
    console.error('[generatePanelLayout] Error during panel generation:', error);
  }
  
  console.log('[generatePanelLayout] RESULT:', { 
    chainsProcessed, 
    intervalsProcessed, 
    panelsTotal: allPanels.length,
    FULL: panelsByType.FULL.length,
    CORNER_CUT: panelsByType.CORNER_CUT.length,
    CUT_DOUBLE: panelsByType.CUT_DOUBLE.length,
    topos: allTopos.length
  });
  
  return {
    panelsByType,
    allPanels,
    allTopos,
    stats: {
      lJunctions: lJunctions.length,
      tJunctions: tJunctions.length,
      xJunctions: xJunctions.length,
      freeEnds: freeEnds.length,
      cornerTemplatesApplied,
      toposPlaced: allTopos.length,
      effectiveOffset: TOOTH,
    },
  };
}
