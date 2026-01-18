// Wall Chains Module for OMNI ICF WALLS 3D PLANNER
//
// Goal: consolidate fragmented DXF wall segments into *logical* straight runs (chains)
// so BOM and 3D panel placement do not overcount due to per-segment ceil().
//
// Features:
// - Tolerance presets (conservative, normal, aggressive)
// - Auto-tuning based on wastePct
// - Jog simplification for micro-breaks
// - Robust snapping, gap bridging, graph reduction
// - Opening candidate detection from gaps

import { WallSegment, JunctionType, PANEL_WIDTH, PANEL_HEIGHT } from '@/types/icf';
import { OpeningCandidate, generateCandidateLabel } from '@/types/openings';

export interface WallChain {
  id: string;
  segments: WallSegment[]; // original segments merged into this chain (debug)
  lengthMm: number;
  angle: number; // normalized [0, π)
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

// Gap detected during bridging - potential opening candidate
interface DetectedGap {
  chainId: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  widthMm: number;
  angle: number;
  distAlongChain: number;
}

export interface ChainsResult {
  chains: WallChain[];
  nodes: ChainNode[];
  candidates: OpeningCandidate[]; // Detected opening candidates from gaps
  stats: {
    originalSegments: number;
    afterNoiseFilter: number;
    afterSnapSegments: number;
    afterDedupSegments: number;
    afterGraphReduceChains: number;

    chainsCount: number;
    reductionPercent: number;
    totalLengthMm: number;
    minChainLengthMm: number;
    maxChainLengthMm: number;
    avgChainLengthMm: number;

    // merge diagnostics
    snapTolMm: number;
    gapTolMm: number;
    angleTolDeg: number;
    noiseMinMm: number;
    jogMaxMm: number;
    preset: ChainPreset;

    // waste diagnostics
    wastePct: number;
    wastePerFiadaMm: number;
    
    // candidates
    candidatesDetected: number;
  };
  junctionCounts: {
    L: number;
    T: number;
    X: number;
    end: number;
  };
}

export type ChainPreset = 'conservative' | 'normal' | 'aggressive' | 'auto';

export type WallChainOptions = {
  snapTolMm?: number;
  gapTolMm?: number;
  angleTolDeg?: number;
  noiseMinMm?: number;
  jogMaxMm?: number; // max jog length to simplify
  snapOrthogonal?: boolean;
  preset?: ChainPreset;
  detectCandidates?: boolean; // Enable opening candidate detection
  candidateMinWidthMm?: number; // Min gap width to consider as opening (default 450)
  candidateMaxWidthMm?: number; // Max gap width to consider as opening (default 4000)
};

// Preset configurations - tuned for architectural DXF files with fragmented geometry
const PRESETS: Record<Exclude<ChainPreset, 'auto'>, Required<Omit<WallChainOptions, 'preset' | 'detectCandidates' | 'candidateMinWidthMm' | 'candidateMaxWidthMm'>>> = {
  conservative: {
    snapTolMm: 10,
    gapTolMm: 20,
    angleTolDeg: 3,
    noiseMinMm: 80,
    jogMaxMm: 80,
    snapOrthogonal: true,
  },
  normal: {
    snapTolMm: 25,
    gapTolMm: 50,
    angleTolDeg: 5,
    noiseMinMm: 80,
    jogMaxMm: 150,
    snapOrthogonal: true,
  },
  aggressive: {
    snapTolMm: 40,
    gapTolMm: 100,
    angleTolDeg: 10,
    noiseMinMm: 60,
    jogMaxMm: 300,
    snapOrthogonal: true,
  },
};

const DEFAULTS = PRESETS.normal;

// Opening candidate detection thresholds
const CANDIDATE_MIN_WIDTH_MM = 450;  // Ignore gaps smaller than this (noise)
const CANDIDATE_MAX_WIDTH_MM = 4000; // Ignore gaps larger than this (not openings)

// =============== math helpers ===============

function calculateLength(seg: { startX: number; startY: number; endX: number; endY: number }): number {
  const dx = seg.endX - seg.startX;
  const dy = seg.endY - seg.startY;
  return Math.sqrt(dx * dx + dy * dy);
}

function normalizeAngleRad(angle: number): number {
  let a = angle;
  if (a < 0) a += Math.PI;
  if (a >= Math.PI) a -= Math.PI;
  return a;
}

function calculateNormalizedAngle(seg: { startX: number; startY: number; endX: number; endY: number }): number {
  const dx = seg.endX - seg.startX;
  const dy = seg.endY - seg.startY;
  return normalizeAngleRad(Math.atan2(dy, dx));
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function anglesColinear(a1: number, a2: number, tolRad: number): boolean {
  let diff = Math.abs(a1 - a2);
  if (diff > Math.PI / 2) diff = Math.PI - diff;
  return diff <= tolRad;
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(dist2(ax, ay, bx, by));
}

// =============== snapping via spatial hash ===============

type SnapCluster = {
  id: number;
  x: number;
  y: number;
  count: number;
};

function cellKey(x: number, y: number, cellSize: number): string {
  const cx = Math.floor(x / cellSize);
  const cy = Math.floor(y / cellSize);
  return `${cx},${cy}`;
}

function neighborCellKeys(x: number, y: number, cellSize: number): string[] {
  const cx = Math.floor(x / cellSize);
  const cy = Math.floor(y / cellSize);
  const keys: string[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      keys.push(`${cx + dx},${cy + dy}`);
    }
  }
  return keys;
}

function snapPoints(points: { x: number; y: number }[], snapTolMm: number): {
  snapped: { x: number; y: number }[];
} {
  const cellSize = Math.max(1, snapTolMm);
  const tol2 = snapTolMm * snapTolMm;

  const clusters: SnapCluster[] = [];
  const grid = new Map<string, number[]>();

  const snapped: { x: number; y: number }[] = [];

  for (const p of points) {
    let bestClusterId: number | null = null;
    let bestD2 = Infinity;

    const keys = neighborCellKeys(p.x, p.y, cellSize);
    for (const k of keys) {
      const candidateIds = grid.get(k);
      if (!candidateIds) continue;
      for (const cid of candidateIds) {
        const c = clusters[cid];
        const d2 = dist2(p.x, p.y, c.x, c.y);
        if (d2 <= tol2 && d2 < bestD2) {
          bestD2 = d2;
          bestClusterId = cid;
        }
      }
    }

    if (bestClusterId === null) {
      const id = clusters.length;
      clusters.push({ id, x: p.x, y: p.y, count: 1 });
      const ck = cellKey(p.x, p.y, cellSize);
      if (!grid.has(ck)) grid.set(ck, []);
      grid.get(ck)!.push(id);
      snapped.push({ x: p.x, y: p.y });
      continue;
    }

    const c = clusters[bestClusterId];
    c.x = (c.x * c.count + p.x) / (c.count + 1);
    c.y = (c.y * c.count + p.y) / (c.count + 1);
    c.count += 1;

    snapped.push({ x: c.x, y: c.y });
  }

  return { snapped };
}

function snapOrthogonalSegment(seg: { startX: number; startY: number; endX: number; endY: number }, angleTolRad: number) {
  const dx = seg.endX - seg.startX;
  const dy = seg.endY - seg.startY;
  const a = Math.atan2(dy, dx);

  if (Math.abs(Math.sin(a)) <= Math.sin(angleTolRad)) {
    return { ...seg, endY: seg.startY };
  }
  if (Math.abs(Math.cos(a)) <= Math.sin(angleTolRad)) {
    return { ...seg, endX: seg.startX };
  }

  return seg;
}

// =============== dedup / overlap merge ===============

function segKey(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const p1 = `${Math.round(a.x)},${Math.round(a.y)}`;
  const p2 = `${Math.round(b.x)},${Math.round(b.y)}`;
  return [p1, p2].sort().join('|');
}

function dedupSegments(segments: WallSegment[]): WallSegment[] {
  const seen = new Set<string>();
  const out: WallSegment[] = [];

  for (const s of segments) {
    const key = segKey({ x: s.startX, y: s.startY }, { x: s.endX, y: s.endY });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }

  return out;
}

function mergeAxisAlignedOverlaps(segments: WallSegment[], tol: { angleTolRad: number; lineTolMm: number }): WallSegment[] {
  const angleTolRad = tol.angleTolRad;
  const lineTolMm = tol.lineTolMm;

  const horizontals: WallSegment[] = [];
  const verticals: WallSegment[] = [];
  const others: WallSegment[] = [];

  for (const s of segments) {
    const dx = s.endX - s.startX;
    const dy = s.endY - s.startY;
    const a = Math.atan2(dy, dx);

    if (Math.abs(dy) <= lineTolMm && Math.abs(Math.sin(a)) <= Math.sin(angleTolRad)) horizontals.push(s);
    else if (Math.abs(dx) <= lineTolMm && Math.abs(Math.cos(a)) <= Math.sin(angleTolRad)) verticals.push(s);
    else others.push(s);
  }

  const merged: WallSegment[] = [];

  const mergeIntervals = (
    segs: WallSegment[],
    kind: 'h' | 'v'
  ) => {
    const groups = new Map<string, WallSegment[]>();

    for (const s of segs) {
      const key = kind === 'h' ? String(Math.round(s.startY / lineTolMm)) : String(Math.round(s.startX / lineTolMm));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }

    groups.forEach((group) => {
      type Interval = { min: number; max: number; fixed: number; segs: WallSegment[] };
      const intervals: Interval[] = group.map((s) => {
        if (kind === 'h') {
          const y = (s.startY + s.endY) / 2;
          const min = Math.min(s.startX, s.endX);
          const max = Math.max(s.startX, s.endX);
          return { min, max, fixed: y, segs: [s] };
        }
        const x = (s.startX + s.endX) / 2;
        const min = Math.min(s.startY, s.endY);
        const max = Math.max(s.startY, s.endY);
        return { min, max, fixed: x, segs: [s] };
      });

      intervals.sort((a, b) => a.min - b.min);

      const out: Interval[] = [];
      for (const it of intervals) {
        const last = out[out.length - 1];
        if (!last) {
          out.push(it);
          continue;
        }
        const sameLine = Math.abs(last.fixed - it.fixed) <= lineTolMm;
        const overlapsOrTouches = it.min <= last.max + lineTolMm;
        if (sameLine && overlapsOrTouches) {
          last.max = Math.max(last.max, it.max);
          last.segs.push(...it.segs);
        } else {
          out.push(it);
        }
      }

      out.forEach((it, idx) => {
        const id = `merged-${kind}-${idx}-${Math.round(it.fixed)}`;
        if (kind === 'h') {
          merged.push({
            id,
            projectId: it.segs[0].projectId,
            startX: it.min,
            startY: it.fixed,
            endX: it.max,
            endY: it.fixed,
            layerName: it.segs[0].layerName,
            length: Math.abs(it.max - it.min),
            angle: 0,
          });
        } else {
          merged.push({
            id,
            projectId: it.segs[0].projectId,
            startX: it.fixed,
            startY: it.min,
            endX: it.fixed,
            endY: it.max,
            layerName: it.segs[0].layerName,
            length: Math.abs(it.max - it.min),
            angle: Math.PI / 2,
          });
        }
      });
    });
  };

  mergeIntervals(horizontals, 'h');
  mergeIntervals(verticals, 'v');
  merged.push(...others);

  return merged.map((s) => ({
    ...s,
    length: calculateLength(s),
    angle: calculateNormalizedAngle(s),
  }));
}

// =============== jog simplification ===============

function simplifyJogs(segments: WallSegment[], jogMaxMm: number, angleTolRad: number): WallSegment[] {
  if (jogMaxMm <= 0) return segments;
  
  // Find degree-2 nodes where one edge is very short (jog) and the other two are colinear
  // This is a simplified approach - identify short segments that connect two longer colinear segments
  const result = [...segments];
  let changed = true;
  
  while (changed) {
    changed = false;
    
    for (let i = 0; i < result.length; i++) {
      const seg = result[i];
      if (seg.length > jogMaxMm) continue;
      
      // Find segments that connect to this short segment's endpoints
      const connectsToStart: number[] = [];
      const connectsToEnd: number[] = [];
      
      for (let j = 0; j < result.length; j++) {
        if (i === j) continue;
        const other = result[j];
        
        const d1 = distance(seg.startX, seg.startY, other.startX, other.startY);
        const d2 = distance(seg.startX, seg.startY, other.endX, other.endY);
        const d3 = distance(seg.endX, seg.endY, other.startX, other.startY);
        const d4 = distance(seg.endX, seg.endY, other.endX, other.endY);
        
        const tol = jogMaxMm * 0.5;
        if (d1 < tol || d2 < tol) connectsToStart.push(j);
        if (d3 < tol || d4 < tol) connectsToEnd.push(j);
      }
      
      // If exactly one segment on each end, and they're colinear, remove the jog
      if (connectsToStart.length === 1 && connectsToEnd.length === 1) {
        const segA = result[connectsToStart[0]];
        const segB = result[connectsToEnd[0]];
        
        if (anglesColinear(segA.angle, segB.angle, angleTolRad)) {
          // Remove the short jog segment
          result.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
  }
  
  return result;
}

// =============== segment intersection detection ===============

/**
 * Finds the intersection point of two line segments if they cross (X-junction).
 * Returns null if segments don't intersect.
 */
function findCrossingIntersection(
  s1: { startX: number; startY: number; endX: number; endY: number },
  s2: { startX: number; startY: number; endX: number; endY: number },
  tol: number = 1
): { x: number; y: number } | null {
  const x1 = s1.startX, y1 = s1.startY, x2 = s1.endX, y2 = s1.endY;
  const x3 = s2.startX, y3 = s2.startY, x4 = s2.endX, y4 = s2.endY;

  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-10) return null; // Parallel or coincident

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

  // Check if intersection is strictly inside both segments (not at endpoints)
  const eps = tol / Math.max(calculateLength(s1), calculateLength(s2), 1);
  if (t > eps && t < 1 - eps && u > eps && u < 1 - eps) {
    const ix = x1 + t * (x2 - x1);
    const iy = y1 + t * (y2 - y1);
    return { x: ix, y: iy };
  }

  return null;
}

/**
 * Checks if a point lies on a segment (not at endpoints).
 * Returns the point if it does, null otherwise.
 */
function pointOnSegment(
  px: number, py: number,
  seg: { startX: number; startY: number; endX: number; endY: number },
  tol: number
): { x: number; y: number } | null {
  const dx = seg.endX - seg.startX;
  const dy = seg.endY - seg.startY;
  const len = Math.sqrt(dx * dx + dy * dy);
  
  if (len < tol) return null;
  
  // Project point onto segment line
  const t = ((px - seg.startX) * dx + (py - seg.startY) * dy) / (len * len);
  
  // Check if projection is strictly inside segment (not at endpoints)
  const eps = tol / len;
  if (t <= eps || t >= 1 - eps) return null;
  
  // Check distance from point to line
  const projX = seg.startX + t * dx;
  const projY = seg.startY + t * dy;
  const distToLine = distance(px, py, projX, projY);
  
  if (distToLine <= tol) {
    return { x: projX, y: projY };
  }
  
  return null;
}

/**
 * Finds T-junction points where an endpoint of one segment touches the middle of another.
 */
function findTJunctionPoints(
  segments: WallSegment[],
  tol: number
): { segIdx: number; point: { x: number; y: number } }[] {
  const tJunctions: { segIdx: number; point: { x: number; y: number } }[] = [];
  
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    
    // Check each endpoint of this segment against all other segments
    for (let j = 0; j < segments.length; j++) {
      if (i === j) continue;
      
      const other = segments[j];
      
      // Check if seg's start point lies on other segment
      const startOnOther = pointOnSegment(seg.startX, seg.startY, other, tol);
      if (startOnOther) {
        tJunctions.push({ segIdx: j, point: startOnOther });
      }
      
      // Check if seg's end point lies on other segment
      const endOnOther = pointOnSegment(seg.endX, seg.endY, other, tol);
      if (endOnOther) {
        tJunctions.push({ segIdx: j, point: endOnOther });
      }
    }
  }
  
  return tJunctions;
}

/**
 * Splits segments at their intersection points to create proper graph nodes.
 * This ensures T and X junctions are detected even when segments cross without
 * sharing endpoints.
 */
function splitSegmentsAtIntersections(segments: WallSegment[], tol: number): WallSegment[] {
  // Find all X-crossing intersection points
  const crossings: { segIdx1: number; segIdx2: number; point: { x: number; y: number } }[] = [];
  
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const pt = findCrossingIntersection(segments[i], segments[j], tol);
      if (pt) {
        crossings.push({ segIdx1: i, segIdx2: j, point: pt });
      }
    }
  }
  
