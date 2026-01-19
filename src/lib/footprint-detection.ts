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
  | 'UNRESOLVED';   // Cannot determine (open geometry or error)

// Footprint detection status
export type FootprintStatus = 'OK' | 'UNRESOLVED' | 'NO_WALLS';

export interface ChainSideInfo {
  chainId: string;
  classification: SideClassification;
  // Whether the positive perpendicular direction points outside (true) or inside (false)
  // Positive perp direction is (-dirY, dirX) which matches panel-layout.ts convention
  outsideIsPositivePerp: boolean;
  // The outward normal direction (pointing to exterior)
  // null if classification is BOTH_INT or UNRESOLVED
  outwardNormalAngle: number | null;
  // Debug info: which sides are inside the footprint polygon
  leftInside: boolean;  // Left = negative perpendicular direction
  rightInside: boolean; // Right = positive perpendicular direction
  // Reason for UNRESOLVED classification (for diagnostics)
  unresolvedReason?: 'BOTH_OUTSIDE' | 'ZERO_LENGTH' | 'NO_POLYGON';
  // Segment-level stats for debug
  segmentStats?: {
    totalSegments: number;
    leftExtCount: number;
    rightExtCount: number;
    bothIntCount: number;
    unresolvedCount: number;
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
    unresolved: number;
  };
  // Unresolved chain IDs for diagnostic display
  unresolvedChainIds: string[];
}

// ============= Point-in-Polygon Algorithm =============

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
      stats: { totalChains: 0, exteriorChains: 0, interiorPartitions: 0, unresolved: 0 },
      unresolvedChainIds: [],
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
  
  // Step 3: Classify each chain using SAME perpendicular convention as panel-layout
  // panel-layout uses: perpX = -dirY, perpZ = dirX (90° CW from direction)
  // This is what we call "positive perpendicular" direction
  const chainSides = new Map<string, ChainSideInfo>();
  let exteriorChains = 0;
  let interiorPartitions = 0;
  let unresolved = 0;
  const unresolvedChainIds: string[] = [];
  
  const EPS = 150; // Offset distance for point sampling (mm)
  
  chains.forEach(chain => {
    // Get chain midpoint
    const midX = (chain.startX + chain.endX) / 2;
    const midY = (chain.startY + chain.endY) / 2;
    
    // Get chain direction and perpendicular (normal)
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
        unresolvedReason: 'ZERO_LENGTH',
      });
      unresolved++;
      unresolvedChainIds.push(chain.id);
      return;
    }
    
    // Check if we have a valid outer polygon
    if (outerPolygon.length < 3) {
      chainSides.set(chain.id, {
        chainId: chain.id,
        classification: 'UNRESOLVED',
        outsideIsPositivePerp: true,
        outwardNormalAngle: null,
        leftInside: false,
        rightInside: false,
        unresolvedReason: 'NO_POLYGON',
      });
      unresolved++;
      unresolvedChainIds.push(chain.id);
      return;
    }
    
    const dirX = dx / len;
    const dirY = dy / len;
    
    // CRITICAL: Use SAME perpendicular convention as panel-layout.ts
    // panel-layout uses: perpX = -dirY, perpZ = dirX (which is 90° CCW from direction in XZ plane)
    // In 2D (XY plane): positive perp = (-dirY, dirX)
    // This matches panel-layout's "positive perpendicular" direction
    const positivePerpX = -dirY;
    const positivePerpY = dirX;
    
    // Test point on positive perpendicular side (where panel-layout places "positive side" panels)
    const posSideX = midX + positivePerpX * EPS;
    const posSideY = midY + positivePerpY * EPS;
    
    // Test point on negative perpendicular side
    const negSideX = midX - positivePerpX * EPS;
    const negSideY = midY - positivePerpY * EPS;
    
    // Test both sides against outer polygon
    const positiveSideInside = pointInPolygon(posSideX, posSideY, outerPolygon);
    const negativeSideInside = pointInPolygon(negSideX, negSideY, outerPolygon);
    
    let classification: SideClassification;
    let outwardNormalAngle: number | null = null;
    let outsideIsPositivePerp = true; // Default: positive perp is outside
    let unresolvedReason: ChainSideInfo['unresolvedReason'] = undefined;
    
    if (positiveSideInside && !negativeSideInside) {
      // Positive side is inside, negative side is outside => negative side is EXT
      // So positive perpendicular points INTERIOR, NOT exterior
      classification = 'LEFT_EXT'; // Negative perp (left) is exterior
      outwardNormalAngle = Math.atan2(-positivePerpY, -positivePerpX);
      outsideIsPositivePerp = false; // Exterior is NEGATIVE perpendicular
      exteriorChains++;
    } else if (!positiveSideInside && negativeSideInside) {
      // Positive side is outside, negative side is inside => positive side is EXT
      classification = 'RIGHT_EXT'; // Positive perp (right) is exterior
      outwardNormalAngle = Math.atan2(positivePerpY, positivePerpX);
      outsideIsPositivePerp = true; // Exterior is POSITIVE perpendicular
      exteriorChains++;
    } else if (positiveSideInside && negativeSideInside) {
      // Both inside => interior partition wall
      classification = 'BOTH_INT';
      outsideIsPositivePerp = true; // Arbitrary for partitions
      interiorPartitions++;
    } else {
      // Both outside => unresolved (wall outside footprint?)
      classification = 'UNRESOLVED';
      unresolvedReason = 'BOTH_OUTSIDE';
      unresolved++;
      unresolvedChainIds.push(chain.id);
    }
    
    // Store debug info with consistent naming
    // leftInside/rightInside now maps to negativeSideInside/positiveSideInside
    chainSides.set(chain.id, {
      chainId: chain.id,
      classification,
      outsideIsPositivePerp,
      outwardNormalAngle,
      leftInside: negativeSideInside,  // "left" = negative perp direction
      rightInside: positiveSideInside, // "right" = positive perp direction
      unresolvedReason,
    });
  });
  
  console.log('[FootprintDetection] Classification:', {
    exterior: exteriorChains,
    interior: interiorPartitions,
    unresolved,
  });
  
  // Determine overall status
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
      unresolved,
    },
    unresolvedChainIds,
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
    case 'UNRESOLVED':
    default:
      // Default to positive = exterior (legacy behavior)
      return isPositiveOffset ? 'exterior' : 'interior';
  }
}
