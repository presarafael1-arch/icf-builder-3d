/**
 * Footprint Detection Module
 * 
 * Detects building footprint (outer polygon) from wall segments/chains
 * and classifies which side of each chain is exterior vs interior.
 * 
 * Algorithm (Face-Walking for T-junctions):
 * 1. Build a planar graph from chain endpoints with half-edges
 * 2. For each node, sort edges by angle for consistent traversal
 * 3. Walk faces using right-hand rule (planar graph face extraction)
 * 4. Identify the outer polygon (largest area containing most other loops)
 * 5. For each chain, sample points on left/right side and use point-in-polygon
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
  // This is the "outsideIsLeft" equivalent - but expressed as "outsideIsRight" (positive perp)
  outsideIsPositivePerp: boolean;
  // The outward normal direction (pointing to exterior)
  // null if classification is BOTH_INT or UNRESOLVED
  outwardNormalAngle: number | null;
  // Debug info
  leftInside: boolean;
  rightInside: boolean;
  // Flag: true if chain is entirely outside the building footprint (not an error, just metadata)
  isOutsideFootprint: boolean;
  // Reason for being outside footprint (if applicable)
  outsideReason?: string;
  // Segment-level stats for debug
  segmentStats?: {
    totalSegments: number;
    leftExtCount: number;
    rightExtCount: number;
    bothIntCount: number;
    unresolvedCount: number;
    unresolvedReason?: string; // Reason for UNRESOLVED classification (e.g., 'ZERO_LENGTH', 'NO_POLYGON')
  };
}

// Face/loop metadata for debugging
export interface FaceMeta {
  id: string;
  points: Array<{ x: number; y: number }>;
  area: number;           // Signed area (positive = CCW)
  absArea: number;
  orientation: 'CCW' | 'CW';
  centroid: { x: number; y: number };
  containsCount: number;  // How many other face centroids this face contains
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
  // All detected faces for debug
  facesFound: FaceMeta[];
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
    outsideFootprint: number; // Chains outside the building footprint (not errors)
  };
  // Unresolved chain IDs for diagnostic display (true errors only: ZERO_LENGTH, NO_POLYGON, etc.)
  unresolvedChainIds: string[];
  // Chain IDs that are outside the building footprint (not errors, just metadata)
  outsideChainIds: string[];
  // Chain IDs that are internal partitions
  partitionChainIds: string[];
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

// ============= Half-Edge Face-Walking Algorithm (handles T-junctions) =============

interface HalfEdge {
  id: string;
  fromKey: string;
  toKey: string;
  chainId: string;
  angle: number;      // Angle of direction from -> to
  twin?: string;      // ID of twin half-edge (opposite direction)
  next?: string;      // Next half-edge in face traversal
  visited: boolean;
}

interface GraphNode {
  x: number;
  y: number;
  key: string;
  halfEdges: string[]; // Half-edge IDs originating from this node
}

/**
 * Build a planar graph with half-edges from chain endpoints.
 * This allows us to walk faces even when nodes have degree > 2 (T-junctions).
 */