  // Find all T-junction points
  const tJunctions = findTJunctionPoints(segments, tol);
  
  // Group all split points by segment
  const splitPointsBySegment = new Map<number, { x: number; y: number }[]>();
  
  for (const { segIdx1, segIdx2, point } of crossings) {
    if (!splitPointsBySegment.has(segIdx1)) splitPointsBySegment.set(segIdx1, []);
    if (!splitPointsBySegment.has(segIdx2)) splitPointsBySegment.set(segIdx2, []);
    splitPointsBySegment.get(segIdx1)!.push(point);
    splitPointsBySegment.get(segIdx2)!.push(point);
  }
  
  for (const { segIdx, point } of tJunctions) {
    if (!splitPointsBySegment.has(segIdx)) splitPointsBySegment.set(segIdx, []);
    // Check if point already exists (avoid duplicates)
    const existing = splitPointsBySegment.get(segIdx)!;
    const isDuplicate = existing.some(p => distance(p.x, p.y, point.x, point.y) < tol);
    if (!isDuplicate) {
      existing.push(point);
    }
  }

  if (splitPointsBySegment.size === 0) return segments;

  // Split each segment at its intersection points
  const result: WallSegment[] = [];
  
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const splitPoints = splitPointsBySegment.get(i);
    
    if (!splitPoints || splitPoints.length === 0) {
      result.push(seg);
      continue;
    }

