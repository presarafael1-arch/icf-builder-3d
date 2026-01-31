/**
 * Footprint Detection Module
 * 
 * Detects building footprint (outer polygon) from wall segments/chains
 * and classifies which side of each chain is exterior vs interior.
 * 
 * Algorithm:
 * 1. Build a half-edge graph from chain endpoints with robust snapping
 * 2. Face-walk using right-hand rule to extract all bounded faces
 * 3. Select the LARGEST bounded face as the footprint (contains most other faces)
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
  outsideIsPositivePerp: boolean;
  // The outward normal direction (pointing to exterior)
  outwardNormalAngle: number | null;
  // Debug info
  leftInside: boolean;
  rightInside: boolean;
  // Flag: true if chain is entirely outside the building footprint
  isOutsideFootprint: boolean;
  // Reason for being outside footprint
  outsideReason?: string;
  // Segment-level stats for debug
  segmentStats?: {
    totalSegments: number;
    leftExtCount: number;
    rightExtCount: number;
    bothIntCount: number;
    unresolvedCount: number;
    unresolvedReason?: string;
  };
}

export interface FootprintResult {
  status: FootprintStatus;
  outerPolygon: Array<{ x: number; y: number }>;
  outerArea: number;
  loopsFound: number;
  chainSides: Map<string, ChainSideInfo>;
  interiorLoops: Array<Array<{ x: number; y: number }>>;
  stats: {
    totalChains: number;
    exteriorChains: number;
    interiorPartitions: number;
    unresolved: number;
    outsideFootprint: number;
  };
  unresolvedChainIds: string[];
  outsideChainIds: string[];
  partitionChainIds: string[];
  // Debug info for face-walking
  facesFound?: number;
  footprintCyclePoints?: number;
  footprintOrientation?: 'CW' | 'CCW';
}

// ============= Point-in-Polygon Algorithm =============

function pointToSegmentDistance(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  
  if (lenSq < 0.0001) {
    return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  }
  
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

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

function isOnPolygonEdge(
  px: number, py: number,
  polygon: Array<{ x: number; y: number }>,
  tolerance: number = 1.0
): boolean {
  return distanceToPolygonBoundary(px, py, polygon) < tolerance;
}

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
    
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  
  return inside;
}

function robustPointInPolygon(
  px: number, py: number,
  polygon: Array<{ x: number; y: number }>,
  edgeTolerance: number = 1.0
): 'inside' | 'outside' | 'on_edge' {
  if (isOnPolygonEdge(px, py, polygon, edgeTolerance)) {
    return 'on_edge';
  }
  return pointInPolygon(px, py, polygon) ? 'inside' : 'outside';
}

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

// ============= Half-Edge Face-Walking Algorithm =============

interface HalfEdge {
  from: string;      // Node key
  to: string;        // Node key
  chainId: string;
  angle: number;     // Angle from 'from' to 'to'
  twin?: HalfEdge;   // Opposite direction half-edge
  next?: HalfEdge;   // Next half-edge in face (CCW for interior faces)
  visited: boolean;
}

interface FaceWalkNode {
  key: string;
  x: number;
  y: number;
  outgoing: HalfEdge[];  // Half-edges leaving this node, sorted by angle
}

/**
 * Build half-edge graph with robust snapping
 */
