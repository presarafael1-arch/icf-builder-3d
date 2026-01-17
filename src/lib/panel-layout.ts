/**
 * Panel Layout Engine for ICF Walls
 * 
 * RULES:
 * - TOOTH = 1200/17 ≈ 70.588mm (minimum step for cuts/offsets)
 * - Standard panel = 1200mm x 400mm
 * - Stagger offset = 600mm on odd rows (or nearest TOOTH multiple if needed)
 * 
 * L-CORNER RULES:
 *   - Row 1 (even, index 0): Exterior starts with FULL, Interior starts with CORNER_CUT (TOOTH cut)
 *   - Row 2 (odd, index 1): Both start with CORNER_CUT (TOOTH cut)
 *   
 * T-JUNCTION RULES:
 *   - "Costas" (main wall) continues through
 *   - "Perna" (branch) starts at junction
 *   - Row 1: No TOPO on main, branch starts normally
 *   - Row 2: TOPO on main at junction point
 *   
 * FREE ENDS (ponta livre):
 *   - Must have TOPO to close for concrete fill
 *   - Cut at end if not multiple of 1200
 *   
 * FILL STRATEGY:
 *   - Start from BOTH ends
 *   - Fill with full panels toward middle
 *   - Any adjustment cut (ORANGE) goes in the MIDDLE only
 */

import { WallChain, ChainNode } from './wall-chains';
import * as THREE from 'three';
import { PANEL_WIDTH, PANEL_HEIGHT } from '@/types/icf';

// Scale factor: mm to meters
const SCALE = 0.001;

// TOOTH = 1200/17 - minimum cut/offset step
export const TOOTH = PANEL_WIDTH / 17; // ≈70.588mm

// Stagger offset for odd rows (600mm = 8.5 TOOTH, rounded to 8*TOOTH for cleaner math)
const STAGGER_OFFSET = 600; // mm - use 600 directly for now

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
  mainChainIds: [string, string]; // The two colinear chains
  branchChainId: string;          // The perpendicular branch
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
 * Uses deterministic ordering: lower chainId = primary
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
    
    // Find the two colinear chains (MAIN) and the perpendicular one (BRANCH)
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
 * Get corner/junction info for a chain
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
  isPrimaryAtStart: boolean;
  isPrimaryAtEnd: boolean;
  isBranchAtStart: boolean;
  isBranchAtEnd: boolean;
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
 * Round a length to nearest TOOTH multiple
 */
function roundToTooth(mm: number): number {
  return Math.round(mm / TOOTH) * TOOTH;
}