    // Sort split points along the segment
    const dx = seg.endX - seg.startX;
    const dy = seg.endY - seg.startY;
    const len = Math.sqrt(dx * dx + dy * dy);
    
    const pointsWithT = splitPoints.map(pt => {
      const t = len > 0 ? ((pt.x - seg.startX) * dx + (pt.y - seg.startY) * dy) / (len * len) : 0;
      return { ...pt, t };
    });
    
    pointsWithT.sort((a, b) => a.t - b.t);

    // Create sub-segments
    let prevX = seg.startX;
    let prevY = seg.startY;
    let subIdx = 0;
    
    for (const pt of pointsWithT) {
      if (distance(prevX, prevY, pt.x, pt.y) > tol) {
        result.push({
          ...seg,
          id: `${seg.id}-sub${subIdx}`,
          startX: prevX,
          startY: prevY,
          endX: pt.x,
          endY: pt.y,
          length: distance(prevX, prevY, pt.x, pt.y),
          angle: calculateNormalizedAngle({ startX: prevX, startY: prevY, endX: pt.x, endY: pt.y }),
        });
        subIdx++;
      }
      prevX = pt.x;
      prevY = pt.y;
    }
    
    // Final sub-segment
    if (distance(prevX, prevY, seg.endX, seg.endY) > tol) {
      result.push({
        ...seg,
        id: `${seg.id}-sub${subIdx}`,
        startX: prevX,
        startY: prevY,
        endX: seg.endX,
        endY: seg.endY,
        length: distance(prevX, prevY, seg.endX, seg.endY),
        angle: calculateNormalizedAngle({ startX: prevX, startY: prevY, endX: seg.endX, endY: seg.endY }),
      });
    }
  }

  return result;
}

