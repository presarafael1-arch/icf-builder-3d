/**
 * Footprint Detection Module
 * 
 * Detects building footprint (outer polygon) from wall segments/chains
 * and classifies which side of each chain is exterior vs interior.
 * 
 * Algorithm:
 * 1. Build a graph from chain endpoints
 * 2. Find closed loops (polygons) by walking the graph
 * 3. Identify the outer polygon (largest area, CCW winding)
 * 4. For each chain, sample points on left/right side and use point-in-polygon
 *    to determine which side faces outside (EXT) vs inside (INT)
 */

import { WallChain } from './wall-chains';

// Side classification result for a chain
export type SideClassification = 
  | 'LEFT_EXT'      // Left side is exterior, right is interior
  | 'RIGHT_EXT'     // Right side is exterior, left is interior  
  | 'BOTH_INT'      // Interior partition wall (both sides inside building)
  | 'OUTSIDE'       // Chain is entirely outside the footprint (e.g., external feature, fence)
  | 'UNRESOLVED';   // Cannot determine (open geometry or error)

// Footprint detection status
export type FootprintStatus = 'OK' | 'UNRESOLVED' | 'NO_WALLS';

export interface ChainSideInfo {
  chainId: string;
  classification: SideClassification;
  // Whether the positive perpendicular direction points outside (true) or inside (false)
  // This is the "outsideIsLeft" equivalent - but expressed as "outsideIsRight" (positive perp)
  outsideIsPositivePerp: boolean;
  // The outward normal direction (pointing to exterior)
  // null if classification is BOTH_INT or UNRESOLVED
  outwardNormalAngle: number | null;
  // Debug info
  leftInside: boolean;
  rightInside: boolean;
  // Segment-level stats for debug
  segmentStats?: {
    totalSegments: number;
    leftExtCount: number;
    rightExtCount: number;
    bothIntCount: number;
    unresolvedCount: number;
    unresolvedReason?: string; // Reason for UNRESOLVED classification (e.g., 'BOTH_OUTSIDE', 'ZERO_LENGTH', 'NO_POLYGON')
  };
}

export interface FootprintResult {
  // Detection status
  status: FootprintStatus;
  // The outer polygon vertices (CCW order)
  outerPolygon: Array<{ x: number; y: number }>;
  // Area of outer polygon (mm²)
  outerArea: number;
  // Number of closed loops found
  loopsFound: number;
  // Classification for each chain
  chainSides: Map<string, ChainSideInfo>;
  // Any interior loops (holes) detected
  interiorLoops: Array<Array<{ x: number; y: number }>>;
  // Debug stats
  stats: {
    totalChains: number;
    exteriorChains: number;
    interiorPartitions: number;
    outsideFeatures: number; // Chains entirely outside footprint
    unresolved: number;
  };
  // Unresolved chain IDs for diagnostic display (real errors)
  unresolvedChainIds: string[];
  // Outside chain IDs (not errors, just outside footprint)
  outsideChainIds: string[];
}

// ============= Point-in-Polygon Algorithm =============

/**
 * Calculate minimum distance from a point to a line segment
 */
function pointToSegmentDistance(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  
  if (lenSq < 0.0001) {
    // Degenerate segment (point)
    return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  }
  
  // Project point onto line, clamped to segment
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

/**
 * Calculate minimum distance from a point to the polygon boundary
 */
function distanceToPolygonBoundary(
  px: number, py: number,
  polygon: Array<{ x: number; y: number }>
): number {
  if (polygon.length < 2) return Infinity;
  
  let minDist = Infinity;
  const n = polygon.length;
  
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dist = pointToSegmentDistance(
      px, py,
      polygon[i].x, polygon[i].y,
      polygon[j].x, polygon[j].y
    );
    if (dist < minDist) minDist = dist;
  }
  
  return minDist;
}

/**
 * Check if a point is on the polygon boundary (within tolerance)
 */
function isOnPolygonEdge(
  px: number, py: number,
  polygon: Array<{ x: number; y: number }>,
  tolerance: number = 1.0 // mm
): boolean {
  return distanceToPolygonBoundary(px, py, polygon) < tolerance;
}

