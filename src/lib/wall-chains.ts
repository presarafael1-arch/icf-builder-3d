// Wall Chains Module for OMNI ICF WALLS 3D PLANNER
// Consolidates colinear adjacent wall segments into chains for proper BOM calculation
// This prevents overcounting panels when DXF comes fragmented

import { WallSegment, Junction, JunctionType, PANEL_WIDTH } from '@/types/icf';

export interface WallChain {
  id: string;
  segments: WallSegment[];
  lengthMm: number;
  angle: number; // Normalized angle in radians [0, π)
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  startNodeId: string | null;
  endNodeId: string | null;
}

export interface ChainNode {
  id: string;
  x: number;
  y: number;
  type: JunctionType;
  connectedChainIds: string[];
  angles: number[];
}

export interface ChainsResult {
  chains: WallChain[];
  nodes: ChainNode[];
  stats: {
    originalSegments: number;
    chainsCount: number;
    reductionPercent: number;
    totalLengthMm: number;
    minChainLengthMm: number;
    maxChainLengthMm: number;
    avgChainLengthMm: number;
  };
  junctionCounts: {
    L: number;
    T: number;
    X: number;
    end: number;
  };
}

// Tolerances - increased for better merging of fragmented DXF
const ENDPOINT_TOL_MM = 20; // Tolerance for matching endpoints (was 15)
const ANGLE_TOL_RAD = 0.0524; // ~3 degrees (was 0.05)
const MIN_SEGMENT_MM = 80; // Segments shorter than this are noise

/**
 * Calculate segment length
 */