// =============== graph reduction ===============

type Edge = {
  id: string;
  a: string;
  b: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  angle: number;
  length: number;
  segments: WallSegment[];
};

type Node = {
  id: string;
  x: number;
  y: number;
  edges: string[];
};

function makeNodeKey(x: number, y: number, tol: number): string {
  const rx = Math.round(x / tol) * tol;
  const ry = Math.round(y / tol) * tol;
  return `${rx},${ry}`;
}

function buildGraph(segments: WallSegment[], snapTolMm: number): { nodes: Map<string, Node>; edges: Map<string, Edge> } {
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();

  const getOrCreateNode = (x: number, y: number): Node => {
    const k = makeNodeKey(x, y, snapTolMm);
    const existing = nodes.get(k);
    if (existing) return existing;
    const n: Node = { id: `n-${nodes.size}`, x, y, edges: [] };
    nodes.set(k, n);
    return n;
  };

  segments.forEach((s, i) => {
    const a = getOrCreateNode(s.startX, s.startY);
    const b = getOrCreateNode(s.endX, s.endY);

    if (a.id === b.id) return;

    const id = `e-${i}`;
    const edge: Edge = {
      id,
      a: a.id,
      b: b.id,
      startX: a.x,
      startY: a.y,
      endX: b.x,
      endY: b.y,
      angle: calculateNormalizedAngle({ startX: a.x, startY: a.y, endX: b.x, endY: b.y }),
      length: calculateLength({ startX: a.x, startY: a.y, endX: b.x, endY: b.y }),
      segments: [s],
    };

    edges.set(id, edge);
    a.edges.push(id);
    b.edges.push(id);
  });

  return { nodes, edges };
}

function otherNodeId(edge: Edge, nodeId: string): string {
  return edge.a === nodeId ? edge.b : edge.a;
}

function reduceGraphColinear(
  graph: { nodes: Map<string, Node>; edges: Map<string, Edge> },
  angleTolRad: number
): void {
  let changed = true;
  let iterations = 0;
  const maxIterations = 1000;

  const nodeById = () => {
    const map = new Map<string, Node>();
    graph.nodes.forEach((n) => map.set(n.id, n));
    return map;
  };

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;
    const byId = nodeById();

    for (const node of byId.values()) {
      if (node.edges.length !== 2) continue;

      const e1 = graph.edges.get(node.edges[0]);
      const e2 = graph.edges.get(node.edges[1]);
      if (!e1 || !e2) continue;

      if (!anglesColinear(e1.angle, e2.angle, angleTolRad)) continue;

      const n1Id = otherNodeId(e1, node.id);
      const n2Id = otherNodeId(e2, node.id);
      if (n1Id === n2Id) continue;

      const n1 = [...graph.nodes.values()].find((n) => n.id === n1Id);
      const n2 = [...graph.nodes.values()].find((n) => n.id === n2Id);
      if (!n1 || !n2) continue;

      const mergedId = `m-${graph.edges.size}`;
      const mergedEdge: Edge = {
        id: mergedId,
        a: n1.id,
        b: n2.id,
        startX: n1.x,
        startY: n1.y,
        endX: n2.x,
        endY: n2.y,
        angle: calculateNormalizedAngle({ startX: n1.x, startY: n1.y, endX: n2.x, endY: n2.y }),
        length: calculateLength({ startX: n1.x, startY: n1.y, endX: n2.x, endY: n2.y }),
        segments: [...e1.segments, ...e2.segments],
      };

      graph.edges.delete(e1.id);
      graph.edges.delete(e2.id);

      const removeEdgeFromNode = (nodeObj: Node, edgeId: string) => {
        nodeObj.edges = nodeObj.edges.filter((id) => id !== edgeId);
      };

      removeEdgeFromNode(n1, e1.id);
      removeEdgeFromNode(n1, e2.id);
      removeEdgeFromNode(n2, e1.id);
      removeEdgeFromNode(n2, e2.id);

      const keyToDelete = [...graph.nodes.entries()].find(([, n]) => n.id === node.id)?.[0];
      if (keyToDelete) graph.nodes.delete(keyToDelete);

      graph.edges.set(mergedId, mergedEdge);
      n1.edges.push(mergedId);
      n2.edges.push(mergedId);

      changed = true;
      break;
    }
  }
}