/**
 * Layout panels for a chain interval with proper L/T/free-end rules
 * 
 * FILL STRATEGY:
 * 1. Determine reservation at START (left) based on junction type
 * 2. Determine reservation at END (right) based on junction type
 * 3. Fill from BOTH ends with full panels toward middle
 * 4. Put any adjustment cut (CUT_DOUBLE/ORANGE) in the MIDDLE
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
  
  const isOddRow = row % 2 === 1; // Row 1 = index 0 = even, Row 2 = index 1 = odd
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
  
  // ============= DETERMINE LEFT (START) RESERVATION =============
  let leftReservation = 0;
  let leftType: PanelType = 'FULL';
  let addLeftTopo = false;
  let leftTopoId = '';
  
  // Only apply junction rules if this interval starts at the chain start
  if (intervalStart === 0) {
    switch (endpointInfo.startType) {
      case 'L':
        // L-CORNER RULES
        // Row 1 (even): primary=FULL, secondary=CORNER_CUT (TOOTH)
        // Row 2 (odd): both=CORNER_CUT
        if (!isOddRow) {
          // Even row (Row 1)
          if (endpointInfo.isPrimaryAtStart) {
            leftReservation = PANEL_WIDTH;
            leftType = 'FULL';
          } else {
            leftReservation = STAGGER_OFFSET; // 600mm (or use TOOTH for tighter cut)
            leftType = 'CORNER_CUT';
          }
        } else {
          // Odd row (Row 2) - both sides get corner cut
          leftReservation = STAGGER_OFFSET;
          leftType = 'CORNER_CUT';
        }
        break;
        
      case 'T':
        // T-JUNCTION RULES
        if (endpointInfo.isBranchAtStart) {
          // This chain is the BRANCH (perna)
          if (!isOddRow) {
            // Even row: branch starts with corner cut
            leftReservation = STAGGER_OFFSET;
            leftType = 'CORNER_CUT';
          } else {
            // Odd row: branch starts with full panel, add TOPO on main
            leftReservation = PANEL_WIDTH;
            leftType = 'FULL';
            addLeftTopo = true;
            leftTopoId = endpointInfo.startT?.nodeId || 'T-start';
          }
        } else {
          // This chain is MAIN (costas) - continues through
          // Even row: no special treatment
          // Odd row: TOPO at junction point
          leftReservation = PANEL_WIDTH;
          leftType = 'FULL';
          if (isOddRow) {
            addLeftTopo = true;
            leftTopoId = endpointInfo.startT?.nodeId || 'T-start';
          }
        }
        break;
        
      case 'free':
        // FREE END - apply stagger and create TOPO
        if (isOddRow) {
          leftReservation = STAGGER_OFFSET;
          leftType = 'CORNER_CUT'; // Stagger cut
        } else {
          leftReservation = PANEL_WIDTH;
          leftType = 'FULL';
        }
        addLeftTopo = true;
        leftTopoId = `free-start-${chain.id}`;
        break;
        
      default:
        // No junction - just apply stagger for odd rows
        if (isOddRow) {
          leftReservation = STAGGER_OFFSET;
          leftType = 'CORNER_CUT';
        } else {
          leftReservation = PANEL_WIDTH;
          leftType = 'FULL';
        }
    }
  } else {
    // Interval doesn't start at chain start - just fill normally
    leftReservation = PANEL_WIDTH;
    leftType = 'FULL';
  }
  
  // ============= DETERMINE RIGHT (END) RESERVATION =============
  let rightReservation = 0;
  let rightType: PanelType = 'FULL';
  let addRightTopo = false;
  let rightTopoId = '';
  
  // Only apply junction rules if this interval ends at the chain end
  if (intervalEnd === chain.lengthMm) {
    switch (endpointInfo.endType) {
      case 'L':
        // L-CORNER RULES (same as start but for end)
        if (!isOddRow) {
          if (endpointInfo.isPrimaryAtEnd) {
            rightReservation = PANEL_WIDTH;
            rightType = 'FULL';
          } else {
            rightReservation = STAGGER_OFFSET;
            rightType = 'CORNER_CUT';
          }
        } else {
          rightReservation = STAGGER_OFFSET;
          rightType = 'CORNER_CUT';
        }
        break;
        
      case 'T':
        if (endpointInfo.isBranchAtEnd) {
          if (!isOddRow) {
            rightReservation = STAGGER_OFFSET;
            rightType = 'CORNER_CUT';
          } else {
            rightReservation = PANEL_WIDTH;
            rightType = 'FULL';
            addRightTopo = true;
            rightTopoId = endpointInfo.endT?.nodeId || 'T-end';
          }
        } else {
          rightReservation = PANEL_WIDTH;
          rightType = 'FULL';
          if (isOddRow) {
            addRightTopo = true;
            rightTopoId = endpointInfo.endT?.nodeId || 'T-end';
          }
        }
        break;
        
      case 'free':
        // FREE END - TOPO required to close
        rightReservation = PANEL_WIDTH;
        rightType = 'FULL';
        addRightTopo = true;
        rightTopoId = `free-end-${chain.id}`;
        break;
        
      default:
        rightReservation = PANEL_WIDTH;
        rightType = 'FULL';
    }
  } else {
    rightReservation = PANEL_WIDTH;
    rightType = 'FULL';
  }
  
  // ============= CALCULATE USABLE MIDDLE SECTION =============
  // Clamp reservations to available length
  const totalReservations = leftReservation + rightReservation;
  
  if (totalReservations >= intervalLength) {
    // Not enough room for both reservations - just place one panel
    const centerPos = intervalStart + intervalLength / 2;
    const type: PanelType = intervalLength < PANEL_WIDTH ? 'CUT_DOUBLE' : leftType;
    panels.push(createPanel(centerPos, intervalLength, type, true));
    
    // Add TOPOs if needed
    if (addLeftTopo) topos.push(createTopo(intervalStart, endpointInfo.startType === 'free' ? 'free_end' : 'T_junction', leftTopoId));
    if (addRightTopo) topos.push(createTopo(intervalEnd, endpointInfo.endType === 'free' ? 'free_end' : 'T_junction', rightTopoId));
    
    return { panels, topos };
  }
  
  const middleStart = intervalStart + leftReservation;
  const middleEnd = intervalEnd - rightReservation;
  const middleLength = middleEnd - middleStart;
  
  // ============= PLACE LEFT RESERVATION =============
  if (leftReservation >= MIN_CUT_MM) {
    const centerPos = intervalStart + leftReservation / 2;
    panels.push(createPanel(centerPos, leftReservation, leftType, leftType === 'CORNER_CUT'));
    
    if (addLeftTopo) {
      topos.push(createTopo(intervalStart, endpointInfo.startType === 'free' ? 'free_end' : 'T_junction', leftTopoId));
    }
  }
  
  // ============= FILL MIDDLE FROM BOTH ENDS =============
  if (middleLength >= MIN_CUT_MM) {
    const fullPanelCount = Math.floor(middleLength / PANEL_WIDTH);
    const remainder = middleLength - (fullPanelCount * PANEL_WIDTH);
    
    // Split full panels between left and right
    const leftCount = Math.floor(fullPanelCount / 2);
    const rightCount = fullPanelCount - leftCount;
    
    let cursor = middleStart;
    
    // Place LEFT side full panels
    for (let i = 0; i < leftCount; i++) {
      const centerPos = cursor + PANEL_WIDTH / 2;
      panels.push(createPanel(centerPos, PANEL_WIDTH, 'FULL', false));
      cursor += PANEL_WIDTH;
    }
    
    // Place MIDDLE cut piece (if any) - CUT_DOUBLE (ORANGE)
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
  
  // ============= PLACE RIGHT RESERVATION =============
  if (rightReservation >= MIN_CUT_MM) {
    const centerPos = middleEnd + rightReservation / 2;
    panels.push(createPanel(centerPos, rightReservation, rightType, rightType === 'CORNER_CUT'));
    
    if (addRightTopo) {
      topos.push(createTopo(intervalEnd, endpointInfo.endType === 'free' ? 'free_end' : 'T_junction', rightTopoId));
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
  
  chains.forEach((chain) => {
    if (chain.lengthMm < 50) return;
    
    for (let row = 0; row < Math.min(visibleRows, maxRows); row++) {
      const intervals = getIntervalsForRow(chain, row);
      
      intervals.forEach((interval) => {
        const { panels, topos } = layoutPanelsForChainWithJunctions(
          chain,
          interval.start,
          interval.end,
          row,
          lJunctions,
          tJunctions,
          freeEnds
        );
        
        panels.forEach(panel => {
          panelsByType[panel.type].push(panel);
          allPanels.push(panel);
          if (panel.isCornerPiece) cornerTemplatesApplied++;
        });
        
        allTopos.push(...topos);
      });
    }
  });
  
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
      effectiveOffset: STAGGER_OFFSET,
    },
  };
}