/**
 * Ray casting algorithm to test if a point is inside a polygon.
 * Returns true if point (px, py) is inside the polygon.
 */
export function pointInPolygon(
  px: number, 
  py: number, 
  polygon: Array<{ x: number; y: number }>
): boolean {
  if (polygon.length < 3) return false;
  
  let inside = false;
  const n = polygon.length;
  
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    
    // Check if ray from point going right crosses this edge
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  
  return inside;
}

/**
 * Robust point-in-polygon test with on-edge handling
 * Returns: 'inside' | 'outside' | 'on_edge'
 */
function robustPointInPolygon(
  px: number, py: number,
  polygon: Array<{ x: number; y: number }>,
  edgeTolerance: number = 1.0 // mm
): 'inside' | 'outside' | 'on_edge' {
  if (isOnPolygonEdge(px, py, polygon, edgeTolerance)) {
    return 'on_edge';
  }
  return pointInPolygon(px, py, polygon) ? 'inside' : 'outside';
}

/**
 * Calculate signed area of a polygon.
 * Positive = CCW winding (standard exterior)
 * Negative = CW winding (hole or inverted)
 */
function signedPolygonArea(polygon: Array<{ x: number; y: number }>): number {
  if (polygon.length < 3) return 0;
  
  let area = 0;
  const n = polygon.length;
  
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += polygon[i].x * polygon[j].y;
    area -= polygon[j].x * polygon[i].y;
  }
  
  return area / 2;
}

// ============= Graph Building for Loop Detection =============

interface GraphNode {
  x: number;
  y: number;
  key: string;
  edges: Array<{ toKey: string; chainId: string; angle: number }>;
}

/**
 * Build a graph from chain endpoints for loop detection.
 * Nodes are unique coordinate positions, edges are chains connecting them.
 */
function buildGraph(chains: WallChain[], tolerance: number = 50): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>();
  
  // Helper to get or create node key
  const getNodeKey = (x: number, y: number): string => {
    const rx = Math.round(x / tolerance) * tolerance;
    const ry = Math.round(y / tolerance) * tolerance;
    return `${rx},${ry}`;
  };
  
  // Helper to get or create node
  const getNode = (x: number, y: number): GraphNode => {
    const key = getNodeKey(x, y);
    if (!nodes.has(key)) {
      const rx = Math.round(x / tolerance) * tolerance;
      const ry = Math.round(y / tolerance) * tolerance;
      nodes.set(key, { x: rx, y: ry, key, edges: [] });
    }
    return nodes.get(key)!;
  };
  
  // Add edges for each chain
  chains.forEach(chain => {
    const startNode = getNode(chain.startX, chain.startY);
    const endNode = getNode(chain.endX, chain.endY);
    
    if (startNode.key === endNode.key) return; // Skip degenerate chains
    
    // Angle from start to end
    const angle = Math.atan2(chain.endY - chain.startY, chain.endX - chain.startX);
    
    // Add bidirectional edges
    startNode.edges.push({ toKey: endNode.key, chainId: chain.id, angle });
    endNode.edges.push({ toKey: startNode.key, chainId: chain.id, angle: angle + Math.PI });
  });
  
  return nodes;
}

/**
 * Find closed loops in the graph using a modified DFS.
 * Returns all polygons found, ordered by area (largest first).
 */