// Bridge gaps and collect detected gaps for candidate detection
function bridgeGapsWithDetection(
  segments: WallSegment[],
  opts: { gapTolMm: number; angleTolRad: number; snapTolMm: number },
  candidateOpts?: { minWidthMm: number; maxWidthMm: number }
): { segments: WallSegment[]; detectedGaps: DetectedGap[] } {
  const { gapTolMm, angleTolRad, snapTolMm } = opts;
  const detectedGaps: DetectedGap[] = [];
  
  if (gapTolMm <= 0) return { segments, detectedGaps };

  const { nodes, edges } = buildGraph(segments, snapTolMm);
  const degree1 = [...nodes.values()].filter((n) => n.edges.length === 1);
  if (degree1.length < 2) return { segments, detectedGaps };

  // Use a larger gap tolerance for candidate detection
  const candidateGapTol = candidateOpts?.maxWidthMm ?? CANDIDATE_MAX_WIDTH_MM;
  const gap2 = candidateGapTol * candidateGapTol;
  const bridgeGap2 = gapTolMm * gapTolMm;

  const extraSegments: WallSegment[] = [];
  const processedPairs = new Set<string>();
  
  for (let i = 0; i < degree1.length; i++) {
    for (let j = i + 1; j < degree1.length; j++) {
      const a = degree1[i];
      const b = degree1[j];
      const pairKey = [a.id, b.id].sort().join('|');
      if (processedPairs.has(pairKey)) continue;
      processedPairs.add(pairKey);
      
      const d2 = dist2(a.x, a.y, b.x, b.y);
      if (d2 > gap2) continue;

      const ea = edges.get(a.edges[0]);
      const eb = edges.get(b.edges[0]);
      if (!ea || !eb) continue;

      const bridgeAngle = calculateNormalizedAngle({ startX: a.x, startY: a.y, endX: b.x, endY: b.y });
      if (!anglesColinear(ea.angle, bridgeAngle, angleTolRad)) continue;
      if (!anglesColinear(eb.angle, bridgeAngle, angleTolRad)) continue;

      const gapWidth = Math.sqrt(d2);
      const minWidth = candidateOpts?.minWidthMm ?? CANDIDATE_MIN_WIDTH_MM;
      const maxWidth = candidateOpts?.maxWidthMm ?? CANDIDATE_MAX_WIDTH_MM;
      
      // Check if this is a potential opening candidate (larger gap)
      if (gapWidth >= minWidth && gapWidth <= maxWidth) {
        detectedGaps.push({
          chainId: '', // Will be assigned after chains are built
          startX: a.x,
          startY: a.y,
          endX: b.x,
          endY: b.y,
          widthMm: gapWidth,
          angle: bridgeAngle,
          distAlongChain: 0, // Will be calculated later
        });
      }

      // Only bridge small gaps (not potential openings)
      if (d2 <= bridgeGap2) {
        extraSegments.push({
          id: `gap-${i}-${j}`,
          projectId: ea.segments[0]?.projectId ?? 'unknown',
          startX: a.x,
          startY: a.y,
          endX: b.x,
          endY: b.y,
          length: 0,
          angle: 0,
        });
      }
    }
  }

  if (extraSegments.length === 0 && detectedGaps.length === 0) {
    return { segments, detectedGaps };
  }

  const combined = [...segments, ...extraSegments].map((s) => ({
    ...s,
    length: calculateLength(s),
    angle: calculateNormalizedAngle(s),
  }));

  return { segments: dedupSegments(combined), detectedGaps };
}

// =============== waste calculation ===============

function calculateWasteStats(chains: WallChain[]): { wastePct: number; wastePerFiadaMm: number } {
  if (chains.length === 0) return { wastePct: 0, wastePerFiadaMm: 0 };
  
  let wastePerFiadaMm = 0;
  let totalLengthMm = 0;
  
  for (const chain of chains) {
    const remainder = chain.lengthMm % PANEL_WIDTH;
    if (remainder > 0) {
      wastePerFiadaMm += PANEL_WIDTH - remainder;
    }
    totalLengthMm += chain.lengthMm;
  }
  
  const wastePct = totalLengthMm > 0 ? wastePerFiadaMm / totalLengthMm : 0;
  
  return { wastePct, wastePerFiadaMm };
}

// =============== public API ===============

export function getPresetOptions(preset: ChainPreset): Required<Omit<WallChainOptions, 'preset' | 'detectCandidates' | 'candidateMinWidthMm' | 'candidateMaxWidthMm'>> {
  if (preset === 'auto') return PRESETS.normal;
  return PRESETS[preset];
}