function buildHalfEdgeGraph(chains: WallChain[], tolerance: number = 50): {
  nodes: Map<string, GraphNode>;
  halfEdges: Map<string, HalfEdge>;
} {
  const nodes = new Map<string, GraphNode>();
  const halfEdges = new Map<string, HalfEdge>();
  
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
      nodes.set(key, { x: rx, y: ry, key, halfEdges: [] });
    }
    return nodes.get(key)!;
  };
  
  let heIdCounter = 0;
  
  // Create half-edges for each chain
  chains.forEach(chain => {
    const startNode = getNode(chain.startX, chain.startY);
    const endNode = getNode(chain.endX, chain.endY);
    
    if (startNode.key === endNode.key) return; // Skip degenerate chains
    
    // Angle from start to end
    const angle = Math.atan2(endNode.y - startNode.y, endNode.x - startNode.x);
    const reverseAngle = Math.atan2(startNode.y - endNode.y, startNode.x - endNode.x);
    
    // Create two half-edges (one in each direction)
    const he1Id = `he-${heIdCounter++}`;
    const he2Id = `he-${heIdCounter++}`;
    
    const he1: HalfEdge = {
      id: he1Id,
      fromKey: startNode.key,
      toKey: endNode.key,
      chainId: chain.id,
      angle,
      twin: he2Id,
      visited: false,
    };
    
    const he2: HalfEdge = {
      id: he2Id,
      fromKey: endNode.key,
      toKey: startNode.key,
      chainId: chain.id,
      angle: reverseAngle,
      twin: he1Id,
      visited: false,
    };
    
    halfEdges.set(he1Id, he1);
    halfEdges.set(he2Id, he2);
    
    startNode.halfEdges.push(he1Id);
    endNode.halfEdges.push(he2Id);
  });
  
  // Sort half-edges at each node by angle (CCW order)
  nodes.forEach(node => {
    node.halfEdges.sort((aId, bId) => {
      const a = halfEdges.get(aId)!;
      const b = halfEdges.get(bId)!;
      return a.angle - b.angle;
    });
  });
  
  // Link "next" pointers using right-hand rule
  // For each half-edge arriving at a node, the "next" is the half-edge
  // that leaves the node with the smallest CCW angle from the incoming direction
  nodes.forEach(node => {
    node.halfEdges.forEach(heId => {
      const he = halfEdges.get(heId)!;
      const twinHe = halfEdges.get(he.twin!)!;
      
      // Find the outgoing edge at the destination node that is "next" (right-hand rule)
      const destNode = nodes.get(he.toKey)!;
      
      // Incoming angle at destination (from source)
      const incomingAngle = he.angle;
      
      // We want the outgoing edge with smallest CCW angle from (incoming + PI)
      const reversedAngle = incomingAngle + Math.PI;
      const normalized = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      
      // Find the next edge by right-hand rule
      // Sort destination edges by their angle difference from reversedAngle (CCW)
      let bestNext: string | null = null;
      let bestAngleDiff = Infinity;
      
      destNode.halfEdges.forEach(outHeId => {
        const outHe = halfEdges.get(outHeId)!;
        // Skip the twin (going back the same way)
        if (outHeId === he.twin) return;
        
        const outAngle = outHe.angle;
        // Calculate CCW angle difference from reversed incoming direction
        let angleDiff = normalized(outAngle) - normalized(reversedAngle);
        if (angleDiff < 0) angleDiff += 2 * Math.PI;
        if (angleDiff < 0.0001) angleDiff += 2 * Math.PI; // Avoid exactly 0 (same direction)
        
        if (angleDiff < bestAngleDiff) {
          bestAngleDiff = angleDiff;
          bestNext = outHeId;
        }
      });
      
      // If no other edge found, use twin (dead end - will form degenerate face)
      he.next = bestNext || he.twin;
    });
  });
  
  return { nodes, halfEdges };
}

/**
 * Extract all faces from the half-edge graph using face traversal.
 * This handles T-junctions correctly by following the linked "next" pointers.
 */
function extractFaces(
  nodes: Map<string, GraphNode>,
  halfEdges: Map<string, HalfEdge>
): FaceMeta[] {
  const faces: FaceMeta[] = [];
  let faceIdCounter = 0;
  
  // Walk each unvisited half-edge to extract faces
  halfEdges.forEach((startHe, startId) => {
    if (startHe.visited) return;
    
    const facePoints: Array<{ x: number; y: number }> = [];
    const faceEdgeIds: string[] = [];
    
    let currentId: string | undefined = startId;
    let iterations = 0;
    const maxIterations = halfEdges.size + 10;
    
    while (currentId && iterations < maxIterations) {
      iterations++;
      const he = halfEdges.get(currentId)!;
      
      if (he.visited) {
        // We've closed the loop or hit a visited edge
        if (currentId === startId && facePoints.length >= 3) {
          // Closed loop - valid face
          break;
        } else {
          // Hit a visited edge that's not the start - abort this face
          break;
        }
      }
      
      he.visited = true;
      faceEdgeIds.push(currentId);
      
      const fromNode = nodes.get(he.fromKey)!;
      facePoints.push({ x: fromNode.x, y: fromNode.y });
      
      currentId = he.next;
      
      // Check if we've returned to start
      if (currentId === startId) break;
    }
    
    // Only create face if we have a valid polygon
    if (facePoints.length >= 3) {
      const signedArea = signedPolygonArea(facePoints);
      const absArea = Math.abs(signedArea);
      
      // Calculate centroid
      let cx = 0, cy = 0;
      facePoints.forEach(p => { cx += p.x; cy += p.y; });
      const centroid = { x: cx / facePoints.length, y: cy / facePoints.length };
      
      faces.push({
        id: `face-${faceIdCounter++}`,
        points: facePoints,
        area: signedArea,
        absArea,
        orientation: signedArea >= 0 ? 'CCW' : 'CW',
        centroid,
        containsCount: 0,
      });
    }
  });
  
  return faces;
}