function calculateLength(seg: { startX: number; startY: number; endX: number; endY: number }): number {
  const dx = seg.endX - seg.startX;
  const dy = seg.endY - seg.startY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Calculate normalized angle [0, π) - direction-independent
 */
function calculateNormalizedAngle(seg: { startX: number; startY: number; endX: number; endY: number }): number {
  const dx = seg.endX - seg.startX;
  const dy = seg.endY - seg.startY;
  let angle = Math.atan2(dy, dx);
  // Normalize to [0, π) since direction doesn't matter for colinearity
  if (angle < 0) angle += Math.PI;
  if (angle >= Math.PI) angle -= Math.PI;
  return angle;
}

/**
 * Check if two points are coincident within tolerance
 */
function pointsCoincide(x1: number, y1: number, x2: number, y2: number, tol: number = ENDPOINT_TOL_MM): boolean {
  const dx = Math.abs(x1 - x2);
  const dy = Math.abs(y1 - y2);
  return dx <= tol && dy <= tol;
}

/**
 * Check if two angles are colinear within tolerance
 */
function anglesColinear(a1: number, a2: number, tol: number = ANGLE_TOL_RAD): boolean {
  let diff = Math.abs(a1 - a2);
  // Handle wraparound at π
  if (diff > Math.PI / 2) diff = Math.PI - diff;
  return diff <= tol;
}

/**
 * Get a point key for clustering
 */
function getPointKey(x: number, y: number, tol: number = ENDPOINT_TOL_MM): string {
  const rx = Math.round(x / tol) * tol;
  const ry = Math.round(y / tol) * tol;
  return `${rx},${ry}`;
}

/**
 * Main function: build chains from wall segments
 * Groups colinear adjacent segments into logical wall chains
 */
export function buildWallChains(walls: WallSegment[]): ChainsResult {
  // Filter out noise segments (too short)
  const filteredWalls = walls.filter(w => calculateLength(w) >= MIN_SEGMENT_MM);
  
  if (filteredWalls.length === 0) {
    return {
      chains: [],
      nodes: [],
      stats: {
        originalSegments: walls.length,
        chainsCount: 0,
        reductionPercent: 100,
        totalLengthMm: 0,
        minChainLengthMm: 0,
        maxChainLengthMm: 0,
        avgChainLengthMm: 0
      },
      junctionCounts: { L: 0, T: 0, X: 0, end: 0 }
    };
  }
  
  // Use filtered walls from now on
  const workingWalls = filteredWalls;

  // Step 1: Cluster endpoints (snap nearby points together)
  const pointClusters = new Map<string, { x: number; y: number; segmentEnds: { segIndex: number; isStart: boolean }[] }>();
  
  workingWalls.forEach((wall, idx) => {
    const startKey = getPointKey(wall.startX, wall.startY);
    const endKey = getPointKey(wall.endX, wall.endY);
    
    if (!pointClusters.has(startKey)) {
      pointClusters.set(startKey, { x: wall.startX, y: wall.startY, segmentEnds: [] });
    }
    pointClusters.get(startKey)!.segmentEnds.push({ segIndex: idx, isStart: true });
    
    if (!pointClusters.has(endKey)) {
      pointClusters.set(endKey, { x: wall.endX, y: wall.endY, segmentEnds: [] });
    }
    pointClusters.get(endKey)!.segmentEnds.push({ segIndex: idx, isStart: false });
  });

  // Step 2: Build adjacency for segments by endpoint
  // For each segment, find which other segments share an endpoint
  const segmentAdjacency: Map<number, { neighborIdx: number; viaStart: boolean; neighborViaStart: boolean }[]> = new Map();
  workingWalls.forEach((_, idx) => segmentAdjacency.set(idx, []));

  pointClusters.forEach((cluster) => {
    const ends = cluster.segmentEnds;
    // Connect all segments that share this point
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const a = ends[i];
        const b = ends[j];
        segmentAdjacency.get(a.segIndex)!.push({ 
          neighborIdx: b.segIndex, 
          viaStart: a.isStart, 
          neighborViaStart: b.isStart 
        });
        segmentAdjacency.get(b.segIndex)!.push({ 
          neighborIdx: a.segIndex, 
          viaStart: b.isStart, 
          neighborViaStart: a.isStart 
        });
      }
    }
  });

  // Step 3: Build chains by following colinear adjacency
  const used = new Set<number>();
  const chains: WallChain[] = [];
  let chainId = 0;

  workingWalls.forEach((_, startIdx) => {
    if (used.has(startIdx)) return;
    
    const startAngle = calculateNormalizedAngle(workingWalls[startIdx]);
    const chain: number[] = [startIdx];
    used.add(startIdx);

    // Grow in both directions
    let changed = true;
    while (changed) {
      changed = false;
      
      // Try to extend from start of chain
      const firstSeg = workingWalls[chain[0]];
      const firstAngle = calculateNormalizedAngle(firstSeg);
      const neighbors = segmentAdjacency.get(chain[0]) || [];
      
      for (const neighbor of neighbors) {
        if (used.has(neighbor.neighborIdx)) continue;
        const neighborSeg = workingWalls[neighbor.neighborIdx];
        const neighborAngle = calculateNormalizedAngle(neighborSeg);
        
        // Check if colinear
        if (anglesColinear(firstAngle, neighborAngle)) {
          chain.unshift(neighbor.neighborIdx);
          used.add(neighbor.neighborIdx);
          changed = true;
          break;
        }
      }
      
      // Try to extend from end of chain
      const lastSeg = workingWalls[chain[chain.length - 1]];
      const lastAngle = calculateNormalizedAngle(lastSeg);
      const endNeighbors = segmentAdjacency.get(chain[chain.length - 1]) || [];
      
      for (const neighbor of endNeighbors) {
        if (used.has(neighbor.neighborIdx)) continue;
        const neighborSeg = workingWalls[neighbor.neighborIdx];
        const neighborAngle = calculateNormalizedAngle(neighborSeg);
        
        // Check if colinear
        if (anglesColinear(lastAngle, neighborAngle)) {
          chain.push(neighbor.neighborIdx);
          used.add(neighbor.neighborIdx);
          changed = true;
          break;
        }
      }
    }

    // Build the chain object
    const chainSegments = chain.map(idx => workingWalls[idx]);
    
    // Calculate total length of chain
    const totalLength = chainSegments.reduce((sum, seg) => sum + calculateLength(seg), 0);
    
    // Find endpoints of the whole chain (the endpoints that are NOT shared with another segment in the chain)
    // For a proper chain, we need to find the actual geometric start and end
    const allPoints: { x: number; y: number; count: number }[] = [];
    chainSegments.forEach(seg => {
      const startKey = getPointKey(seg.startX, seg.startY);
      const endKey = getPointKey(seg.endX, seg.endY);
      
      let foundStart = allPoints.find(p => getPointKey(p.x, p.y) === startKey);
      if (foundStart) {
        foundStart.count++;
      } else {
        allPoints.push({ x: seg.startX, y: seg.startY, count: 1 });
      }
      
      let foundEnd = allPoints.find(p => getPointKey(p.x, p.y) === endKey);
      if (foundEnd) {
        foundEnd.count++;
      } else {
        allPoints.push({ x: seg.endX, y: seg.endY, count: 1 });
      }
    });
    
    // Chain endpoints are points that appear only once (not shared between segments in chain)
    const endpoints = allPoints.filter(p => p.count === 1);
    
    let startX = chainSegments[0].startX;
    let startY = chainSegments[0].startY;
    let endX = chainSegments[chainSegments.length - 1].endX;
    let endY = chainSegments[chainSegments.length - 1].endY;
    
    if (endpoints.length >= 2) {
      startX = endpoints[0].x;
      startY = endpoints[0].y;
      endX = endpoints[1].x;
      endY = endpoints[1].y;
    }
    
    const wallChain: WallChain = {
      id: `chain-${chainId++}`,
      segments: chainSegments,
      lengthMm: totalLength,
      angle: startAngle,
      startX,
      startY,
      endX,
      endY,
      startNodeId: null,
      endNodeId: null
    };
    
    chains.push(wallChain);
  });

  // Step 4: Build nodes from chain endpoints
  const nodeMap = new Map<string, ChainNode>();
  let nodeId = 0;
  
  chains.forEach(chain => {
    const startKey = getPointKey(chain.startX, chain.startY);
    const endKey = getPointKey(chain.endX, chain.endY);
    
    // Start node
    if (!nodeMap.has(startKey)) {
      nodeMap.set(startKey, {
        id: `node-${nodeId++}`,
        x: chain.startX,
        y: chain.startY,
        type: 'end',
        connectedChainIds: [],
        angles: []
      });
    }
    const startNode = nodeMap.get(startKey)!;
    startNode.connectedChainIds.push(chain.id);
    startNode.angles.push(Math.atan2(chain.endY - chain.startY, chain.endX - chain.startX));
    chain.startNodeId = startNode.id;
    
    // End node
    if (!nodeMap.has(endKey)) {
      nodeMap.set(endKey, {
        id: `node-${nodeId++}`,
        x: chain.endX,
        y: chain.endY,
        type: 'end',
        connectedChainIds: [],
        angles: []
      });
    }
    const endNode = nodeMap.get(endKey)!;
    endNode.connectedChainIds.push(chain.id);
    endNode.angles.push(Math.atan2(chain.startY - chain.endY, chain.startX - chain.endX)); // Reverse direction
    chain.endNodeId = endNode.id;
  });

  // Classify node types
  const nodes: ChainNode[] = [];
  nodeMap.forEach(node => {
    const connCount = node.connectedChainIds.length;
    
    if (connCount === 1) {
      node.type = 'end';
    } else if (connCount === 2) {
      // Check if the two chains are colinear (then it's not really a junction)
      const angle1 = node.angles[0];
      const angle2 = node.angles[1];
      // Angles should be opposite if it's a straight-through (diff ~= π)
      const diff = Math.abs(angle1 - angle2);
      const isColinear = Math.abs(diff - Math.PI) < ANGLE_TOL_RAD || diff < ANGLE_TOL_RAD;
      
      node.type = isColinear ? 'end' : 'L'; // If colinear, treat as pass-through, else L corner
    } else if (connCount === 3) {
      node.type = 'T';
    } else if (connCount >= 4) {
      node.type = 'X';
    }
    
    nodes.push(node);
  });

  // Calculate stats
  const totalLengthMm = chains.reduce((sum, c) => sum + c.lengthMm, 0);
  const lengths = chains.map(c => c.lengthMm);
  const minLength = lengths.length > 0 ? Math.min(...lengths) : 0;
  const maxLength = lengths.length > 0 ? Math.max(...lengths) : 0;
  const avgLength = lengths.length > 0 ? totalLengthMm / lengths.length : 0;
  
  const junctionCounts = {
    L: nodes.filter(n => n.type === 'L').length,
    T: nodes.filter(n => n.type === 'T').length,
    X: nodes.filter(n => n.type === 'X').length,
    end: nodes.filter(n => n.type === 'end').length
  };

  const reductionPercent = walls.length > 0 
    ? Math.round((1 - chains.length / walls.length) * 100) 
    : 0;
    
  // Log chain stats for debugging
  console.log('[WallChains] Stats:', {
    originalSegments: walls.length,
    afterNoiseFilter: workingWalls.length,
    chainsCount: chains.length,
    reductionPercent: reductionPercent + '%',
    totalLengthM: (totalLengthMm / 1000).toFixed(2) + 'm',
    minChainM: (minLength / 1000).toFixed(2) + 'm',
    maxChainM: (maxLength / 1000).toFixed(2) + 'm',
    avgChainM: (avgLength / 1000).toFixed(2) + 'm',
    junctions: junctionCounts
  });

  return {
    chains,
    nodes,
    stats: {
      originalSegments: walls.length,
      chainsCount: chains.length,
      reductionPercent,
      totalLengthMm,
      minChainLengthMm: minLength,
      maxChainLengthMm: maxLength,
      avgChainLengthMm: avgLength
    },
    junctionCounts
  };
}