export function buildWallChains(walls: WallSegment[], options: WallChainOptions = {}): ChainsResult {
  const presetName = options.preset ?? 'normal';
  const presetOpts = presetName === 'auto' ? PRESETS.normal : PRESETS[presetName];
  
  const opts = {
    ...presetOpts,
    ...options,
    preset: presetName,
  };
  
  const detectCandidates = options.detectCandidates ?? true;
  const candidateMinWidthMm = options.candidateMinWidthMm ?? CANDIDATE_MIN_WIDTH_MM;
  const candidateMaxWidthMm = options.candidateMaxWidthMm ?? CANDIDATE_MAX_WIDTH_MM;
  
  const angleTolRad = degToRad(opts.angleTolDeg);

  const originalSegments = walls.length;

  // 1) Noise filter
  const noiseFiltered = walls.filter((w) => calculateLength(w) >= opts.noiseMinMm);

  // 2) Snap endpoints
  const points: { x: number; y: number }[] = [];
  noiseFiltered.forEach((w) => {
    points.push({ x: w.startX, y: w.startY });
    points.push({ x: w.endX, y: w.endY });
  });

  const snappedPoints = snapPoints(points, opts.snapTolMm).snapped;

  const snappedWalls: WallSegment[] = noiseFiltered.map((w, idx) => {
    const p1 = snappedPoints[idx * 2];
    const p2 = snappedPoints[idx * 2 + 1];

    let seg = {
      ...w,
      startX: p1.x,
      startY: p1.y,
      endX: p2.x,
      endY: p2.y,
    };

    if (opts.snapOrthogonal) {
      seg = {
        ...seg,
        ...snapOrthogonalSegment(seg, angleTolRad),
      } as WallSegment;
    }

    return {
      ...seg,
      length: calculateLength(seg),
      angle: calculateNormalizedAngle(seg),
    };
  });

  // 3) Dedup exact duplicates
  const deduped = dedupSegments(snappedWalls);

  // 4) Best-effort overlap merge for axis-aligned geometry
  const overlapMerged = mergeAxisAlignedOverlaps(deduped, { angleTolRad, lineTolMm: Math.max(1, opts.snapTolMm) });

  // 5) Jog simplification
  const afterJogs = simplifyJogs(overlapMerged, opts.jogMaxMm, angleTolRad);

  // 6) Gap bridging with candidate detection
  const { segments: afterGaps, detectedGaps } = bridgeGapsWithDetection(
    afterJogs, 
    { gapTolMm: opts.gapTolMm, angleTolRad, snapTolMm: opts.snapTolMm },
    detectCandidates ? { minWidthMm: candidateMinWidthMm, maxWidthMm: candidateMaxWidthMm } : undefined
  );

  // 7) Split segments at intersections to detect T/X junctions
  const afterSplit = splitSegmentsAtIntersections(afterGaps, opts.snapTolMm);

  // 8) Graph build + reduction
  const graph = buildGraph(afterSplit, opts.snapTolMm);
  reduceGraphColinear(graph, angleTolRad);

  // 9) Convert reduced edges to chains
  const edgeList = [...graph.edges.values()];

  const chainNodeById = new Map<string, ChainNode>();
  const ensureChainNode = (nodeId: string): ChainNode => {
    const existing = chainNodeById.get(nodeId);
    if (existing) return existing;

    const node = [...graph.nodes.values()].find((n) => n.id === nodeId);
    const cn: ChainNode = {
      id: nodeId,
      x: node?.x ?? 0,
      y: node?.y ?? 0,
      type: 'end',
      connectedChainIds: [],
      angles: [],
    };
    chainNodeById.set(nodeId, cn);
    return cn;
  };

  const chains: WallChain[] = edgeList.map((e, i) => {
    const a = ensureChainNode(e.a);
    const b = ensureChainNode(e.b);

    const chainId = `chain-${i}`;
    a.connectedChainIds.push(chainId);
    b.connectedChainIds.push(chainId);
    a.angles.push(Math.atan2(b.y - a.y, b.x - a.x));
    b.angles.push(Math.atan2(a.y - b.y, a.x - b.x));

    return {
      id: chainId,
      segments: e.segments,
      lengthMm: e.length,
      angle: e.angle,
      startX: a.x,
      startY: a.y,
      endX: b.x,
      endY: b.y,
      startNodeId: a.id,
      endNodeId: b.id,
    };
  });

  // Classify nodes based on degree and angles
  const nodes: ChainNode[] = [...chainNodeById.values()].map((n) => {
    const degree = n.connectedChainIds.length;
    let type: JunctionType = 'end';

    if (degree === 1) type = 'end';
    else if (degree === 2) {
      const a1 = n.angles[0] ?? 0;
      const a2 = n.angles[1] ?? 0;
      const diff = Math.abs(a1 - a2);
      const isStraight = Math.abs(diff - Math.PI) < angleTolRad || diff < angleTolRad;
      type = isStraight ? 'end' : 'L';
    } else if (degree === 3) type = 'T';
    else if (degree >= 4) type = 'X';

    return { ...n, type };
  });

  const junctionCounts = {
    L: nodes.filter((n) => n.type === 'L').length,
    T: nodes.filter((n) => n.type === 'T').length,
    X: nodes.filter((n) => n.type === 'X').length,
    end: nodes.filter((n) => n.type === 'end').length,
  };

  // 10) Build opening candidates from detected gaps
  const candidates: OpeningCandidate[] = [];
  if (detectCandidates && detectedGaps.length > 0) {
    // Match gaps to chains
    for (const gap of detectedGaps) {
      // Find which chain this gap belongs to
      let bestChain: WallChain | null = null;
      let bestDist = Infinity;
      
      const gapCenterX = (gap.startX + gap.endX) / 2;
      const gapCenterY = (gap.startY + gap.endY) / 2;
      
      for (const chain of chains) {
        // Check if gap is colinear with chain
        if (!anglesColinear(gap.angle, chain.angle, angleTolRad)) continue;
        
        // Check if gap center is near the chain line
        const chainDirX = (chain.endX - chain.startX) / chain.lengthMm;
        const chainDirY = (chain.endY - chain.startY) / chain.lengthMm;
        
        // Project gap center onto chain line
        const t = ((gapCenterX - chain.startX) * chainDirX + (gapCenterY - chain.startY) * chainDirY);
        
        // Check if projection is within extended chain bounds
        if (t >= -gap.widthMm && t <= chain.lengthMm + gap.widthMm) {
          const projX = chain.startX + chainDirX * t;
          const projY = chain.startY + chainDirY * t;
          const distToLine = distance(gapCenterX, gapCenterY, projX, projY);
          
          if (distToLine < bestDist && distToLine < 100) { // Within 100mm of chain line
            bestDist = distToLine;
            bestChain = chain;
          }
        }
      }
      
      if (bestChain) {
        // Calculate distance along chain
        const chainDirX = (bestChain.endX - bestChain.startX) / bestChain.lengthMm;
        const chainDirY = (bestChain.endY - bestChain.startY) / bestChain.lengthMm;
        const t = ((gap.startX - bestChain.startX) * chainDirX + (gap.startY - bestChain.startY) * chainDirY);
        
        candidates.push({
          id: `candidate-${candidates.length}`,
          chainId: bestChain.id,
          startDistMm: Math.max(0, t),
          widthMm: gap.widthMm,
          centerX: gapCenterX,
          centerY: gapCenterY,
          angle: bestChain.angle,
          status: 'detected',
          label: generateCandidateLabel(candidates),
          createdFromGap: true,
        });
      }
    }
  }

  const totalLengthMm = chains.reduce((sum, c) => sum + c.lengthMm, 0);
  const lengths = chains.map((c) => c.lengthMm);
  const minLength = lengths.length ? Math.min(...lengths) : 0;
  const maxLength = lengths.length ? Math.max(...lengths) : 0;
  const avgLength = lengths.length ? totalLengthMm / lengths.length : 0;

  const reductionPercent = originalSegments > 0 ? Math.round((1 - chains.length / originalSegments) * 100) : 0;

  // Calculate waste
  const { wastePct, wastePerFiadaMm } = calculateWasteStats(chains);

  const stats = {
    originalSegments,
    afterNoiseFilter: noiseFiltered.length,
    afterSnapSegments: snappedWalls.length,
    afterDedupSegments: deduped.length,
    afterGraphReduceChains: chains.length,

    chainsCount: chains.length,
    reductionPercent,
    totalLengthMm,
    minChainLengthMm: minLength,
    maxChainLengthMm: maxLength,
    avgChainLengthMm: avgLength,

    snapTolMm: opts.snapTolMm,
    gapTolMm: opts.gapTolMm,
    angleTolDeg: opts.angleTolDeg,
    noiseMinMm: opts.noiseMinMm,
    jogMaxMm: opts.jogMaxMm,
    preset: presetName as ChainPreset,

    wastePct,
    wastePerFiadaMm,
    candidatesDetected: candidates.length,
  };

  console.log('[WallChains] Stats:', {
    originalSegments: stats.originalSegments,
    chainsCount: stats.chainsCount,
    reductionPercent: `${stats.reductionPercent}%`,
    totalLengthM: (stats.totalLengthMm / 1000).toFixed(2),
    avgChainM: (stats.avgChainLengthMm / 1000).toFixed(2),
    wastePct: `${(stats.wastePct * 100).toFixed(1)}%`,
    preset: stats.preset,
    junctions: junctionCounts,
    candidates: candidates.length,
  });

  return {
    chains,
    nodes,
    candidates,
    stats,
    junctionCounts,
  };
}