/**
 * Find closed loops in the graph using face-walking algorithm.
 * This is more robust than the old method for graphs with T-junctions.
 */
function findClosedLoopsFaceWalk(
  chains: WallChain[],
  tolerance: number = 50
): FaceMeta[] {
  const { nodes, halfEdges } = buildHalfEdgeGraph(chains, tolerance);
  
  console.log('[FootprintDetection] Face-walk graph:', {
    nodes: nodes.size,
    halfEdges: halfEdges.size,
    chains: chains.length,
  });
  
  const faces = extractFaces(nodes, halfEdges);
  
  // Filter out very small faces (noise) and the unbounded outer face
  // The unbounded face typically has very large negative area (CW winding)
  const MIN_FACE_AREA = 100000; // 100mm² minimum
  const validFaces = faces.filter(f => f.absArea > MIN_FACE_AREA);
  
  console.log('[FootprintDetection] Found faces:', {
    total: faces.length,
    valid: validFaces.length,
    areas: validFaces.slice(0, 5).map(f => ({ id: f.id, area: (f.absArea / 1e6).toFixed(2) + 'm²', orientation: f.orientation })),
  });
  
  return validFaces;
}

// ============= Main Classification Function =============

/**
 * Detect building footprint and classify each chain's exterior/interior sides.
 * Uses face-walking algorithm that handles T-junctions correctly.
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
      facesFound: [],
      chainSides: new Map(),
      interiorLoops: [],
      stats: { totalChains: 0, exteriorChains: 0, interiorPartitions: 0, unresolved: 0, outsideFootprint: 0 },
      unresolvedChainIds: [],
      outsideChainIds: [],
      partitionChainIds: [],
    };
  }
  
  // Step 1: Find faces using face-walking algorithm (handles T-junctions)
  const faces = findClosedLoopsFaceWalk(chains, tolerance);
  
  console.log('[FootprintDetection] Found', faces.length, 'closed faces');
  
  // Step 2: Identify outer polygon using robust selection algorithm
  let outerPolygon: Array<{ x: number; y: number }> = [];
  let outerArea = 0;
  const interiorLoops: Array<Array<{ x: number; y: number }>> = [];
  let usedFallback = false;
  
  // Calculate containsCount for each face
  for (let i = 0; i < faces.length; i++) {
    for (let j = 0; j < faces.length; j++) {
      if (i === j) continue;
      // Normalize face to CCW for consistent point-in-polygon test
      const normalizedFace = faces[i].orientation === 'CCW' 
        ? faces[i].points 
        : [...faces[i].points].reverse();
      if (pointInPolygon(faces[j].centroid.x, faces[j].centroid.y, normalizedFace)) {
        faces[i].containsCount++;
      }
    }
  }
  
  // Sort faces by selection criteria:
  // 1. Primary: Largest containsCount (contains most other faces)
  // 2. Secondary: Largest absArea
  faces.sort((a, b) => {
    // First by containsCount (descending)
    if (b.containsCount !== a.containsCount) {
      return b.containsCount - a.containsCount;
    }
    // Then by area (descending)
    return b.absArea - a.absArea;
  });
  
  console.log('[FootprintDetection] Face selection candidates:', faces.slice(0, 5).map((f, i) => ({
    index: i,
    id: f.id,
    area: (f.absArea / 1e6).toFixed(2) + 'm²',
    containsCount: f.containsCount,
    orientation: f.orientation,
    vertices: f.points.length,
  })));
  
  // Select the best candidate as outer polygon
  if (faces.length > 0) {
    const best = faces[0];
    // Ensure CCW winding for outer polygon
    outerPolygon = best.orientation === 'CCW' ? best.points : [...best.points].reverse();
    outerArea = best.absArea;
    
    // All other faces are interior
    for (let i = 1; i < faces.length; i++) {
      interiorLoops.push(faces[i].points);
    }
    
    console.log('[FootprintDetection] Selected outer polygon:', {
      id: best.id,
      vertices: outerPolygon.length,
      area: (outerArea / 1e6).toFixed(2) + 'm²',
      containsCount: best.containsCount,
    });
  }
  
  // Fallback: If no closed faces found, try to create a bounding polygon
  if (outerPolygon.length < 3) {
    console.log('[FootprintDetection] No closed faces, using convex hull fallback');
    outerPolygon = createBoundingPolygon(chains);
    outerArea = Math.abs(signedPolygonArea(outerPolygon));
    usedFallback = true;
  }
  
  console.log('[FootprintDetection] Outer polygon:', outerPolygon.length, 'vertices, area:', (outerArea / 1e6).toFixed(2), 'm²');
  
  // Step 3: Classify each chain using ADAPTIVE EPS and MAJORITY VOTING
  const chainSides = new Map<string, ChainSideInfo>();
  let exteriorChains = 0;
  let interiorPartitions = 0;
  let unresolved = 0;
  let outsideFootprint = 0;
  const unresolvedChainIds: string[] = [];
  const outsideChainIds: string[] = [];
  const partitionChainIds: string[] = [];
  
  // Adaptive eps values - try multiple distances to escape boundary ambiguity
  const EPS_LIST = [50, 150, 300, 500]; // mm - increasing offset distances
  const EDGE_TOLERANCE = 5; // mm - tolerance for on-edge detection
  
  /**
   * Test a single point with adaptive eps to determine inside/outside
   */
  const testPointAdaptive = (
    baseX: number, baseY: number,
    perpX: number, perpY: number,
    sign: 1 | -1
  ): { result: 'inside' | 'outside' | 'ambiguous'; usedEps: number } => {
    for (const eps of EPS_LIST) {
      const testX = baseX + perpX * eps * sign;
      const testY = baseY + perpY * eps * sign;
      
      const pointResult = robustPointInPolygon(testX, testY, outerPolygon, EDGE_TOLERANCE);
      
      if (pointResult === 'on_edge') continue;
      
      return {
        result: pointResult === 'inside' ? 'inside' : 'outside',
        usedEps: eps,
      };
    }
    
    return { result: 'ambiguous', usedEps: 0 };
  };
  
  /**
   * Classify a chain segment using adaptive eps
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
    
    const usedEps = Math.max(plusResult.usedEps, minusResult.usedEps);
    
    if (plusAmbiguous || minusAmbiguous) {
      return { vote: 'AMBIGUOUS', usedEps };
    }
    
    if (minusInside && !plusInside) {
      return { vote: 'RIGHT_EXT', usedEps };
    } else if (!minusInside && plusInside) {
      return { vote: 'LEFT_EXT', usedEps };
    } else if (plusInside && minusInside) {
      return { vote: 'BOTH_INT', usedEps };
    } else {
      return { vote: 'BOTH_OUTSIDE', usedEps };
    }
  };
  
  chains.forEach(chain => {
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
        isOutsideFootprint: false,
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
    const perpX = dirY;
    const perpY = -dirX;
    
    // Sample multiple points along the chain for majority voting
    const numSamples = Math.min(5, Math.max(1, Math.floor(len / 500)));
    const samplePoints: Array<{ x: number; y: number }> = [];
    
    for (let i = 0; i < numSamples; i++) {
      const t = numSamples === 1 ? 0.5 : i / (numSamples - 1);
      const tClamped = Math.max(0.1, Math.min(0.9, t));
      samplePoints.push({
        x: chain.startX + dx * tClamped,
        y: chain.startY + dy * tClamped,
      });
    }
    
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
    
    const totalVotes = samplePoints.length;
    const majorityThreshold = Math.ceil(totalVotes / 2);
    
    let classification: SideClassification;
    let outsideIsPositivePerp = true;
    let outwardNormalAngle: number | null = null;
    let unresolvedReason: string | undefined;
    let isOutsideFootprint = false;
    let outsideReason: string | undefined;
    
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
      outsideIsPositivePerp = true;
      interiorPartitions++;
      partitionChainIds.push(chain.id);
    } else if (bothOutsideVotes >= majorityThreshold) {
      classification = 'BOTH_INT';
      outsideIsPositivePerp = true;
      isOutsideFootprint = true;
      outsideReason = 'BOTH_OUTSIDE';
      outsideFootprint++;
      outsideChainIds.push(chain.id);
    } else if (ambiguousVotes >= majorityThreshold) {
      classification = 'UNRESOLVED';
      unresolvedReason = 'BOUNDARY_AMBIGUOUS';
      unresolved++;
      unresolvedChainIds.push(chain.id);
    } else {
      const perimeterVotes = rightExtVotes + leftExtVotes;
      if (perimeterVotes > bothIntVotes && perimeterVotes > ambiguousVotes + bothOutsideVotes) {
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
        partitionChainIds.push(chain.id);
      } else {
        classification = 'UNRESOLVED';
        unresolvedReason = 'MIXED_VOTES';
        unresolved++;
        unresolvedChainIds.push(chain.id);
      }
    }
    
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
      isOutsideFootprint,
      outsideReason,
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
  if (outerPolygon.length >= 3) {
    chainSides.forEach((sideInfo, chainId) => {
      if (sideInfo.classification !== 'LEFT_EXT' && sideInfo.classification !== 'RIGHT_EXT') {
        return;
      }
      
      const chain = chains.find(c => c.id === chainId);
      if (!chain) return;
      
      const dx = chain.endX - chain.startX;
      const dy = chain.endY - chain.startY;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1) return;
      
      const dirX = dx / len;
      const dirY = dy / len;
      const perpX = dirY;
      const perpY = -dirX;
      
      const midX = (chain.startX + chain.endX) / 2;
      const midY = (chain.startY + chain.endY) / 2;
      
      const testResult = testPointAdaptive(
        midX, midY, perpX, perpY,
        sideInfo.outsideIsPositivePerp ? 1 : -1
      );
      
      if (testResult.result === 'inside') {
        console.log(`[FootprintDetection] Consistency check: Chain ${chainId} has inverted EXT/INT - correcting`);
        
        sideInfo.outsideIsPositivePerp = !sideInfo.outsideIsPositivePerp;
        
        if (sideInfo.classification === 'LEFT_EXT') {
          sideInfo.classification = 'RIGHT_EXT';
        } else if (sideInfo.classification === 'RIGHT_EXT') {
          sideInfo.classification = 'LEFT_EXT';
        }
        
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
    unresolved,
    outsideFootprint,
  });
  
  // Sanity check: if too many chains are "outside", warn
  const totalClassified = exteriorChains + interiorPartitions + unresolved + outsideFootprint;
  const outsideRatio = totalClassified > 0 ? outsideFootprint / totalClassified : 0;
  if (outsideRatio > 0.4) {
    console.warn('[FootprintDetection] WARNING: High outside ratio (' + (outsideRatio * 100).toFixed(0) + '%) - footprint may be incorrect');
  }
  
  const status: FootprintStatus = 
    (outerPolygon.length >= 3 && !usedFallback) ? 'OK' : 
    (usedFallback && outerPolygon.length >= 3) ? 'OK' :
    'UNRESOLVED';
  
  return {
    status,
    outerPolygon,
    outerArea,
    loopsFound: faces.length,
    facesFound: faces,
    chainSides,
    interiorLoops,
    stats: {
      totalChains: chains.length,
      exteriorChains,
      interiorPartitions,
      unresolved,
      outsideFootprint,
    },
    unresolvedChainIds,
    outsideChainIds,
    partitionChainIds,
  };
}

/**
 * Create a bounding polygon from chain endpoints when no closed loops exist.
 * Uses convex hull algorithm for robustness.
 */
