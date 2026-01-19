/**
 * Panel Layout Engine for ICF Walls
 * 
 * SIMPLIFIED VERSION - ONLY FULL PANELS (for debugging offset/thickness logic)
 * 
 * RULES:
 * - TOOTH = 1200/17 ≈ 70.588mm (minimum step for cuts/offsets)
 * - Standard panel = 1200mm x 400mm
 * - Wall block = 2 panels (ext + int) + concrete between
 * 
 * COLORS:
 * - YELLOW (FULL): full panel 1200mm
 * - RED (CORNER_CUT): corner/node cut (only at L/T nodes) - CUT ON ONE SIDE ONLY
 * - GREEN (TOPO): topo product (at T-junctions and free ends)
 * 
 * PERPENDICULAR OFFSET FROM DXF CENTERLINE:
 * - 150mm concrete: wall = 4 TOOTH total → panel center at ±1.5T from centerline
 * - 220mm concrete: wall = 5 TOOTH total → panel center at ±2T from centerline
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

// Panel types - SIMPLIFIED: removed CUT_DOUBLE (never cut both sides)
export type PanelType = 'FULL' | 'CUT_SINGLE' | 'CORNER_CUT' | 'TOPO' | 'END_CUT';

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
  lCornerOffsetMm?: number;
  isPrimaryArm?: boolean;
  isExtendingArm?: boolean;
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
  // For L-corners: should we flip interior/exterior sides?
  flipSideAtStart: boolean;
  flipSideAtEnd: boolean;
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
  let flipSideAtStart = false;
  let flipSideAtEnd = false;
  
  // Check L-junctions
  for (const lj of lJunctions) {
    const distToStart = Math.sqrt((chain.startX - lj.x) ** 2 + (chain.startY - lj.y) ** 2);
    const distToEnd = Math.sqrt((chain.endX - lj.x) ** 2 + (chain.endY - lj.y) ** 2);
    
    if (distToStart < tolerance) {
      startType = 'L';
      startL = lj;
      isPrimaryAtStart = lj.primaryChainId === chain.id;
      
      // Determine if we need to flip sides at this L-corner
      // The perpendicular direction for "exterior" should point AWAY from the corner's interior angle
      // Chain direction at START points outward (away from corner)
      const chainDirX = (chain.endX - chain.startX) / chain.lengthMm;
      const chainDirY = (chain.endY - chain.startY) / chain.lengthMm;
      // Perpendicular (90° CW) = "right" side when looking along chain
      const perpX = -chainDirY;
      const perpY = chainDirX;
      
      // Get the other arm's direction (at the same junction)
      const otherChainId = isPrimaryAtStart ? lj.secondaryChainId : lj.primaryChainId;
      const otherAngle = isPrimaryAtStart ? lj.secondaryAngle : lj.primaryAngle;
      const otherDirX = Math.cos(otherAngle);
      const otherDirY = Math.sin(otherAngle);
      
      // Cross product to check if our perpendicular points toward the other arm (interior) or away (exterior)
      // If perp · otherDir > 0, our "exterior" (negative perp) actually points toward the corner interior
      const dot = perpX * otherDirX + perpY * otherDirY;
      
      // If the perpendicular direction aligns with the other arm, we're looking at the "inside" of the L
      // In that case, what we call "exterior" is actually interior, so flip
      flipSideAtStart = dot > 0.3; // Threshold to account for 90° angle (should be ~0 if truly perpendicular)
    }
    if (distToEnd < tolerance) {
      endType = 'L';
      endL = lj;
      isPrimaryAtEnd = lj.primaryChainId === chain.id;
      
      // Same logic for chain END (but direction is reversed - pointing toward corner)
      const chainDirX = (chain.startX - chain.endX) / chain.lengthMm; // Reversed for END
      const chainDirY = (chain.startY - chain.endY) / chain.lengthMm;
      const perpX = -chainDirY;
      const perpY = chainDirX;
      
      const otherAngle = isPrimaryAtEnd ? lj.secondaryAngle : lj.primaryAngle;
      const otherDirX = Math.cos(otherAngle);
      const otherDirY = Math.sin(otherAngle);
      
      const dot = perpX * otherDirX + perpY * otherDirY;
      flipSideAtEnd = dot > 0.3;
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
    hasFreeStart, hasFreeEnd,
    flipSideAtStart, flipSideAtEnd
  };
}

/**
 * Round a length to nearest TOOTH multiple (for clean cuts)
 * Supports rounding to full TOOTH or half-TOOTH increments
 */
function roundToTooth(mm: number): number {
  return Math.round(mm / TOOTH) * TOOTH;
}

/**
 * Round to nearest half-TOOTH (for 220mm concrete which uses 2.5 TOOTH values)
 */