/**
 * Auto-tune: try multiple presets and pick the one with best score
 * Score = wastePct + 0.3 * (chainsCount / originalSegments)
 * Prioritizes lower wastePct while also considering chain reduction
 */
export function buildWallChainsAutoTuned(walls: WallSegment[]): ChainsResult & { triedPresets: ChainPreset[]; bestPreset: ChainPreset } {
  if (walls.length === 0) {
    const empty = buildWallChains(walls, { preset: 'normal' });
    return { ...empty, triedPresets: ['normal'], bestPreset: 'normal' };
  }
  
  const presets: Exclude<ChainPreset, 'auto'>[] = ['conservative', 'normal', 'aggressive'];
  const results: { preset: ChainPreset; result: ChainsResult; score: number }[] = [];
  
  for (const preset of presets) {
    const result = buildWallChains(walls, { preset });
    // Lower wastePct = better, fewer chains relative to original = better
    const chainRatio = result.stats.chainsCount / Math.max(1, result.stats.originalSegments);
    const score = result.stats.wastePct + 0.3 * chainRatio;
    results.push({ preset, result, score });
    
    console.log(`[WallChains] Preset ${preset}: chains=${result.stats.chainsCount}, waste=${(result.stats.wastePct*100).toFixed(1)}%, score=${score.toFixed(3)}`);
  }
  
  // Sort by score ascending (lower is better)
  results.sort((a, b) => a.score - b.score);
  
  const best = results[0];
  
  // Enhanced logging with junction counts
  console.log('[WallChains] Auto-tune selected:', best.preset, {
    score: best.score.toFixed(3),
    chains: best.result.stats.chainsCount,
    originalSegments: best.result.stats.originalSegments,
    reductionPct: `${best.result.stats.reductionPercent}%`,
    wastePct: `${(best.result.stats.wastePct * 100).toFixed(1)}%`,
    junctions: best.result.junctionCounts,
  });
  
  // If still bad (wastePct > 15%), log warning
  if (best.result.stats.wastePct > 0.15) {
    console.warn('[WallChains] Warning: Best preset still has high waste. Consider manual geometry cleanup.');
  }
  
  // Warn if no consolidation happened
  if (best.result.stats.reductionPercent === 0) {
    console.warn('[WallChains] Warning: No chain consolidation occurred. Segments may not share endpoints within tolerance.');
  }
  
  return {
    ...best.result,
    stats: {
      ...best.result.stats,
      preset: best.preset,
    },
    triedPresets: presets,
    bestPreset: best.preset,
  };
}