function findClosedLoops(
  graph: Map<string, GraphNode>,
  chains: WallChain[]
): Array<Array<{ x: number; y: number }>> {
  const loops: Array<Array<{ x: number; y: number }>> = [];
  const usedEdges = new Set<string>(); // "fromKey->toKey:chainId"
  
  // Sort edges at each node by angle (for consistent winding)
  graph.forEach(node => {
    node.edges.sort((a, b) => a.angle - b.angle);
  });
  
  // For each starting edge, try to find a loop
  graph.forEach((startNode) => {
    startNode.edges.forEach((startEdge, startEdgeIdx) => {
      const edgeKey = `${startNode.key}->${startEdge.toKey}:${startEdge.chainId}`;
      if (usedEdges.has(edgeKey)) return;
      
      // Try to walk a loop using "left-hand rule" (always turn left)
      const path: Array<{ x: number; y: number }> = [{ x: startNode.x, y: startNode.y }];
      const pathEdges: string[] = [edgeKey];
      
      let currentNode = startNode;
      let currentEdge = startEdge;
      let iterations = 0;
      const maxIterations = chains.length * 2 + 10;
      
      while (iterations < maxIterations) {
        iterations++;
        
        const nextNode = graph.get(currentEdge.toKey);
        if (!nextNode) break;
        
        path.push({ x: nextNode.x, y: nextNode.y });
        
        // Check if we've closed the loop
        if (nextNode.key === startNode.key && pathEdges.length >= 3) {
          // Found a closed loop!
          loops.push([...path.slice(0, -1)]); // Remove duplicate end point
          pathEdges.forEach(e => usedEdges.add(e));
          break;
        }
        
        // Find the next edge (turn left = next CCW edge after incoming edge)
        const incomingAngle = currentEdge.angle + Math.PI; // Reverse direction
        const normalizedIncoming = ((incomingAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        
        // Find edge with smallest CCW angle from incoming
        let bestEdge: typeof currentEdge | null = null;
        let bestAngleDiff = Infinity;
        
        for (const edge of nextNode.edges) {
          if (edge.toKey === currentNode.key && edge.chainId === currentEdge.chainId) continue; // Skip going back
          
          const edgeAngle = ((edge.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          let angleDiff = edgeAngle - normalizedIncoming;
          if (angleDiff < 0) angleDiff += 2 * Math.PI;
          if (angleDiff < 0.01) angleDiff += 2 * Math.PI; // Avoid going straight back
          
          if (angleDiff < bestAngleDiff) {
            bestAngleDiff = angleDiff;
            bestEdge = edge;
          }
        }
        
        if (!bestEdge) break;
        
        const nextEdgeKey = `${nextNode.key}->${bestEdge.toKey}:${bestEdge.chainId}`;
        if (pathEdges.includes(nextEdgeKey)) break; // Already visited this edge in this path
        
        pathEdges.push(nextEdgeKey);
        currentNode = nextNode;
        currentEdge = bestEdge;
      }
    });
  });
  
  // Sort loops by absolute area (largest first)
  loops.sort((a, b) => Math.abs(signedPolygonArea(b)) - Math.abs(signedPolygonArea(a)));
  
  return loops;
}

// ============= Main Classification Function =============

/**
 * Detect building footprint and classify each chain's exterior/interior sides.
 * 
 * @param chains - Wall chains from the DXF
 * @param tolerance - Coordinate snapping tolerance (mm)
 * @returns FootprintResult with classifications
 */
export function detectFootprintAndClassify(
  chains: WallChain[],
  tolerance: number = 100
): FootprintResult {
  if (chains.length === 0) {
    return {
      status: 'NO_WALLS',
      outerPolygon: [],
      outerArea: 0,
      loopsFound: 0,
      chainSides: new Map(),
      interiorLoops: [],
      stats: { totalChains: 0, exteriorChains: 0, interiorPartitions: 0, outsideFeatures: 0, unresolved: 0 },
      unresolvedChainIds: [],
      outsideChainIds: [],
    };
  }
  
  // Step 1: Build graph and find loops
  const graph = buildGraph(chains, tolerance);
  const loops = findClosedLoops(graph, chains);
  
  console.log('[FootprintDetection] Found', loops.length, 'closed loops');
  
  // Step 2: Identify outer polygon (largest area with CCW winding)
  let outerPolygon: Array<{ x: number; y: number }> = [];
  let outerArea = 0;
  const interiorLoops: Array<Array<{ x: number; y: number }>> = [];
  let usedFallback = false;
  
  for (const loop of loops) {
    const area = signedPolygonArea(loop);
    const absArea = Math.abs(area);
    
    if (absArea > outerArea) {
      if (outerPolygon.length > 0) {
        interiorLoops.push(outerPolygon); // Demote previous outer to interior
      }
      outerPolygon = area > 0 ? loop : [...loop].reverse(); // Ensure CCW
      outerArea = absArea;
    } else if (loop.length >= 3) {
      interiorLoops.push(loop);
    }
  }
  
  // If no closed loops found, try to create a bounding polygon from chain extents
  if (outerPolygon.length < 3) {
    console.log('[FootprintDetection] No closed loops, using convex hull fallback');
    outerPolygon = createBoundingPolygon(chains);
    outerArea = Math.abs(signedPolygonArea(outerPolygon));
    usedFallback = true;
  }
  
  console.log('[FootprintDetection] Outer polygon:', outerPolygon.length, 'vertices, area:', (outerArea / 1e6).toFixed(2), 'm²');
  
  // Step 3: Classify each chain using ADAPTIVE EPS and MAJORITY VOTING
  // This is critical for centerlines where points may fall on the polygon boundary
  const chainSides = new Map<string, ChainSideInfo>();
  let exteriorChains = 0;
  let interiorPartitions = 0;
  let outsideFeatures = 0;
  let unresolved = 0;
  const unresolvedChainIds: string[] = [];
  const outsideChainIds: string[] = [];
  
  // Adaptive eps values - try multiple distances to escape boundary ambiguity
  const EPS_LIST = [50, 150, 300, 500]; // mm - increasing offset distances
  const EDGE_TOLERANCE = 5; // mm - tolerance for on-edge detection
  
  /**
   * Test a single point with adaptive eps to determine inside/outside
   * Returns: { result: 'inside' | 'outside' | 'ambiguous', usedEps: number }
   */
  const testPointAdaptive = (
    baseX: number, baseY: number,
    perpX: number, perpY: number,
    sign: 1 | -1 // +1 for positive perp, -1 for negative perp
  ): { result: 'inside' | 'outside' | 'ambiguous'; usedEps: number } => {
    for (const eps of EPS_LIST) {
      const testX = baseX + perpX * eps * sign;
      const testY = baseY + perpY * eps * sign;
      
      const pointResult = robustPointInPolygon(testX, testY, outerPolygon, EDGE_TOLERANCE);
      
      if (pointResult === 'on_edge') {
        // Try larger eps
        continue;
      }
      
      return {
        result: pointResult === 'inside' ? 'inside' : 'outside',
        usedEps: eps,
      };
    }
    
    // All eps values resulted in on_edge - truly ambiguous
    return { result: 'ambiguous', usedEps: 0 };
  };
  
  /**
   * Classify a chain segment using adaptive eps
   * Returns classification vote and debug info
   */
  const classifySegment = (
    midX: number, midY: number,
    perpX: number, perpY: number
  ): { vote: 'RIGHT_EXT' | 'LEFT_EXT' | 'BOTH_INT' | 'AMBIGUOUS' | 'BOTH_OUTSIDE'; usedEps: number } => {
    const plusResult = testPointAdaptive(midX, midY, perpX, perpY, 1);
    const minusResult = testPointAdaptive(midX, midY, perpX, perpY, -1);
    
    const plusInside = plusResult.result === 'inside';
    const minusInside = minusResult.result === 'inside';
    const plusAmbiguous = plusResult.result === 'ambiguous';
    const minusAmbiguous = minusResult.result === 'ambiguous';
    
    // Use max eps used for debug
    const usedEps = Math.max(plusResult.usedEps, minusResult.usedEps);
    
    // If either side is ambiguous, mark as ambiguous
    if (plusAmbiguous || minusAmbiguous) {
      return { vote: 'AMBIGUOUS', usedEps };
    }
    
    // Determine classification based on inside/outside
    if (minusInside && !plusInside) {
      // Minus (left) is inside, Plus (right) is outside => RIGHT_EXT
      return { vote: 'RIGHT_EXT', usedEps };
    } else if (!minusInside && plusInside) {
      // Plus (right) is inside, Minus (left) is outside => LEFT_EXT
      return { vote: 'LEFT_EXT', usedEps };
    } else if (plusInside && minusInside) {
      // Both inside => PARTITION
      return { vote: 'BOTH_INT', usedEps };
    } else {
      // Both outside => edge case (wall outside footprint)
      return { vote: 'BOTH_OUTSIDE', usedEps };
    }
  };
  
  chains.forEach(chain => {
    // Get chain direction and perpendicular
    const dx = chain.endX - chain.startX;
    const dy = chain.endY - chain.startY;
    const len = Math.sqrt(dx * dx + dy * dy);
    
    if (len < 1) {
      chainSides.set(chain.id, {
        chainId: chain.id,
        classification: 'UNRESOLVED',
        outsideIsPositivePerp: true,
        outwardNormalAngle: null,
        leftInside: false,
        rightInside: false,
        segmentStats: {
          totalSegments: 0,
          leftExtCount: 0,
          rightExtCount: 0,
          bothIntCount: 0,
          unresolvedCount: 1,
          unresolvedReason: 'ZERO_LENGTH',
        },
      });
      unresolved++;
      unresolvedChainIds.push(chain.id);
      return;
    }
    
    const dirX = dx / len;
    const dirY = dy / len;
    
    // "Positive perpendicular" = 90° CW from direction = (dirY, -dirX)
    // This matches the panel placement convention exactly
    const perpX = dirY;
    const perpY = -dirX;
    
    // Sample multiple points along the chain for majority voting
    // Use up to 5 sample points distributed along the chain
    const numSamples = Math.min(5, Math.max(1, Math.floor(len / 500))); // One sample per 500mm, min 1, max 5
    const samplePoints: Array<{ x: number; y: number }> = [];
    
    for (let i = 0; i < numSamples; i++) {
      const t = numSamples === 1 ? 0.5 : i / (numSamples - 1);
      // Clamp t to avoid exact endpoints (which may be at intersections)
      const tClamped = Math.max(0.1, Math.min(0.9, t));
      samplePoints.push({
        x: chain.startX + dx * tClamped,
        y: chain.startY + dy * tClamped,
      });
    }
    
    // Classify each sample point
    let rightExtVotes = 0;
    let leftExtVotes = 0;
    let bothIntVotes = 0;
    let ambiguousVotes = 0;
    let bothOutsideVotes = 0;
    let maxUsedEps = 0;
    
    for (const pt of samplePoints) {
      const result = classifySegment(pt.x, pt.y, perpX, perpY);
      maxUsedEps = Math.max(maxUsedEps, result.usedEps);
      
      switch (result.vote) {
        case 'RIGHT_EXT': rightExtVotes++; break;
        case 'LEFT_EXT': leftExtVotes++; break;
        case 'BOTH_INT': bothIntVotes++; break;
        case 'AMBIGUOUS': ambiguousVotes++; break;
        case 'BOTH_OUTSIDE': bothOutsideVotes++; break;
      }
    }
    
    // Determine final classification by majority vote
    const totalVotes = samplePoints.length;
    const majorityThreshold = Math.ceil(totalVotes / 2);
    
    let classification: SideClassification;
    let outsideIsPositivePerp = true;
    let outwardNormalAngle: number | null = null;
    let unresolvedReason: string | undefined;
    
    // Check for majority
    if (rightExtVotes >= majorityThreshold) {
      classification = 'RIGHT_EXT';
      outsideIsPositivePerp = true;
      outwardNormalAngle = Math.atan2(-dirX, dirY);
      exteriorChains++;
    } else if (leftExtVotes >= majorityThreshold) {
      classification = 'LEFT_EXT';
      outsideIsPositivePerp = false;
      outwardNormalAngle = Math.atan2(dirX, -dirY);
      exteriorChains++;
    } else if (bothIntVotes >= majorityThreshold) {
      classification = 'BOTH_INT';
      outsideIsPositivePerp = true; // Arbitrary for partitions
      interiorPartitions++;
    } else if (bothOutsideVotes >= majorityThreshold) {
      // Chain is entirely outside footprint - NOT an error, just an external feature
      classification = 'OUTSIDE';
      unresolvedReason = 'BOTH_OUTSIDE';
      outsideFeatures++;
      outsideChainIds.push(chain.id);
    } else if (ambiguousVotes >= majorityThreshold) {
      classification = 'UNRESOLVED';
      unresolvedReason = 'BOUNDARY_AMBIGUOUS';
      unresolved++;
      unresolvedChainIds.push(chain.id);
    } else {
      // No clear majority - use the highest vote count, preferring perimeter over partition
      const perimeterVotes = rightExtVotes + leftExtVotes;
      if (perimeterVotes > bothIntVotes && perimeterVotes > ambiguousVotes + bothOutsideVotes) {
        // Perimeter wins - pick the side with more votes
        if (rightExtVotes >= leftExtVotes) {
          classification = 'RIGHT_EXT';
          outsideIsPositivePerp = true;
          outwardNormalAngle = Math.atan2(-dirX, dirY);
        } else {
          classification = 'LEFT_EXT';
          outsideIsPositivePerp = false;
          outwardNormalAngle = Math.atan2(dirX, -dirY);
        }
        exteriorChains++;
      } else if (bothIntVotes > 0) {
        classification = 'BOTH_INT';
        outsideIsPositivePerp = true;
        interiorPartitions++;
      } else {
        // Truly unresolved - mixed results
        classification = 'UNRESOLVED';
        unresolvedReason = 'MIXED_VOTES';
        unresolved++;
        unresolvedChainIds.push(chain.id);
      }
    }
    
    // Use midpoint for legacy left/right inside booleans
    const midX = (chain.startX + chain.endX) / 2;
    const midY = (chain.startY + chain.endY) / 2;
    const leftInside = pointInPolygon(midX - perpX * 150, midY - perpY * 150, outerPolygon);
    const rightInside = pointInPolygon(midX + perpX * 150, midY + perpY * 150, outerPolygon);
    
    chainSides.set(chain.id, {
      chainId: chain.id,
      classification,
      outsideIsPositivePerp,
      outwardNormalAngle,
      leftInside,
      rightInside,
      segmentStats: {
        totalSegments: numSamples,
        leftExtCount: leftExtVotes,
        rightExtCount: rightExtVotes,
        bothIntCount: bothIntVotes,
        unresolvedCount: ambiguousVotes + bothOutsideVotes,
        unresolvedReason,
      },
    });
  });
  
  // Step 4: Per-chain consistency check for PERIMETER chains
  // Verify that the side marked as "exterior" actually falls OUTSIDE the footprint
  // This catches any edge cases where the majority vote still got it wrong
  if (outerPolygon.length >= 3) {
    chainSides.forEach((sideInfo, chainId) => {
      // Only check perimeter chains (LEFT_EXT or RIGHT_EXT)
      if (sideInfo.classification !== 'LEFT_EXT' && sideInfo.classification !== 'RIGHT_EXT') {
        return;
      }
      
      const chain = chains.find(c => c.id === chainId);
      if (!chain) return;
      
      // Calculate using the same perpendicular convention as panel placement
      const dx = chain.endX - chain.startX;
      const dy = chain.endY - chain.startY;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1) return;
      
      const dirX = dx / len;
      const dirY = dy / len;
      
      // "Positive perpendicular" = 90° CW from direction = (dirY, -dirX)
      const perpX = dirY;
      const perpY = -dirX;
      
      // Get midpoint
      const midX = (chain.startX + chain.endX) / 2;
      const midY = (chain.startY + chain.endY) / 2;
      
      // Test point on the "exterior" side with adaptive eps
      const testResult = testPointAdaptive(
        midX, midY, perpX, perpY,
        sideInfo.outsideIsPositivePerp ? 1 : -1
      );
      
      // If the "exterior" test point is INSIDE the footprint, our classification is inverted
      if (testResult.result === 'inside') {
        console.log(`[FootprintDetection] Consistency check: Chain ${chainId} has inverted EXT/INT - correcting (eps=${testResult.usedEps}mm)`);
        
        sideInfo.outsideIsPositivePerp = !sideInfo.outsideIsPositivePerp;
        
        // Also update the classification label for clarity
        if (sideInfo.classification === 'LEFT_EXT') {
          sideInfo.classification = 'RIGHT_EXT';
        } else if (sideInfo.classification === 'RIGHT_EXT') {
          sideInfo.classification = 'LEFT_EXT';
        }
        
        // Update outward normal angle
        if (sideInfo.outsideIsPositivePerp) {
          sideInfo.outwardNormalAngle = Math.atan2(-dirX, dirY);
        } else {
          sideInfo.outwardNormalAngle = Math.atan2(dirX, -dirY);
        }
      }
    });
  }
  
  console.log('[FootprintDetection] Classification:', {
    exterior: exteriorChains,
    interior: interiorPartitions,
    outside: outsideFeatures,
    unresolved,
  });
  
  // Determine overall status - OUTSIDE chains are NOT errors, so don't count them
  const status: FootprintStatus = 
    (outerPolygon.length >= 3 && !usedFallback) ? 'OK' : 
    (usedFallback && outerPolygon.length >= 3) ? 'OK' :
    'UNRESOLVED';
  
  return {
    status,
    outerPolygon,
    outerArea,
    loopsFound: loops.length,
    chainSides,
    interiorLoops,
    stats: {
      totalChains: chains.length,
      exteriorChains,
      interiorPartitions,
      outsideFeatures,
      unresolved,
    },
    unresolvedChainIds,
    outsideChainIds,
  };
}

/**
 * Create a bounding polygon from chain endpoints when no closed loops exist.
 * Uses convex hull algorithm for robustness.
 */
function createBoundingPolygon(chains: WallChain[]): Array<{ x: number; y: number }> {
  // Collect all unique endpoints
  const points: Array<{ x: number; y: number }> = [];
  const seen = new Set<string>();
  
  chains.forEach(chain => {
    const startKey = `${Math.round(chain.startX)},${Math.round(chain.startY)}`;
    const endKey = `${Math.round(chain.endX)},${Math.round(chain.endY)}`;
    
    if (!seen.has(startKey)) {
      seen.add(startKey);
      points.push({ x: chain.startX, y: chain.startY });
    }
    if (!seen.has(endKey)) {
      seen.add(endKey);
      points.push({ x: chain.endX, y: chain.endY });
    }
  });
  
  if (points.length < 3) return points;
  
  // Compute convex hull using Graham scan
  return convexHull(points);
}

/**
 * Graham scan convex hull algorithm
 */
function convexHull(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (points.length < 3) return [...points];
  
  // Find the point with lowest y (and leftmost if tie)
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].y < points[start].y || 
        (points[i].y === points[start].y && points[i].x < points[start].x)) {
      start = i;
    }
  }
  
  const startPoint = points[start];
  
  // Sort points by polar angle with respect to start point
  const sorted = points
    .filter((_, i) => i !== start)
    .map(p => ({
      point: p,
      angle: Math.atan2(p.y - startPoint.y, p.x - startPoint.x),
      dist: Math.sqrt((p.x - startPoint.x) ** 2 + (p.y - startPoint.y) ** 2),
    }))
    .sort((a, b) => a.angle - b.angle || a.dist - b.dist)
    .map(p => p.point);
  
  // Build hull
  const hull: Array<{ x: number; y: number }> = [startPoint];
  
  for (const p of sorted) {
    // Remove points that make clockwise turn
    while (hull.length > 1) {
      const top = hull[hull.length - 1];
      const second = hull[hull.length - 2];
      const cross = (top.x - second.x) * (p.y - second.y) - (top.y - second.y) * (p.x - second.x);
      if (cross <= 0) {
        hull.pop();
      } else {
        break;
      }
    }
    hull.push(p);
  }
  
  return hull;
}

// ============= Helper to determine panel side from chain classification =============

/**
 * Given a chain's side classification and the panel's perpendicular offset direction,
 * determine if the panel is on the exterior or interior side.
 * 
 * @param classification - The chain's side classification
 * @param isPositiveOffset - True if panel is on the positive perpendicular side (right when looking along chain)
 * @returns 'exterior' or 'interior'
 */
export function getPanelSideFromClassification(
  classification: SideClassification,
  isPositiveOffset: boolean
): 'exterior' | 'interior' {
  switch (classification) {
    case 'RIGHT_EXT':
      // Right side is exterior
      return isPositiveOffset ? 'exterior' : 'interior';
    case 'LEFT_EXT':
      // Left side is exterior
      return isPositiveOffset ? 'interior' : 'exterior';
    case 'BOTH_INT':
      // Both sides are interior (partition wall)
      return 'interior';
    case 'OUTSIDE':
      // Outside features - treat as interior (neutral) for rendering
      return 'interior';
    case 'UNRESOLVED':
    default:
      // Default to positive = exterior (legacy behavior)
      return isPositiveOffset ? 'exterior' : 'interior';
  }
}