function roundToHalfTooth(mm: number): number {
  const halfTooth = TOOTH / 2;
  return Math.round(mm / halfTooth) * halfTooth;
}

/**
 * Determine the start reservation (cap) for a chain endpoint
 * 
 * SIMPLIFIED VERSION: ALL L-CORNERS ARE FULL PANELS STARTING AT VERTEX
 * No cuts, no special offsets - just place panels from intersection point.
 * Perpendicular offset is handled separately in createPanel.
 */
interface CapResult {
  reservationMm: number;
  type: PanelType;
  addTopo: boolean;
  topoId: string;
  startOffsetMm: number; // Offset along chain from corner vertex (0 = start at vertex)
}

/**
 * Get start cap for a chain endpoint
 * 
 * SIMPLIFIED: L-corners place FULL panels starting at the vertex.
 * No offset, no cut - panels go from intersection outward.
 */
function getStartCap(
  chain: WallChain,
  endpointInfo: ReturnType<typeof getChainEndpointInfo>,
  row: number,
  side: WallSide = 'exterior',
  concreteThickness: ConcreteThickness = '150'
): CapResult {
  let reservationMm = PANEL_WIDTH;
  let type: PanelType = 'FULL';
  let addTopo = false;
  let topoId = '';
  let startOffsetMm = 0; // Start at vertex
  
  switch (endpointInfo.startType) {
    case 'L': {
      // =============================================
      // L-CORNER (chain START) - EXTERIOR FULL CORNER
      // 
      // User spec (from image):
      // - PRIMARY ARM (exterior side): offset 1.5 TOOTH for OUTSIDE
      // - SECONDARY ARM (interior side): offset 2.5 TOOTH for INSIDE
      // 
      // This ensures exterior panels meet perfectly at the corner vertex.
      // =============================================
      reservationMm = PANEL_WIDTH;
      type = 'FULL';
      
      if (endpointInfo.isPrimaryAtStart) {
        // PRIMARY ARM: offset 1.5 TOOTH para FORA (outward)
        startOffsetMm = 1.5 * TOOTH;
        console.log(`[L-START] chain=${chain.id.slice(0,8)} side=${side} row=${row} → PRIMARY offset=+1.5T (${startOffsetMm.toFixed(1)}mm)`);
      } else {
        // SECONDARY ARM: offset 2.5 TOOTH para DENTRO (inward, negative)
        startOffsetMm = -2.5 * TOOTH;
        console.log(`[L-START] chain=${chain.id.slice(0,8)} side=${side} row=${row} → SECONDARY offset=-2.5T (${startOffsetMm.toFixed(1)}mm)`);
      }
      break;
    }
      
    case 'T':
      // T-JUNCTION: same simplified approach for now
      if (endpointInfo.isBranchAtStart) {
        reservationMm = PANEL_WIDTH;
        type = 'FULL';
      } else {
        reservationMm = PANEL_WIDTH;
        type = 'FULL';
        addTopo = true;
        topoId = endpointInfo.startT?.nodeId || `T-start-${chain.id}`;
      }
      break;
      
    case 'free':
      reservationMm = PANEL_WIDTH;
      type = 'FULL';
      addTopo = true;
      topoId = `free-start-${chain.id}`;
      break;
      
    default:
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
  let reservationMm = PANEL_WIDTH;
  let type: PanelType = 'FULL';
  let addTopo = false;
  let topoId = '';
  let startOffsetMm = 0; // Start at vertex
  
  switch (endpointInfo.endType) {
    case 'L': {
      // =============================================
      // L-CORNER (chain END) - EXTERIOR FULL CORNER
      // 
      // User spec (from image):
      // - PRIMARY ARM (exterior side): offset 1.5 TOOTH for OUTSIDE
      // - SECONDARY ARM (interior side): offset 2.5 TOOTH for INSIDE
      // 
      // For END, offset is applied from the END of the chain toward the vertex.
      // Negative offset = panels extend past the vertex (toward corner).
      // Positive offset = panels stop before the vertex.
      // =============================================
      reservationMm = PANEL_WIDTH;
      type = 'FULL';
      
      if (endpointInfo.isPrimaryAtEnd) {
        // PRIMARY ARM: offset 1.5 TOOTH para FORA (outward from vertex)
        startOffsetMm = 1.5 * TOOTH;
        console.log(`[L-END] chain=${chain.id.slice(0,8)} side=${side} row=${row} → PRIMARY offset=+1.5T (${startOffsetMm.toFixed(1)}mm)`);
      } else {
        // SECONDARY ARM: offset 2.5 TOOTH para DENTRO (inward, negative)
        startOffsetMm = -2.5 * TOOTH;
        console.log(`[L-END] chain=${chain.id.slice(0,8)} side=${side} row=${row} → SECONDARY offset=-2.5T (${startOffsetMm.toFixed(1)}mm)`);
      }
      break;
    }
      
    case 'T':
      // T-JUNCTION: same simplified approach for now
      if (endpointInfo.isBranchAtEnd) {
        reservationMm = PANEL_WIDTH;
        type = 'FULL';
      } else {
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
    // Wall total in TOOTH units:
    // - 150mm: 4 TOOTH (1 foam + 2 core + 1 foam)
    // - 220mm: 5 TOOTH (1 foam + 3 core + 1 foam)
    //
    // Panel center offset from DXF center:
    // - 150mm: 2 - 0.5 = 1.5 TOOTH
    // - 220mm: 2.5 - 0.5 = 2 TOOTH
    
    // Perpendicular unit vector (90° CW from wall direction)
    // Positive perpendicular = "right" side when looking along wall direction
    const perpX = -dirY;
    const perpZ = dirX;
    
    // Determine if we should flip the side for this panel at L-corners
    // This corrects cases where "exterior" points toward the corner interior
    const isNearStart = startPos <= PANEL_WIDTH; // First panel at chain start
    const isNearEnd = endPos >= chain.lengthMm - PANEL_WIDTH; // Last panel at chain end
    
    let effectiveSide = side;
    if (isNearStart && endpointInfo.startType === 'L' && endpointInfo.flipSideAtStart) {
      effectiveSide = side === 'exterior' ? 'interior' : 'exterior';
      console.log(`[FLIP-START] chain=${chain.id.slice(0,8)} side=${side}→${effectiveSide}`);
    }
    if (isNearEnd && endpointInfo.endType === 'L' && endpointInfo.flipSideAtEnd) {
      effectiveSide = side === 'exterior' ? 'interior' : 'exterior';
      console.log(`[FLIP-END] chain=${chain.id.slice(0,8)} side=${side}→${effectiveSide}`);
    }
    
    // Panel positioning perpendicular to wall:
    // Wall total thickness = 4 TOOTH (150mm) or 5 TOOTH (220mm)
    // Panel center should be at (wallTotal/2 - FOAM_THICKNESS/2) from DXF center
    // For 150mm: (4/2 - 1/2) = 1.5 TOOTH... NO, this is wrong
    // 
    // Correct calculation:
    // - Exterior face of wall is at wallTotal/2 from center
    // - Panel is 1 TOOTH thick (FOAM_THICKNESS)
    // - Panel center is at (wallTotal/2 - FOAM_THICKNESS/2) from center
    // 
    // For 150mm (4 TOOTH): center at (2 - 0.5) = 1.5 TOOTH
    // For 220mm (5 TOOTH): center at (2.5 - 0.5) = 2 TOOTH
    //
    // But the user says: for 220mm, offset from DXF should be 2.5 TOOTH to exterior face
    // So panel CENTER is at 2.5 - 0.5 = 2 TOOTH from center
    // Total exterior-to-exterior = 2 * 2.5 = 5 TOOTH ✓
    
    const wallTotalTooth = concreteThickness === '150' ? 4 : 5;
    const wallHalfTooth = wallTotalTooth / 2;
    const panelCenterOffsetTooth = wallHalfTooth - 0.5; // Subtract half of foam thickness (0.5 TOOTH)
    const panelCenterOffsetMm = panelCenterOffsetTooth * TOOTH;
    
    if (effectiveSide === 'interior') {
      // Interior panel: offset to the positive perpendicular side (inside of building)
      posX += perpX * panelCenterOffsetMm;
      posZ += perpZ * panelCenterOffsetMm;
    } else {
      // Exterior panel: offset to the negative perpendicular side (outside of building)
      posX += perpX * (-panelCenterOffsetMm);
      posZ += perpZ * (-panelCenterOffsetMm);
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
    
    // Calculate cuts (how much was removed from full panel width) - always ONE side only
    const cutLeftMm = type === 'CORNER_CUT' ? PANEL_WIDTH - width : 0;
    const cutRightMm = 0; // Never cut both sides

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
    const type: PanelType = panelWidth < PANEL_WIDTH ? 'CORNER_CUT' : (isAtChainStart ? leftCap.type : 'FULL');
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
    console.log(`[L-CORNER START] chain=${chain.id.slice(0,8)} side=${side} offset=${leftCap.startOffsetMm.toFixed(1)}mm type=${leftCap.type} width=${leftCap.reservationMm}mm`);
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
        panels.push(createPanel(leftEdge, remainder, 'CORNER_CUT', false));
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
      
      // Place MIDDLE cut piece (if any) - single-side cut
      if (remainder >= MIN_CUT_MM) {
        panels.push(createPanel(cursor, remainder, 'CORNER_CUT', false));
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