/**
 * Calculate full panels and remainder for a single chain
 */
export function calculateChainPanels(chain: WallChain): { fullPanels: number; remainderMm: number } {
  const fullPanels = Math.floor(chain.lengthMm / PANEL_WIDTH);
  const remainderMm = chain.lengthMm % PANEL_WIDTH;
  return { fullPanels, remainderMm };
}

/**
 * Calculate total panels for all chains (simple approach, no bin packing)
 */
export function calculateTotalPanels(chains: WallChain[]): {
  totalFullPanels: number;
  totalCutPanels: number;
  totalPanels: number;
  remainders: number[];
} {
  let totalFullPanels = 0;
  const remainders: number[] = [];
  
  for (const chain of chains) {
    const { fullPanels, remainderMm } = calculateChainPanels(chain);
    totalFullPanels += fullPanels;
    if (remainderMm > 0) {
      remainders.push(remainderMm);
    }
  }
  
  // Simple: each remainder needs one cut panel
  const totalCutPanels = remainders.length;
  
  return {
    totalFullPanels,
    totalCutPanels,
    totalPanels: totalFullPanels + totalCutPanels,
    remainders,
  };
}

/**
 * Calculate BOM from chains result - used by icf-calculations.ts
 */
export function calculateBOMFromChains(
  chainsResult: ChainsResult,
  numberOfRows: number,
  rebarSpacingCm: 10 | 15 | 20,
  concreteThicknessMm: number,
  cornerMode: 'overlap_cut' | 'topo',
  gridSettings: { base: boolean; mid: boolean; top: boolean }
): {
  panelsCount: number;
  panelsPerFiada: number;
  tarugosBase: number;
  tarugosAdjustments: number;
  tarugosTotal: number;
  tarugosInjection: number;
  toposUnits: number;
  toposMeters: number;
  toposByReason: { tJunction: number; xJunction: number; openings: number; corners: number };
  websTotal: number;
  websPerPanel: number;
  gridsTotal: number;
  gridsPerFiada: number;
  gridRows: number[];
  cutsCount: number;
  wasteTotal: number;
  numberOfRows: number;
  totalWallLength: number;
  junctionCounts: { L: number; T: number; X: number; end: number };
  chainsCount: number;
  wastePct: number;
  expectedPanelsApprox: number;
} {
  const { chains, junctionCounts, stats } = chainsResult;
  
  // Calculate panels per fiada
  const { totalFullPanels, totalCutPanels, totalPanels, remainders } = calculateTotalPanels(chains);
  const panelsPerFiada = totalPanels;
  const panelsCount = panelsPerFiada * numberOfRows;
  
  // Tarugos
  const tarugosBase = panelsCount * 2;
  const adjustmentPerFiada = (junctionCounts.L * -1) + (junctionCounts.T * 1) + (junctionCounts.X * 2);
  const tarugosAdjustments = adjustmentPerFiada * numberOfRows;
  const tarugosTotal = Math.max(0, tarugosBase + tarugosAdjustments);
  const tarugosInjection = panelsCount;
  
  // Webs
  const websPerPanel = rebarSpacingCm === 10 ? 4 : rebarSpacingCm === 15 ? 3 : 2;
  const websTotal = panelsCount * websPerPanel;
  
  // Grids
  const totalLengthM = stats.totalLengthMm / 1000;
  const gridsPerFiada = Math.ceil(totalLengthM / 3);
  const gridRows: number[] = [];
  if (gridSettings.base) gridRows.push(0);
  if (gridSettings.mid && numberOfRows > 2) gridRows.push(Math.floor(numberOfRows / 2));
  if (gridSettings.top && numberOfRows > 1) gridRows.push(numberOfRows - 1);
  const uniqueGridRows = Array.from(new Set(gridRows)).sort((a, b) => a - b);
  const gridsTotal = gridsPerFiada * uniqueGridRows.length;
  
  // Topos (T/X/corners)
  const numTipo2Fiadas = Math.floor(numberOfRows / 2);
  const tTopo = junctionCounts.T * numTipo2Fiadas;
  const xTopo = junctionCounts.X * numTipo2Fiadas;
  const cornerTopo = cornerMode === 'topo' ? junctionCounts.L * numTipo2Fiadas : 0;
  const toposUnits = tTopo + xTopo + cornerTopo;
  const toposMeters = toposUnits * 0.4;
  
  // Waste
  const wasteTotal = stats.wastePerFiadaMm * numberOfRows;
  const cutsCount = totalCutPanels * numberOfRows;
  
  // Expected panels (theoretical minimum)
  const expectedPanelsApprox = Math.ceil(stats.totalLengthMm / PANEL_WIDTH) * numberOfRows;
  
  return {
    panelsCount,
    panelsPerFiada,
    tarugosBase,
    tarugosAdjustments,
    tarugosTotal,
    tarugosInjection,
    toposUnits,
    toposMeters,
    toposByReason: {
      tJunction: tTopo,
      xJunction: xTopo,
      openings: 0,
      corners: cornerTopo,
    },
    websTotal,
    websPerPanel,
    gridsTotal,
    gridsPerFiada,
    gridRows: uniqueGridRows,
    cutsCount,
    wasteTotal,
    numberOfRows,
    totalWallLength: stats.totalLengthMm,
    junctionCounts,
    chainsCount: chains.length,
    wastePct: stats.wastePct,
    expectedPanelsApprox,
  };
}
