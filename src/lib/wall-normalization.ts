// Wall Normalization Pipeline for OMNI ICF WALLS 3D PLANNER
// This module provides industrial-standard DXF normalization including:
// - Geometry recentering
// - Colinear segment merging  
// - Noise removal
// - Topology detection (L, T, X junctions)

import { DXFSegment } from './dxf-parser';

export interface NormalizedSegment {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  layerName: string;
  length: number;
  angle: number;
}

export interface WallGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  id: string;
  x: number;
  y: number;
  type: 'L' | 'T' | 'X' | 'end';
  connectedEdgeIds: string[];
  angles: number[];
}

export interface GraphEdge {
  id: string;
  startNodeId: string;
  endNodeId: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  length: number;
  angle: number;
  layerName: string;
}

export interface NormalizationResult {
  segments: NormalizedSegment[];
  mergedSegments: NormalizedSegment[];
  graph: WallGraph;
  stats: {
    originalCount: number;
    removedNoise: number;
    mergedCount: number;
    finalCount: number;
    totalLengthMM: number;
    junctionCounts: {
      L: number;
      T: number;
      X: number;
      end: number;
    };
  };
  center: { x: number; y: number };
  boundingBox: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
  };
}

// Tolerance constants (in mm)
const POINT_TOLERANCE = 10; // For matching endpoints
const ANGLE_TOLERANCE = 0.05; // ~3 degrees in radians
const MIN_SEGMENT_LENGTH = 50; // Remove segments shorter than 50mm

/**
 * Calculate segment length
 */
