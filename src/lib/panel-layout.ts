/**
 * Panel Layout Engine for ICF Walls
 * 
 * Implements:
 * - L-corner templates with PAR/ÍMPAR alternation
 * - T-junction handling with MAIN/BRANCH detection and TOPO placement
 * - "Start from ends, cuts in the middle" fill strategy
 */

import { WallChain, ChainNode } from './wall-chains';
import * as THREE from 'three';
import { PANEL_WIDTH, PANEL_HEIGHT } from '@/types/icf';

// Scale factor: mm to meters
const SCALE = 0.001;

// Stagger offset for odd rows
const STAGGER_OFFSET = 600; // mm

// Minimum cut length
const MIN_CUT_MM = 100;

// Panel types
export type PanelType = 'FULL' | 'CUT_SINGLE' | 'CUT_DOUBLE' | 'CORNER_CUT' | 'TOPO';

// Classified panel placement
export interface ClassifiedPanel {
  matrix: THREE.Matrix4;
  type: PanelType;
  widthMm: number;
  rowIndex: number;
  chainId: string;
  isCornerPiece: boolean;
  isTopoPiece?: boolean;
}

// Topo placement for T-junctions
export interface TopoPlacement {
  matrix: THREE.Matrix4;
  rowIndex: number;
  chainId: string;
  junctionId: string;
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

/**
 * Detect L-junctions (exactly 2 chains meeting at ~90°)
 * Uses deterministic ordering: lower chainId = primary
 */
export function detectLJunctions(chains: WallChain[]): LJunctionInfo[] {
  const nodeMap = new Map<string, { x: number; y: number; chainIds: string[]; angles: number[] }>();
  const TOLERANCE = 15; // mm
  
  const getNodeKey = (x: number, y: number) => {
    const rx = Math.round(x / TOLERANCE) * TOLERANCE;
    const ry = Math.round(y / TOLERANCE) * TOLERANCE;
    return `${rx},${ry}`;
  };
  
  chains.forEach(chain => {
    // Start node
    const startKey = getNodeKey(chain.startX, chain.startY);
    if (!nodeMap.has(startKey)) {
      nodeMap.set(startKey, { x: chain.startX, y: chain.startY, chainIds: [], angles: [] });
    }
    const startNode = nodeMap.get(startKey)!;
    if (!startNode.chainIds.includes(chain.id)) {
      startNode.chainIds.push(chain.id);
      startNode.angles.push(chain.angle);
    }
    
    // End node
    const endKey = getNodeKey(chain.endX, chain.endY);
    if (!nodeMap.has(endKey)) {
      nodeMap.set(endKey, { x: chain.endX, y: chain.endY, chainIds: [], angles: [] });
    }
    const endNode = nodeMap.get(endKey)!;
    if (!endNode.chainIds.includes(chain.id)) {
      endNode.chainIds.push(chain.id);
      endNode.angles.push(chain.angle + Math.PI);
    }
  });
  
  const lJunctions: LJunctionInfo[] = [];
  
  nodeMap.forEach((node, key) => {
    if (node.chainIds.length !== 2) return;
    
    // Check if angles are roughly perpendicular
    const angleDiff = Math.abs(node.angles[0] - node.angles[1]);
    const normalizedDiff = angleDiff % Math.PI;
    const isLShape = Math.abs(normalizedDiff - Math.PI / 2) < 0.35;
    
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
  const TOLERANCE = 15; // mm
  
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
    // Two chains are colinear if their angle difference is close to 0 or π
    const { chainIds, angles } = node;
    
    let mainPair: [number, number] | null = null;
    let branchIdx: number = -1;
    
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const diff = Math.abs(angles[i] - angles[j]);
        const normDiff = diff % Math.PI;
        // Close to 0 or π means colinear (opposite directions)
        if (normDiff < 0.25 || Math.abs(normDiff - Math.PI) < 0.25) {
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
 * Get corner info for a chain (L-junction at start/end)
 */
function getCornerInfoForChain(
  chain: WallChain,
  lJunctions: LJunctionInfo[],
  tolerance: number = 20
): { 
  startsAtL: LJunctionInfo | null; 
  endsAtL: LJunctionInfo | null;
  isPrimaryAtStart: boolean;
  isPrimaryAtEnd: boolean;
} {
  let startsAtL: LJunctionInfo | null = null;
  let endsAtL: LJunctionInfo | null = null;
  let isPrimaryAtStart = false;
  let isPrimaryAtEnd = false;
  
  for (const lj of lJunctions) {
    const distToStart = Math.sqrt((chain.startX - lj.x) ** 2 + (chain.startY - lj.y) ** 2);
    const distToEnd = Math.sqrt((chain.endX - lj.x) ** 2 + (chain.endY - lj.y) ** 2);
    
    if (distToStart < tolerance) {
      startsAtL = lj;
      isPrimaryAtStart = lj.primaryChainId === chain.id;
    }
    if (distToEnd < tolerance) {
      endsAtL = lj;
      isPrimaryAtEnd = lj.primaryChainId === chain.id;
    }
  }
  
  return { startsAtL, endsAtL, isPrimaryAtStart, isPrimaryAtEnd };
}

/**
 * Get T-junction info for a chain
 */
function getTJunctionInfoForChain(
  chain: WallChain,
  tJunctions: TJunctionInfo[],
  tolerance: number = 20
): {
  startsAtT: TJunctionInfo | null;
  endsAtT: TJunctionInfo | null;
  isBranchAtStart: boolean;
  isBranchAtEnd: boolean;
} {
  let startsAtT: TJunctionInfo | null = null;
  let endsAtT: TJunctionInfo | null = null;
  let isBranchAtStart = false;
  let isBranchAtEnd = false;
  
  for (const tj of tJunctions) {
    const distToStart = Math.sqrt((chain.startX - tj.x) ** 2 + (chain.startY - tj.y) ** 2);
    const distToEnd = Math.sqrt((chain.endX - tj.x) ** 2 + (chain.endY - tj.y) ** 2);
    
    if (distToStart < tolerance) {
      startsAtT = tj;
      isBranchAtStart = tj.branchChainId === chain.id;
    }
    if (distToEnd < tolerance) {
      endsAtT = tj;
      isBranchAtEnd = tj.branchChainId === chain.id;
    }
  }
  
  return { startsAtT, endsAtT, isBranchAtStart, isBranchAtEnd };
}

/**
 * Layout panels for a chain interval with L-corner and T-junction awareness
 * 
 * RULES:
 * - L-corners: Even rows → primary=FULL, secondary=600mm CORNER_CUT; Odd rows → swap
 * - T-junctions: Branch starts with 600mm CORNER_CUT (even) or FULL (odd)
 * - Fill from BOTH ends with full panels
 * - Remaining cut goes in the MIDDLE
 */
export function layoutPanelsForChainWithJunctions(
  chain: WallChain,
  intervalStart: number,
  intervalEnd: number,
  row: number,
  lJunctions: LJunctionInfo[],
  tJunctions: TJunctionInfo[]
): { panels: ClassifiedPanel[]; topos: TopoPlacement[] } {
  const panels: ClassifiedPanel[] = [];
  const topos: TopoPlacement[] = [];
  const intervalLength = intervalEnd - intervalStart;
  
  if (intervalLength < MIN_CUT_MM) return { panels, topos };
  
  const isOddRow = row % 2 === 1;
  const angle = Math.atan2(chain.endY - chain.startY, chain.endX - chain.startX);
  const dirX = (chain.endX - chain.startX) / chain.lengthMm;
  const dirY = (chain.endY - chain.startY) / chain.lengthMm;
  
  const lCornerInfo = getCornerInfoForChain(chain, lJunctions);
  const tJunctionInfo = getTJunctionInfoForChain(chain, tJunctions);
  
  const createPanel = (centerPos: number, width: number, type: PanelType, isCorner: boolean = false): ClassifiedPanel => {
    const posX = chain.startX + dirX * centerPos;
    const posZ = chain.startY + dirY * centerPos;
    const posY = row * PANEL_HEIGHT + PANEL_HEIGHT / 2;

    const matrix = new THREE.Matrix4();
    matrix.compose(
      new THREE.Vector3(posX * SCALE, posY * SCALE, posZ * SCALE),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
      new THREE.Vector3(width / PANEL_WIDTH, 1, 1)
    );

    return { matrix, type, widthMm: width, rowIndex: row, chainId: chain.id, isCornerPiece: isCorner };
  };
  
  const createTopo = (centerPos: number, tj: TJunctionInfo): TopoPlacement => {
    const posX = chain.startX + dirX * centerPos;
    const posZ = chain.startY + dirY * centerPos;
    const posY = row * PANEL_HEIGHT + PANEL_HEIGHT / 2;
    
    const matrix = new THREE.Matrix4();
    matrix.compose(
      new THREE.Vector3(posX * SCALE, posY * SCALE, posZ * SCALE),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
      new THREE.Vector3(1, 1, 1)
    );
    
    return { matrix, rowIndex: row, chainId: chain.id, junctionId: tj.nodeId };
  };
  
  // ============= DETERMINE LEFT (START) RESERVATION =============
  let leftReservation = 0;
  let leftIsCornerCut = false;
  let createLeftTopo = false;
  let leftTJunction: TJunctionInfo | null = null;
  
  // L-junction at chain start
  if (lCornerInfo.startsAtL && intervalStart === 0) {
    const isPrimary = lCornerInfo.isPrimaryAtStart;
    if (!isOddRow) {
      // EVEN ROW: primary=FULL, secondary=600mm
      leftReservation = isPrimary ? PANEL_WIDTH : STAGGER_OFFSET;
      leftIsCornerCut = !isPrimary;
    } else {
      // ODD ROW: primary=600mm, secondary=FULL
      leftReservation = isPrimary ? STAGGER_OFFSET : PANEL_WIDTH;
      leftIsCornerCut = isPrimary;
    }
  }
  // T-junction at chain start (branch)
  else if (tJunctionInfo.startsAtT && intervalStart === 0 && tJunctionInfo.isBranchAtStart) {
    leftTJunction = tJunctionInfo.startsAtT;
    if (!isOddRow) {
      // EVEN ROW: branch starts with 600mm CORNER_CUT
      leftReservation = STAGGER_OFFSET;
      leftIsCornerCut = true;
      createLeftTopo = true; // TOPO at T-junction
    } else {
      // ODD ROW: branch starts with FULL
      leftReservation = PANEL_WIDTH;
      leftIsCornerCut = false;
      createLeftTopo = true; // TOPO at T-junction (metade das fiadas - all odd rows)
    }
  }
  // Standard stagger for odd rows (no junction)
  else if (isOddRow && intervalStart === 0) {
    leftReservation = STAGGER_OFFSET;
    leftIsCornerCut = true;
  }
  
  // ============= DETERMINE RIGHT (END) RESERVATION =============
  let rightReservation = 0;
  let rightIsCornerCut = false;
  let createRightTopo = false;
  let rightTJunction: TJunctionInfo | null = null;
  
  // L-junction at chain end
  if (lCornerInfo.endsAtL && intervalEnd === chain.lengthMm) {
    const isPrimary = lCornerInfo.isPrimaryAtEnd;
    if (!isOddRow) {
      rightReservation = isPrimary ? PANEL_WIDTH : STAGGER_OFFSET;
      rightIsCornerCut = !isPrimary;
    } else {
      rightReservation = isPrimary ? STAGGER_OFFSET : PANEL_WIDTH;
      rightIsCornerCut = isPrimary;
    }
  }
  // T-junction at chain end (branch)
  else if (tJunctionInfo.endsAtT && intervalEnd === chain.lengthMm && tJunctionInfo.isBranchAtEnd) {
    rightTJunction = tJunctionInfo.endsAtT;
    if (!isOddRow) {
      rightReservation = STAGGER_OFFSET;
      rightIsCornerCut = true;
      createRightTopo = true;
    } else {
      rightReservation = PANEL_WIDTH;
      rightIsCornerCut = false;
      createRightTopo = true;
    }
  }
  
  // ============= PLACE LEFT RESERVATION =============
  let cursor = intervalStart;
  if (leftReservation > 0) {
    const reserveWidth = Math.min(leftReservation, intervalLength);
    if (reserveWidth >= MIN_CUT_MM) {
      const centerPos = cursor + reserveWidth / 2;
      const type: PanelType = leftIsCornerCut ? 'CORNER_CUT' : 'FULL';
      panels.push(createPanel(centerPos, reserveWidth, type, true));
      
      // Create TOPO for T-junction
      if (createLeftTopo && leftTJunction) {
        topos.push(createTopo(cursor, leftTJunction));
      }
    }
    cursor += leftReservation;
  }
  
  // ============= CALCULATE MIDDLE SECTION =============
  const rightEdge = intervalEnd;
  const rightStart = rightReservation > 0 ? rightEdge - rightReservation : rightEdge;
  const middleStart = cursor;
  const middleEnd = rightStart;
  const middleLength = Math.max(0, middleEnd - middleStart);
  
  if (middleLength >= MIN_CUT_MM) {
    const fullPanelCount = Math.floor(middleLength / PANEL_WIDTH);
    const remainder = middleLength - (fullPanelCount * PANEL_WIDTH);
    
    // ============= FILL FROM BOTH ENDS, CUT IN MIDDLE =============
    // Distribute full panels evenly from left and right
    const leftCount = Math.floor(fullPanelCount / 2);
    const rightCount = fullPanelCount - leftCount;
    
    // Place LEFT side full panels
    for (let i = 0; i < leftCount; i++) {
      const centerPos = cursor + PANEL_WIDTH / 2;
      panels.push(createPanel(centerPos, PANEL_WIDTH, 'FULL', false));
      cursor += PANEL_WIDTH;
    }
    
    // Place MIDDLE cut piece (if any) - this is the "corte de acerto"
    if (remainder >= MIN_CUT_MM) {
      const centerPos = cursor + remainder / 2;
      // This is a cut piece in the middle - mark as CUT_DOUBLE (orange)
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
  if (rightReservation > 0 && rightStart < rightEdge) {
    const reserveWidth = Math.min(rightReservation, rightEdge - rightStart);
    if (reserveWidth >= MIN_CUT_MM) {
      const centerPos = rightStart + reserveWidth / 2;
      const type: PanelType = rightIsCornerCut ? 'CORNER_CUT' : 'FULL';
      panels.push(createPanel(centerPos, reserveWidth, type, true));
      
      // Create TOPO for T-junction
      if (createRightTopo && rightTJunction) {
        topos.push(createTopo(rightStart + reserveWidth, rightTJunction));
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
    cornerTemplatesApplied: number;
    toposPlaced: number;
  };
} {
  const lJunctions = detectLJunctions(chains);
  const tJunctions = detectTJunctions(chains);
  
  const panelsByType: Record<PanelType, ClassifiedPanel[]> = {
    FULL: [],
    CUT_SINGLE: [],
    CUT_DOUBLE: [],
    CORNER_CUT: [],
    TOPO: [],
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
          tJunctions
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
      cornerTemplatesApplied,
      toposPlaced: allTopos.length,
    },
  };
}