function createBoundingPolygon(chains: WallChain[]): Array<{ x: number; y: number }> {
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
  
  return convexHull(points);
}

/**
 * Graham scan convex hull algorithm
 */
function convexHull(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (points.length < 3) return [...points];
  
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].y < points[start].y || 
        (points[i].y === points[start].y && points[i].x < points[start].x)) {
      start = i;
    }
  }
  
  const startPoint = points[start];
  
  const sorted = points
    .filter((_, i) => i !== start)
    .map(p => ({
      point: p,
      angle: Math.atan2(p.y - startPoint.y, p.x - startPoint.x),
      dist: Math.sqrt((p.x - startPoint.x) ** 2 + (p.y - startPoint.y) ** 2),
    }))
    .sort((a, b) => a.angle - b.angle || a.dist - b.dist)
    .map(p => p.point);
  
  const hull: Array<{ x: number; y: number }> = [startPoint];
  
  for (const p of sorted) {
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
 */
export function getPanelSideFromClassification(
  classification: SideClassification,
  isPositiveOffset: boolean
): 'exterior' | 'interior' {
  switch (classification) {
    case 'RIGHT_EXT':
      return isPositiveOffset ? 'exterior' : 'interior';
    case 'LEFT_EXT':
      return isPositiveOffset ? 'interior' : 'exterior';
    case 'BOTH_INT':
      return 'interior';
    case 'UNRESOLVED':
    default:
      return isPositiveOffset ? 'exterior' : 'interior';
  }
}
