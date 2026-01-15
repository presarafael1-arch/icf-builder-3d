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

import { WallSegment, JunctionType, PANEL_WIDTH } from '@/types/icf';

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

export interface ChainsResult {
  chains: WallChain[];
  nodes: ChainNode[];
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
};

// Preset configurations - tuned for architectural DXF files with fragmented geometry
const PRESETS: Record<Exclude<ChainPreset, 'auto'>, Required<Omit<WallChainOptions, 'preset'>>> = {
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

function bridgeGaps(
  segments: WallSegment[],
  opts: { gapTolMm: number; angleTolRad: number; snapTolMm: number }
): WallSegment[] {
  const { gapTolMm, angleTolRad, snapTolMm } = opts;
  if (gapTolMm <= 0) return segments;

  const { nodes, edges } = buildGraph(segments, snapTolMm);
  const degree1 = [...nodes.values()].filter((n) => n.edges.length === 1);
  if (degree1.length < 2) return segments;

  const gap2 = gapTolMm * gapTolMm;

  const extraSegments: WallSegment[] = [];
  for (let i = 0; i < degree1.length; i++) {
    for (let j = i + 1; j < degree1.length; j++) {
      const a = degree1[i];
      const b = degree1[j];
      const d2 = dist2(a.x, a.y, b.x, b.y);
      if (d2 > gap2) continue;

      const ea = edges.get(a.edges[0]);
      const eb = edges.get(b.edges[0]);
      if (!ea || !eb) continue;

      const bridgeAngle = calculateNormalizedAngle({ startX: a.x, startY: a.y, endX: b.x, endY: b.y });
      if (!anglesColinear(ea.angle, bridgeAngle, angleTolRad)) continue;
      if (!anglesColinear(eb.angle, bridgeAngle, angleTolRad)) continue;

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

  if (extraSegments.length === 0) return segments;

  const combined = [...segments, ...extraSegments].map((s) => ({
    ...s,
    length: calculateLength(s),
    angle: calculateNormalizedAngle(s),
  }));

  return dedupSegments(combined);
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

export function getPresetOptions(preset: ChainPreset): Required<Omit<WallChainOptions, 'preset'>> {
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

  // 6) Gap bridging
  const afterGaps = bridgeGaps(afterJogs, { gapTolMm: opts.gapTolMm, angleTolRad, snapTolMm: opts.snapTolMm });

  // 7) Graph build + reduction
  const graph = buildGraph(afterGaps, opts.snapTolMm);
  reduceGraphColinear(graph, angleTolRad);

  // 8) Convert reduced edges to chains
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
  });

  return {
    chains,
    nodes,
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
  console.log('[WallChains] Auto-tune selected:', best.preset, 'with score:', best.score.toFixed(3));
  
  // If still bad (wastePct > 15%), log warning
  if (best.result.stats.wastePct > 0.15) {
    console.warn('[WallChains] Warning: Best preset still has high waste. Consider manual geometry cleanup.');
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
      wasteMm: 0,
    };
  }

  return {
    panelsPerFiada: fullPanels + 1,
    hasCut: true,
    cutLengthMm: remainder,
    wasteMm: PANEL_WIDTH - remainder,
  };
}

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
  let panelsPerFiada = 0;
  let cutsPerFiada = 0;
  let wastePerFiadaMm = 0;

  chains.forEach((chain) => {
    const result = calculatePanelsForChain(chain.lengthMm);
    panelsPerFiada += result.panelsPerFiada;
    if (result.hasCut) {
      cutsPerFiada++;
      wastePerFiadaMm += result.wasteMm;
    }
  });

  const panelsTotal = panelsPerFiada * numFiadas;
  const cutsTotal = cutsPerFiada * numFiadas;
  const wasteTotal = wastePerFiadaMm * numFiadas;

  const totalLengthMm = stats.totalLengthMm;
  const wastePct = totalLengthMm > 0 ? wastePerFiadaMm / totalLengthMm : 0;

  // Reference expected panels (no fragmentation / one big chain)
  const expectedPanelsApprox = Math.ceil(totalLengthMm / PANEL_WIDTH) * numFiadas;

  // Tarugos (base: 2 per panel)
  const tarugosBase = panelsTotal * 2;

  // L: -1, T: +1, X: +2 (per fiada)
  const adjustmentPerFiada = junctionCounts.L * -1 + junctionCounts.T * 1 + junctionCounts.X * 2;
  const tarugosAdjustments = adjustmentPerFiada * numFiadas;
  const tarugosTotal = tarugosBase + tarugosAdjustments;

  // Injection tarugos (default 1 per panel)
  const tarugosInjection = panelsTotal;

  // Webs per panel (discrete: 10cm=4, 15cm=3, 20cm=2)
  const websPerPanel = rebarSpacingCm === 10 ? 4 : rebarSpacingCm === 15 ? 3 : 2;
  const websTotal = panelsTotal * websPerPanel;

  // Grids (stabilization) - 3m units
  const totalLengthM = totalLengthMm / 1000;
  const gridsPerFiada = Math.ceil(totalLengthM / 3);

  const gridRows: number[] = [];
  if (gridSettings.base) gridRows.push(0);
  if (gridSettings.mid && numFiadas > 2) gridRows.push(Math.round(numFiadas / 2) - 1);
  if (gridSettings.top && numFiadas > 1) gridRows.push(numFiadas - 1);

  const uniqueGridRows = Array.from(new Set(gridRows)).sort((a, b) => a - b);
  const gridsTotal = gridsPerFiada * uniqueGridRows.length;

  // Topos
  const topoWidthM = concreteThicknessMm / 1000;
  const tTopo = junctionCounts.T * Math.floor(numFiadas / 2);
  const xTopo = junctionCounts.X * Math.floor(numFiadas / 2);
  const cornerTopo = cornerMode === 'topo' ? junctionCounts.L * numFiadas : 0;

  const toposUnits = tTopo + xTopo + cornerTopo;
  const toposMeters = toposUnits * topoWidthM;

  return {
    panelsCount: panelsTotal,
    panelsPerFiada,

    cutsCount: cutsTotal,
    wasteTotal,
    wastePct,

    tarugosBase,
    tarugosAdjustments,
    tarugosTotal,
    tarugosInjection,

    websPerPanel,
    websTotal,

    gridsPerFiada,
    gridsTotal,
    gridRows: uniqueGridRows,

    toposUnits,
    toposMeters,
    toposByReason: {
      tJunction: tTopo,
      xJunction: xTopo,
      openings: 0,
      corners: cornerTopo,
    },

    numberOfRows: numFiadas,
    totalWallLength: totalLengthMm,
    junctionCounts,
    chainsCount: stats.chainsCount,

    expectedPanelsApprox,
    roundingWasteMmPerFiada: wastePerFiadaMm,
  };
}