function calculateLength(seg: { startX: number; startY: number; endX: number; endY: number }): number {
  const dx = seg.endX - seg.startX;
  const dy = seg.endY - seg.startY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Calculate segment angle (in radians, normalized to [0, π))
 */
function calculateAngle(seg: { startX: number; startY: number; endX: number; endY: number }): number {
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
function pointsCoincide(x1: number, y1: number, x2: number, y2: number, tolerance: number = POINT_TOLERANCE): boolean {
  const dx = Math.abs(x1 - x2);
  const dy = Math.abs(y1 - y2);
  return dx <= tolerance && dy <= tolerance;
}

/**
 * Check if two angles are equal within tolerance
 */
function anglesEqual(a1: number, a2: number, tolerance: number = ANGLE_TOLERANCE): boolean {
  let diff = Math.abs(a1 - a2);
  // Handle wraparound at π
  if (diff > Math.PI / 2) diff = Math.PI - diff;
  return diff <= tolerance;
}

/**
 * Step 1: Remove noise (very short segments and duplicates)
 */
function removeNoise(segments: DXFSegment[]): { cleaned: DXFSegment[]; removedCount: number } {
  const seen = new Set<string>();
  const cleaned: DXFSegment[] = [];
  let removedCount = 0;

  for (const seg of segments) {
    const length = calculateLength(seg);
    
    // Skip very short segments
    if (length < MIN_SEGMENT_LENGTH) {
      removedCount++;
      continue;
    }

    // Create a unique key for this segment (order-independent)
    const p1 = `${Math.round(seg.startX)},${Math.round(seg.startY)}`;
    const p2 = `${Math.round(seg.endX)},${Math.round(seg.endY)}`;
    const key = [p1, p2].sort().join('-');

    // Skip duplicates
    if (seen.has(key)) {
      removedCount++;
      continue;
    }

    seen.add(key);
    cleaned.push(seg);
  }

  return { cleaned, removedCount };
}

/**
 * Step 2: Recenter geometry to (0,0)
 */
function recenterGeometry(segments: DXFSegment[]): { 
  recentered: DXFSegment[]; 
  center: { x: number; y: number };
  boundingBox: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
} {
  if (segments.length === 0) {
    return {
      recentered: [],
      center: { x: 0, y: 0 },
      boundingBox: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
    };
  }

  // Calculate bounding box
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (const seg of segments) {
    minX = Math.min(minX, seg.startX, seg.endX);
    minY = Math.min(minY, seg.startY, seg.endY);
    maxX = Math.max(maxX, seg.startX, seg.endX);
    maxY = Math.max(maxY, seg.startY, seg.endY);
  }

  // Calculate center
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // Recenter all segments
  const recentered = segments.map(seg => ({
    ...seg,
    startX: seg.startX - cx,
    startY: seg.startY - cy,
    endX: seg.endX - cx,
    endY: seg.endY - cy
  }));

  return {
    recentered,
    center: { x: cx, y: cy },
    boundingBox: {
      minX: minX - cx,
      minY: minY - cy,
      maxX: maxX - cx,
      maxY: maxY - cy,
      width: maxX - minX,
      height: maxY - minY
    }
  };
}

/**
 * Step 3: Merge colinear segments with coincident endpoints
 * This is the critical step that combines fragmented DXF lines into logical walls
 */
function mergeColinearSegments(segments: DXFSegment[]): NormalizedSegment[] {
  if (segments.length === 0) return [];

  // Convert to normalized segments with precomputed length and angle
  const normalized: NormalizedSegment[] = segments.map(seg => ({
    ...seg,
    length: calculateLength(seg),
    angle: calculateAngle(seg)
  }));

  // Group segments by angle (colinearity)
  const angleGroups: Map<number, NormalizedSegment[]> = new Map();
  
  for (const seg of normalized) {
    // Round angle to group similar angles
    const angleKey = Math.round(seg.angle / ANGLE_TOLERANCE) * ANGLE_TOLERANCE;
    
    if (!angleGroups.has(angleKey)) {
      angleGroups.set(angleKey, []);
    }
    angleGroups.get(angleKey)!.push(seg);
  }

  const merged: NormalizedSegment[] = [];

  // Process each angle group
  for (const [, group] of angleGroups) {
    // Within each angle group, find chains of connected segments
    const chains = findConnectedChains(group);
    
    // Merge each chain into a single segment
    for (const chain of chains) {
      if (chain.length === 1) {
        merged.push(chain[0]);
      } else {
        const mergedSeg = mergeChain(chain);
        merged.push(mergedSeg);
      }
    }
  }

  return merged;
}

/**
 * Find connected chains of colinear segments
 */
function findConnectedChains(segments: NormalizedSegment[]): NormalizedSegment[][] {
  if (segments.length === 0) return [];
  if (segments.length === 1) return [[segments[0]]];

  const used = new Set<number>();
  const chains: NormalizedSegment[][] = [];

  for (let i = 0; i < segments.length; i++) {
    if (used.has(i)) continue;

    const chain: NormalizedSegment[] = [segments[i]];
    used.add(i);

    // Grow chain in both directions
    let changed = true;
    while (changed) {
      changed = false;

      const chainStart = chain[0];
      const chainEnd = chain[chain.length - 1];

      for (let j = 0; j < segments.length; j++) {
        if (used.has(j)) continue;

        const candidate = segments[j];

        // Check if candidate connects to start of chain
        if (pointsCoincide(candidate.endX, candidate.endY, chainStart.startX, chainStart.startY) ||
            pointsCoincide(candidate.startX, candidate.startY, chainStart.startX, chainStart.startY)) {
          // Ensure proper orientation
          if (pointsCoincide(candidate.startX, candidate.startY, chainStart.startX, chainStart.startY)) {
            // Flip candidate
            chain.unshift({
              ...candidate,
              startX: candidate.endX,
              startY: candidate.endY,
              endX: candidate.startX,
              endY: candidate.startY
            });
          } else {
            chain.unshift(candidate);
          }
          used.add(j);
          changed = true;
        }
        // Check if candidate connects to end of chain
        else if (pointsCoincide(candidate.startX, candidate.startY, chainEnd.endX, chainEnd.endY) ||
                 pointsCoincide(candidate.endX, candidate.endY, chainEnd.endX, chainEnd.endY)) {
          // Ensure proper orientation
          if (pointsCoincide(candidate.endX, candidate.endY, chainEnd.endX, chainEnd.endY)) {
            // Flip candidate
            chain.push({
              ...candidate,
              startX: candidate.endX,
              startY: candidate.endY,
              endX: candidate.startX,
              endY: candidate.startY
            });
          } else {
            chain.push(candidate);
          }
          used.add(j);
          changed = true;
        }
      }
    }

    chains.push(chain);
  }

  return chains;
}

/**
 * Merge a chain of connected segments into one
 */
function mergeChain(chain: NormalizedSegment[]): NormalizedSegment {
  if (chain.length === 0) throw new Error('Cannot merge empty chain');
  if (chain.length === 1) return chain[0];

  // The merged segment goes from start of first to end of last
  const first = chain[0];
  const last = chain[chain.length - 1];

  const merged: NormalizedSegment = {
    startX: first.startX,
    startY: first.startY,
    endX: last.endX,
    endY: last.endY,
    layerName: first.layerName,
    length: 0,
    angle: 0
  };

  merged.length = calculateLength(merged);
  merged.angle = calculateAngle(merged);

  return merged;
}

/**
 * Step 4: Build topology graph (detect L, T, X junctions)
 */
function buildTopologyGraph(segments: NormalizedSegment[]): WallGraph {
  if (segments.length === 0) {
    return { nodes: [], edges: [] };
  }

  // Map of point key -> list of segment indices and which end (start/end)
  const pointMap = new Map<string, { segIndex: number; isStart: boolean; x: number; y: number }[]>();

  const getPointKey = (x: number, y: number): string => {
    const rx = Math.round(x / POINT_TOLERANCE) * POINT_TOLERANCE;
    const ry = Math.round(y / POINT_TOLERANCE) * POINT_TOLERANCE;
    return `${rx},${ry}`;
  };

  // Collect all endpoints
  segments.forEach((seg, idx) => {
    const startKey = getPointKey(seg.startX, seg.startY);
    const endKey = getPointKey(seg.endX, seg.endY);

    if (!pointMap.has(startKey)) pointMap.set(startKey, []);
    pointMap.get(startKey)!.push({ segIndex: idx, isStart: true, x: seg.startX, y: seg.startY });

    if (!pointMap.has(endKey)) pointMap.set(endKey, []);
    pointMap.get(endKey)!.push({ segIndex: idx, isStart: false, x: seg.endX, y: seg.endY });
  });

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let nodeId = 0;

  // Create edges from segments
  const segmentToEdge: Map<number, string> = new Map();
  segments.forEach((seg, idx) => {
    const edgeId = `edge-${idx}`;
    segmentToEdge.set(idx, edgeId);
    edges.push({
      id: edgeId,
      startNodeId: '', // Will be filled in
      endNodeId: '',
      startX: seg.startX,
      startY: seg.startY,
      endX: seg.endX,
      endY: seg.endY,
      length: seg.length,
      angle: seg.angle,
      layerName: seg.layerName
    });
  });

  // Create nodes from unique points
  pointMap.forEach((connections, key) => {
    const connCount = connections.length;
    
    // Determine node type
    let type: 'L' | 'T' | 'X' | 'end';
    if (connCount === 1) {
      type = 'end';
    } else if (connCount === 2) {
      type = 'L';
    } else if (connCount === 3) {
      type = 'T';
    } else {
      type = 'X';
    }

    // Average position of connected endpoints
    const avgX = connections.reduce((sum, c) => sum + c.x, 0) / connections.length;
    const avgY = connections.reduce((sum, c) => sum + c.y, 0) / connections.length;

    const node: GraphNode = {
      id: `node-${nodeId++}`,
      x: avgX,
      y: avgY,
      type,
      connectedEdgeIds: connections.map(c => segmentToEdge.get(c.segIndex)!),
      angles: connections.map(c => {
        const seg = segments[c.segIndex];
        // Get angle pointing away from this node
        if (c.isStart) {
          return Math.atan2(seg.endY - seg.startY, seg.endX - seg.startX);
        } else {
          return Math.atan2(seg.startY - seg.endY, seg.startX - seg.endX);
        }
      })
    };

    nodes.push(node);

    // Update edge node references
    connections.forEach(c => {
      const edge = edges.find(e => e.id === segmentToEdge.get(c.segIndex));
      if (edge) {
        if (c.isStart) {
          edge.startNodeId = node.id;
        } else {
          edge.endNodeId = node.id;
        }
      }
    });
  });

  return { nodes, edges };
}

/**
 * Main normalization function - orchestrates the entire pipeline
 */
export function normalizeWalls(rawSegments: DXFSegment[]): NormalizationResult {
  const originalCount = rawSegments.length;

  // Step 1: Remove noise
  const { cleaned, removedCount } = removeNoise(rawSegments);

  // Step 2: Recenter to (0,0)
  const { recentered, center, boundingBox } = recenterGeometry(cleaned);

  // Step 3: Merge colinear segments
  const mergedSegments = mergeColinearSegments(recentered);

  // Step 4: Build topology graph
  const graph = buildTopologyGraph(mergedSegments);

  // Calculate total length
  const totalLengthMM = mergedSegments.reduce((sum, seg) => sum + seg.length, 0);

  // Count junction types
  const junctionCounts = {
    L: graph.nodes.filter(n => n.type === 'L').length,
    T: graph.nodes.filter(n => n.type === 'T').length,
    X: graph.nodes.filter(n => n.type === 'X').length,
    end: graph.nodes.filter(n => n.type === 'end').length
  };

  // Convert recentered segments to normalized format
  const segments: NormalizedSegment[] = recentered.map(seg => ({
    ...seg,
    length: calculateLength(seg),
    angle: calculateAngle(seg)
  }));

  return {
    segments,
    mergedSegments,
    graph,
    stats: {
      originalCount,
      removedNoise: removedCount,
      mergedCount: originalCount - removedCount - mergedSegments.length,
      finalCount: mergedSegments.length,
      totalLengthMM,
      junctionCounts
    },
    center,
    boundingBox
  };
}

/**
 * Convert normalized segments back to DXFSegment format for storage
 */
export function toStorageFormat(segments: NormalizedSegment[]): DXFSegment[] {
  return segments.map(seg => ({
    startX: seg.startX,
    startY: seg.startY,
    endX: seg.endX,
    endY: seg.endY,
    layerName: seg.layerName
  }));
}