function buildHalfEdgeGraph(chains: WallChain[], snapTolerance: number = 50): Map<string, FaceWalkNode> {
  const nodes = new Map<string, FaceWalkNode>();
  const allHalfEdges: HalfEdge[] = [];
  
  // Helper to snap and get node key
  const getNodeKey = (x: number, y: number): string => {
    const rx = Math.round(x / snapTolerance) * snapTolerance;
    const ry = Math.round(y / snapTolerance) * snapTolerance;
    return `${rx},${ry}`;
  };
  
  // Helper to get or create node
  const getNode = (x: number, y: number): FaceWalkNode => {
    const key = getNodeKey(x, y);
    if (!nodes.has(key)) {
      const rx = Math.round(x / snapTolerance) * snapTolerance;
      const ry = Math.round(y / snapTolerance) * snapTolerance;
      nodes.set(key, { key, x: rx, y: ry, outgoing: [] });
    }
    return nodes.get(key)!;
  };
  
  // Create half-edges for each chain
  chains.forEach(chain => {
    const startNode = getNode(chain.startX, chain.startY);
    const endNode = getNode(chain.endX, chain.endY);
    
    if (startNode.key === endNode.key) return; // Skip degenerate
    
    const angle = Math.atan2(endNode.y - startNode.y, endNode.x - startNode.x);
    
    // Create forward half-edge (start -> end)
    const forward: HalfEdge = {
      from: startNode.key,
      to: endNode.key,
      chainId: chain.id,
      angle: angle,
      visited: false,
    };
    
    // Create backward half-edge (end -> start)
    const backward: HalfEdge = {
      from: endNode.key,
      to: startNode.key,
      chainId: chain.id,
      angle: angle + Math.PI,
      visited: false,
    };
    
    // Link twins
    forward.twin = backward;
    backward.twin = forward;
    
    // Add to node outgoing lists
    startNode.outgoing.push(forward);
    endNode.outgoing.push(backward);
    
    allHalfEdges.push(forward, backward);
  });
  
  // Sort outgoing edges at each node by angle (CCW order)
  nodes.forEach(node => {
    node.outgoing.sort((a, b) => {
      // Normalize angles to [0, 2π)
      const angleA = ((a.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const angleB = ((b.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return angleA - angleB;
    });
  });
  
  // Set up 'next' pointers using right-hand rule
  // For each half-edge arriving at a node, the "next" is the edge
  // immediately CCW from the reverse direction
  allHalfEdges.forEach(he => {
    const arrivalNode = nodes.get(he.to);
    if (!arrivalNode || arrivalNode.outgoing.length === 0) return;
    
    // Incoming angle (from he.from to he.to, but we want the direction pointing INTO the node)
    const incomingAngle = he.angle; // Already pointing toward he.to
    const reverseAngle = ((incomingAngle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    
    // Find the outgoing edge that is immediately CCW (or CW for right-hand rule) from reverseAngle
    // For right-hand rule: we want the FIRST edge CW from the incoming direction
    const outgoing = arrivalNode.outgoing;
    let bestIdx = 0;
    let bestAngleDiff = Infinity;
    
    for (let i = 0; i < outgoing.length; i++) {
      const outAngle = ((outgoing[i].angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      // CW angle difference: how much we need to turn CW from reverseAngle to reach outAngle
      let diff = reverseAngle - outAngle;
      if (diff <= 0) diff += 2 * Math.PI;
      
      // Skip the twin edge (going back where we came from) unless it's the only option
      if (outgoing[i] === he.twin && outgoing.length > 1) continue;
      
      if (diff < bestAngleDiff) {
        bestAngleDiff = diff;
        bestIdx = i;
      }
    }
    
    he.next = outgoing[bestIdx];
  });
  
  return nodes;
}

/**
 * Walk faces using the half-edge structure
 * Returns all bounded faces as polygons
 */
function walkFaces(nodes: Map<string, FaceWalkNode>): Array<Array<{ x: number; y: number }>> {
  const faces: Array<Array<{ x: number; y: number }>> = [];
  
  // Collect all half-edges
  const allHalfEdges: HalfEdge[] = [];
  nodes.forEach(node => {
    allHalfEdges.push(...node.outgoing);
  });
  
  // Walk each unvisited half-edge
  for (const startEdge of allHalfEdges) {
    if (startEdge.visited) continue;
    
    const facePoints: Array<{ x: number; y: number }> = [];
    let current: HalfEdge | undefined = startEdge;
    let iterations = 0;
    const maxIterations = allHalfEdges.length + 10;
    
    while (current && !current.visited && iterations < maxIterations) {
      iterations++;
      current.visited = true;
      
      // Add the starting point of this edge
      const fromNode = nodes.get(current.from);
      if (fromNode) {
        facePoints.push({ x: fromNode.x, y: fromNode.y });
      }
      
      // Move to next edge
      current = current.next;
      
      // Check if we've closed the loop
      if (current === startEdge) break;
    }
    
    // Only keep valid faces (3+ vertices)
    if (facePoints.length >= 3) {
      faces.push(facePoints);
    }
  }
  
  return faces;
}

/**
 * Calculate polygon centroid
 */
function polygonCentroid(polygon: Array<{ x: number; y: number }>): { x: number; y: number } {
  if (polygon.length === 0) return { x: 0, y: 0 };
  
  let cx = 0, cy = 0;
  polygon.forEach(p => {
    cx += p.x;
    cy += p.y;
  });
  return { x: cx / polygon.length, y: cy / polygon.length };
}

/**
 * Check if polygon A contains the centroid of polygon B
 */
function containsCentroid(outer: Array<{ x: number; y: number }>, inner: Array<{ x: number; y: number }>): boolean {
  const centroid = polygonCentroid(inner);
  return pointInPolygon(centroid.x, centroid.y, outer);
}

/**
 * Find all closed loops using half-edge face-walking algorithm
 * Returns loops sorted by area (largest first), with containment info
 */
function findClosedLoopsHalfEdge(
  chains: WallChain[],
  tolerance: number = 50
): { 
  faces: Array<Array<{ x: number; y: number }>>; 
  faceMeta: Array<{ area: number; containsCount: number; orientation: 'CW' | 'CCW' }>;
} {
  const nodes = buildHalfEdgeGraph(chains, tolerance);
  const faces = walkFaces(nodes);
  
  console.log('[FootprintDetection] Half-edge walk found', faces.length, 'faces');
  
  // Calculate metadata for each face
  const faceMeta = faces.map((face, i) => {
    const area = signedPolygonArea(face);
    const absArea = Math.abs(area);
    const orientation: 'CW' | 'CCW' = area > 0 ? 'CCW' : 'CW';
    
    // Count how many other face centroids this face contains
    let containsCount = 0;
    for (let j = 0; j < faces.length; j++) {
      if (i === j) continue;
      if (containsCentroid(face, faces[j])) {
        containsCount++;
      }
    }
    
    return { area: absArea, containsCount, orientation };
  });
  
  // Sort by containsCount (primary) then by area (secondary) - largest first
  const sorted = faces
    .map((face, i) => ({ face, meta: faceMeta[i], index: i }))
    .sort((a, b) => {
      // Primary: containsCount (more containment = more likely outer)
      if (b.meta.containsCount !== a.meta.containsCount) {
        return b.meta.containsCount - a.meta.containsCount;
      }
      // Secondary: area
      return b.meta.area - a.meta.area;
    });
  
  return {
    faces: sorted.map(s => s.face),
    faceMeta: sorted.map(s => s.meta),
  };
}

// ============= Legacy Loop Finding (Fallback) =============

interface GraphNode {
  x: number;
  y: number;
  key: string;
  edges: Array<{ toKey: string; chainId: string; angle: number }>;
}

function buildGraph(chains: WallChain[], tolerance: number = 50): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>();
  
  const getNodeKey = (x: number, y: number): string => {
    const rx = Math.round(x / tolerance) * tolerance;
    const ry = Math.round(y / tolerance) * tolerance;
    return `${rx},${ry}`;
  };
  
  const getNode = (x: number, y: number): GraphNode => {
    const key = getNodeKey(x, y);
    if (!nodes.has(key)) {
      const rx = Math.round(x / tolerance) * tolerance;
      const ry = Math.round(y / tolerance) * tolerance;
      nodes.set(key, { x: rx, y: ry, key, edges: [] });
    }
    return nodes.get(key)!;
  };
  
  chains.forEach(chain => {
    const startNode = getNode(chain.startX, chain.startY);
    const endNode = getNode(chain.endX, chain.endY);
    
    if (startNode.key === endNode.key) return;
    
    const angle = Math.atan2(chain.endY - chain.startY, chain.endX - chain.startX);
    
    startNode.edges.push({ toKey: endNode.key, chainId: chain.id, angle });
    endNode.edges.push({ toKey: startNode.key, chainId: chain.id, angle: angle + Math.PI });
  });
  
  return nodes;
}

function findClosedLoopsLegacy(
  graph: Map<string, GraphNode>,
  chains: WallChain[]
): Array<Array<{ x: number; y: number }>> {
  const loops: Array<Array<{ x: number; y: number }>> = [];
  const usedEdges = new Set<string>();
  
  graph.forEach(node => {
    node.edges.sort((a, b) => a.angle - b.angle);
  });
  
  graph.forEach((startNode) => {
    startNode.edges.forEach((startEdge) => {
      const edgeKey = `${startNode.key}->${startEdge.toKey}:${startEdge.chainId}`;
      if (usedEdges.has(edgeKey)) return;
      
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
        
        if (nextNode.key === startNode.key && pathEdges.length >= 3) {
          loops.push([...path.slice(0, -1)]);
          pathEdges.forEach(e => usedEdges.add(e));
          break;
        }
        
        const incomingAngle = currentEdge.angle + Math.PI;
        const normalizedIncoming = ((incomingAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        
        let bestEdge: typeof currentEdge | null = null;
        let bestAngleDiff = Infinity;
        
        for (const edge of nextNode.edges) {
          if (edge.toKey === currentNode.key && edge.chainId === currentEdge.chainId) continue;
          
          const edgeAngle = ((edge.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          let angleDiff = edgeAngle - normalizedIncoming;
          if (angleDiff < 0) angleDiff += 2 * Math.PI;
          if (angleDiff < 0.01) angleDiff += 2 * Math.PI;
          
          if (angleDiff < bestAngleDiff) {
            bestAngleDiff = angleDiff;
            bestEdge = edge;
          }
        }
        
        if (!bestEdge) break;
        
        const nextEdgeKey = `${nextNode.key}->${bestEdge.toKey}:${bestEdge.chainId}`;
        if (pathEdges.includes(nextEdgeKey)) break;
        
        pathEdges.push(nextEdgeKey);
        currentNode = nextNode;
        currentEdge = bestEdge;
      }
    });
  });
  
  loops.sort((a, b) => Math.abs(signedPolygonArea(b)) - Math.abs(signedPolygonArea(a)));
  
  return loops;
}

// ============= Main Classification Function =============

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
      stats: { totalChains: 0, exteriorChains: 0, interiorPartitions: 0, unresolved: 0, outsideFootprint: 0 },
      unresolvedChainIds: [],
      outsideChainIds: [],
      partitionChainIds: [],
    };
  }
  
  // Step 1: Try half-edge face-walking first (more robust for T-junctions)
  const { faces, faceMeta } = findClosedLoopsHalfEdge(chains, tolerance);
  
  // Step 2: Select outer polygon using SCORING SYSTEM
  // Score = containsCount * 1e6 + area + perimeter * 0.001 - outsideCount * 1e7
  // The face with highest score after validation is the building perimeter
  let outerPolygon: Array<{ x: number; y: number }> = [];
  let outerArea = 0;
  let usedFallback = false;
  const interiorLoops: Array<Array<{ x: number; y: number }>> = [];
  let footprintOrientation: 'CW' | 'CCW' = 'CCW';
  
  if (faces.length > 0) {
    // Score each candidate
    interface CandidateScore {
      index: number;
      polygon: Array<{ x: number; y: number }>;
      area: number;
      containsCount: number;
      outsideCount: number;
      perimeterCount: number;
      perimeterLength: number;
      score: number;
      orientation: 'CW' | 'CCW';
    }
    
    const candidates: CandidateScore[] = [];
    
    for (let i = 0; i < Math.min(faces.length, 10); i++) { // Check top 10 candidates
      const candidate = faces[i];
      const meta = faceMeta[i];
      const absArea = meta.area;
      
      // Skip very small faces (likely artifacts)
      if (absArea < 10000) continue; // < 0.01 m²
      
      // Normalize orientation for testing
      const testPolygon = meta.orientation === 'CCW' ? candidate : [...candidate].reverse();
      
      // Calculate perimeter length
      let perimeterLength = 0;
      for (let j = 0; j < testPolygon.length; j++) {
        const p1 = testPolygon[j];
        const p2 = testPolygon[(j + 1) % testPolygon.length];
        perimeterLength += Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
      }
      
      // Validate: count chains by classification
      let outsideCount = 0;
      let perimeterCount = 0;
      let partitionCount = 0;
      let perimeterChainsLength = 0;
      
      for (const chain of chains) {
        const midX = (chain.startX + chain.endX) / 2;
        const midY = (chain.startY + chain.endY) / 2;
        
        const dx = chain.endX - chain.startX;
        const dy = chain.endY - chain.startY;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) continue;
        
        const perpX = dy / len;
        const perpY = -dx / len;
        
        // Test at multiple eps values for robustness
        let plusInside = false;
        let minusInside = false;
        
        for (const eps of [50, 150, 300]) {
          const pPlus = { x: midX + perpX * eps, y: midY + perpY * eps };
          const pMinus = { x: midX - perpX * eps, y: midY - perpY * eps };
          
          const testPlus = robustPointInPolygon(pPlus.x, pPlus.y, testPolygon, 5);
          const testMinus = robustPointInPolygon(pMinus.x, pMinus.y, testPolygon, 5);
          
          if (testPlus === 'inside') plusInside = true;
          if (testMinus === 'inside') minusInside = true;
          
          // If we have a clear answer, stop testing
          if ((plusInside || testPlus === 'outside') && (minusInside || testMinus === 'outside')) {
            break;
          }
        }
        
        if (!plusInside && !minusInside) {
          outsideCount++;
        } else if (plusInside !== minusInside) {
          perimeterCount++;
          perimeterChainsLength += len;
        } else if (plusInside && minusInside) {
          partitionCount++;
        }
      }
      
      // Calculate score:
      // - High containsCount = likely outer (contains more interior rooms)
      // - High perimeterCount = good coverage of building perimeter
      // - Low outsideCount = not selecting an interior courtyard
      // - Large area = encompasses more of the building
      const score = 
        meta.containsCount * 1000000 +   // Primary: contains more faces
        perimeterChainsLength * 10 +     // Secondary: covers more perimeter length
        perimeterCount * 5000 +          // Tertiary: covers more chains as perimeter
        absArea / 1000000 -              // Quaternary: larger area preferred
        outsideCount * 500000;           // Penalty: chains outside this footprint
      
      console.log(`[FootprintDetection] Candidate ${i}: area=${(absArea / 1e6).toFixed(2)}m², contains=${meta.containsCount}, perimeter=${perimeterCount}/${chains.length}, outside=${outsideCount}, score=${score.toFixed(0)}`);
      
      candidates.push({
        index: i,
        polygon: testPolygon,
        area: absArea,
        containsCount: meta.containsCount,
        outsideCount,
        perimeterCount,
        perimeterLength: perimeterChainsLength,
        score,
        orientation: meta.orientation,
      });
    }
    
    // Sort by score (highest first)
    candidates.sort((a, b) => b.score - a.score);
    
    // Select best candidate that passes validation
    for (const cand of candidates) {
      const outsideRatio = cand.outsideCount / chains.length;
      const perimeterRatio = cand.perimeterCount / chains.length;
      
      // More lenient thresholds for high-scoring candidates
      const scoreThreshold = candidates[0].score * 0.5;
      const isHighScorer = cand.score >= scoreThreshold;
      
      // Relaxed thresholds for high scorers - buildings with many interior walls can have 40%+ "outside" chains
      const maxOutsideRatio = isHighScorer ? 0.50 : 0.35;
      const minPerimeterRatio = isHighScorer ? 0.08 : 0.12;
      
      if (outsideRatio > maxOutsideRatio) {
        console.log(`[FootprintDetection] Rejecting candidate ${cand.index}: outsideRatio=${outsideRatio.toFixed(2)} > ${maxOutsideRatio}`);
        continue;
      }
      
      if (perimeterRatio < minPerimeterRatio) {
        console.log(`[FootprintDetection] Rejecting candidate ${cand.index}: perimeterRatio=${perimeterRatio.toFixed(2)} < ${minPerimeterRatio}`);
        continue;
      }
      
      // Accept this candidate
      console.log(`[FootprintDetection] Selected candidate ${cand.index} with score=${cand.score.toFixed(0)}`);
      outerPolygon = cand.polygon;
      outerArea = cand.area;
      footprintOrientation = cand.orientation;
      
      // Collect interior loops (all other faces that are inside this one)
      for (let j = 0; j < faces.length; j++) {
        if (j === cand.index) continue;
        if (faceMeta[j].area > 1000 && containsCentroid(outerPolygon, faces[j])) {
          interiorLoops.push(faces[j]);
        }
      }
      
      break;
    }
  }
  
  // Fallback to legacy loop finding if half-edge didn't work
  if (outerPolygon.length < 3) {
    console.log('[FootprintDetection] Half-edge failed, trying legacy loop finding');
    const graph = buildGraph(chains, tolerance);
    const loops = findClosedLoopsLegacy(graph, chains);
    
    for (const loop of loops) {
      const area = signedPolygonArea(loop);
      const absArea = Math.abs(area);
      
      if (absArea > outerArea) {
        if (outerPolygon.length > 0) {
          interiorLoops.push(outerPolygon);
        }
        outerPolygon = area > 0 ? loop : [...loop].reverse();
        outerArea = absArea;
      } else if (loop.length >= 3) {
        interiorLoops.push(loop);
      }
    }
  }
  
  // Final fallback: convex hull
  if (outerPolygon.length < 3) {
    console.log('[FootprintDetection] No closed loops, using convex hull fallback');
    outerPolygon = createBoundingPolygon(chains);
    outerArea = Math.abs(signedPolygonArea(outerPolygon));
    usedFallback = true;
  }
  
  console.log('[FootprintDetection] Outer polygon:', outerPolygon.length, 'vertices, area:', (outerArea / 1e6).toFixed(2), 'm²');
  
  // Step 3: Classify each chain
  const chainSides = new Map<string, ChainSideInfo>();
  let exteriorChains = 0;
  let interiorPartitions = 0;
  let unresolved = 0;
  let outsideFootprint = 0;
  const unresolvedChainIds: string[] = [];
  const outsideChainIds: string[] = [];
  const partitionChainIds: string[] = [];
  
  const EPS_LIST = [50, 150, 300, 500];
  const EDGE_TOLERANCE = 5;
  
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
    const perpX = dirY;
    const perpY = -dirX;
    
    // Sample multiple points along the chain
    const numSamples = Math.min(10, Math.max(3, Math.floor(len / 300)));
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
    
    for (const pt of samplePoints) {
      const result = classifySegment(pt.x, pt.y, perpX, perpY);
      
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
      // Chain is OUTSIDE the footprint - flag it but don't mark as error
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
      // No clear majority - use highest vote count
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
      } else if (bothOutsideVotes > 0) {
        // More outside votes than anything else
        classification = 'BOTH_INT';
        outsideIsPositivePerp = true;
        isOutsideFootprint = true;
        outsideReason = 'BOTH_OUTSIDE';
        outsideFootprint++;
        outsideChainIds.push(chain.id);
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
  
  const status: FootprintStatus = 
    (outerPolygon.length >= 3 && !usedFallback) ? 'OK' : 
    (usedFallback && outerPolygon.length >= 3) ? 'OK' :
    'UNRESOLVED';
  
  return {
    status,
    outerPolygon,
    outerArea,
    loopsFound: faces.length,
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
    facesFound: faces.length,
    footprintCyclePoints: outerPolygon.length,
    footprintOrientation,
  };
}

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