/**
 * Calculate panels needed for a single chain
 * Returns full panels + cut info
 */
export function calculatePanelsForChain(chainLengthMm: number): {
  panelsPerFiada: number;
  hasCut: boolean;
  cutLengthMm: number;
  wasteMm: number;
} {
  const fullPanels = Math.floor(chainLengthMm / PANEL_WIDTH);
  const remainder = chainLengthMm % PANEL_WIDTH;
  
  if (remainder === 0) {
    return {
      panelsPerFiada: fullPanels,
      hasCut: false,
      cutLengthMm: 0,
      wasteMm: 0
    };
  }
  
  // Need one cut panel for the remainder
  return {
    panelsPerFiada: fullPanels + 1,
    hasCut: true,
    cutLengthMm: remainder,
    wasteMm: PANEL_WIDTH - remainder
  };
}

/**
 * Calculate BOM from chains (accurate method)
 */
export function calculateBOMFromChains(
  chainsResult: ChainsResult,
  numFiadas: number,
  rebarSpacingCm: 10 | 15 | 20,
  concreteThicknessMm: number,
  cornerMode: 'overlap_cut' | 'topo',
  gridSettings: { base: boolean; mid: boolean; top: boolean } = { base: true, mid: false, top: false }
) {
  const { chains, junctionCounts, stats } = chainsResult;
  
  // Panels calculation (per chain, per fiada)
  let totalPanelsPerFiada = 0;
  let totalCutsPerFiada = 0;
  let totalWastePerFiadaMm = 0;
  
  chains.forEach(chain => {
    const result = calculatePanelsForChain(chain.lengthMm);
    totalPanelsPerFiada += result.panelsPerFiada;
    if (result.hasCut) {
      totalCutsPerFiada++;
      totalWastePerFiadaMm += result.wasteMm;
    }
  });
  
  const panelsTotal = totalPanelsPerFiada * numFiadas;
  const cutsTotal = totalCutsPerFiada * numFiadas;
  const wasteTotal = totalWastePerFiadaMm * numFiadas;
  
  // Tarugos (base: 2 per panel)
  const tarugosBase = panelsTotal * 2;
  
  // Tarugos adjustments per fiada based on junctions
  // L: -1, T: +1, X: +2
  const adjustmentPerFiada = 
    (junctionCounts.L * -1) +
    (junctionCounts.T * 1) +
    (junctionCounts.X * 2);
  const tarugosAdjustments = adjustmentPerFiada * numFiadas;
  const tarugosTotal = tarugosBase + tarugosAdjustments;
  
  // Injection tarugos (1 per panel - configurable)
  const tarugosInjection = panelsTotal;
  
  // Webs (based on rebar spacing)
  // 20cm = 2 webs, 15cm = 3 webs, 10cm = 4 webs
  let websPerPanel: number;
  if (rebarSpacingCm <= 10) websPerPanel = 4;
  else if (rebarSpacingCm <= 15) websPerPanel = 3;
  else websPerPanel = 2;
  
  const websTotal = panelsTotal * websPerPanel;
  
  // Grids (stabilization)
  // Sold in 3m units
  const totalLengthM = stats.totalLengthMm / 1000;
  const gridsPerFiada = Math.ceil(totalLengthM / 3);
  
  // Grid rows selection
  const gridRows: number[] = [];
  if (gridSettings.base) gridRows.push(0); // First row
  if (gridSettings.mid && numFiadas > 2) {
    gridRows.push(Math.floor(numFiadas / 2)); // Middle row
  }
  if (gridSettings.top && numFiadas > 1) {
    gridRows.push(numFiadas - 1); // Last row
  }
  
  const gridsTotal = gridsPerFiada * gridRows.length;
  
  // Topos
  // T junctions: 1 topo per T on alternating rows (Type 2)
  const alternatingRows = Math.floor(numFiadas / 2);
  const toposT = junctionCounts.T * alternatingRows;
  const toposX = junctionCounts.X * alternatingRows;
  
  // Corners (if topo mode)
  const toposCorners = cornerMode === 'topo' ? junctionCounts.L * alternatingRows : 0;
  
  // Total topos (openings will be added separately when implemented)
  const toposUnits = toposT + toposX + toposCorners;
  const topoWidthM = concreteThicknessMm / 1000;
  const toposMeters = toposUnits * topoWidthM * 0.4; // 400mm = 0.4m per topo height
  
  return {
    // Panels
    panelsCount: panelsTotal,
    panelsPerFiada: totalPanelsPerFiada,
    
    // Cuts
    cutsCount: cutsTotal,
    cutsPerFiada: totalCutsPerFiada,
    wasteTotal,
    
    // Tarugos
    tarugosBase,
    tarugosAdjustments,
    tarugosTotal,
    tarugosInjection,
    
    // Webs
    websTotal,
    websPerPanel,
    
    // Grids
    gridsTotal,
    gridsPerFiada,
    gridRows,
    
    // Topos
    toposUnits,
    toposMeters,
    toposByReason: {
      tJunction: toposT,
      xJunction: toposX,
      openings: 0, // To be calculated when openings are implemented
      corners: toposCorners
    },
    
    // Summary
    numberOfRows: numFiadas,
    totalWallLength: stats.totalLengthMm,
    junctionCounts,
    chainsCount: stats.chainsCount
  };
}
