/**
 * ExternalEngineRenderer - External Engine 3D Render
 * 
 * Renders walls as dual-skin panels (exterior + interior) separated by concrete core.
 * Supports both panel-level rendering (when panels[] exists) and wall-level fallback.
 * 
 * Features:
 * - Dual skin geometry: EXT skin + INT skin, separated by core thickness
 * - Panel colors: FULL=yellow, CUT=red
 * - Exterior detection using footprint polygon (robust)
 * - Blue overlay stripes ONLY on exterior face of exterior walls
 * - Interior walls: white/gray on both faces
 * - Per-panel outlines with EdgesGeometry
 */

import { useMemo, useRef, useState, useEffect } from 'react';
import * as THREE from 'three';
import { ThreeEvent } from '@react-three/fiber';
import { Text, Html, Line } from '@react-three/drei';
import { NormalizedExternalAnalysis, GraphWall, Course, GraphNode, EnginePanel, Vec3 } from '@/types/external-engine';
import { buildWallChainsAutoTuned } from '@/lib/wall-chains';
import { WallSegment } from '@/types/icf';

interface ExternalEngineRendererProps {
  normalizedAnalysis: NormalizedExternalAnalysis;
  selectedWallId: string | null;
  onWallClick?: (wallId: string) => void;
  showCourseMarkers?: boolean;
  showShiftArrows?: boolean;
}

// ===== Point Format Helpers =====

function px(p: unknown): number | undefined {
  if (p == null) return undefined;
  if (Array.isArray(p)) return typeof p[0] === 'number' ? p[0] : undefined;
  if (typeof p === 'object') {
    const obj = p as Record<string, unknown>;
    if (typeof obj.x === 'number') return obj.x;
    if (typeof obj['0'] === 'number') return obj['0'];
  }
  return undefined;
}

function py(p: unknown): number | undefined {
  if (p == null) return undefined;
  if (Array.isArray(p)) return typeof p[1] === 'number' ? p[1] : undefined;
  if (typeof p === 'object') {
    const obj = p as Record<string, unknown>;
    if (typeof obj.y === 'number') return obj.y;
    if (typeof obj['1'] === 'number') return obj['1'];
  }
  return undefined;
}

function toVec2(p: unknown): { x: number; y: number } {
  return { x: px(p) ?? 0, y: py(p) ?? 0 };
}

function isValidPt(p: unknown): boolean {
  if (p == null) return false;
  if (Array.isArray(p)) return p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number';
  if (typeof p === 'object') {
    const obj = p as Record<string, unknown>;
    return (typeof obj.x === 'number' && typeof obj.y === 'number') ||
           (typeof obj['0'] === 'number' && typeof obj['1'] === 'number');
  }
  return false;
}

function filterValidPoints(points: unknown[]): { x: number; y: number }[] {
  if (!Array.isArray(points)) return [];
  return points.filter(isValidPt).map(toVec2);
}

// ===== Colors =====
const COLORS = {
  PANEL_FULL: 0xffc107,       // Yellow for FULL panels
  PANEL_CUT: 0xf44336,        // Red for CUT panels
  STRIPE_EXTERIOR: '#3B82F6', // Blue stripe for exterior walls
  STRIPE_INTERIOR: '#FFFFFF', // White stripe for interior walls
  OUTLINE: 0x333333,          // Dark outline
  COURSE_LINE: 0x555555,      // Course line color
  NODE: 0x4caf50,             // Green for nodes
  SELECTED: 0x00bcd4,         // Cyan for selected
};

// Skin/EPS thickness (1 TOOTH ≈ 70.6mm)
const EPS_THICKNESS = 0.0706; // meters
const DEFAULT_CORE_THICKNESS = 0.15; // 150mm default

// Stripe dimensions (aligned with internal engine)
const STRIPE_WIDTH = 0.1;         // 100mm width
const STRIPE_HEIGHT_RATIO = 0.85; // 85% of course height
const STRIPE_OFFSET = 0.002;      // 2mm offset from surface to avoid z-fighting


// ===== Building Footprint Calculation (Concave outer polygon; NO convex hull) =====

interface Point2D {
  x: number;
  y: number;
}

type PtKey = string;

function quantizeKey(p: Point2D, tol = 0.01): PtKey {
  // tol default 10mm in meters
  const qx = Math.round(p.x / tol);
  const qy = Math.round(p.y / tol);
  return `${qx},${qy}`;
}

function addAdjEdge(adj: Map<PtKey, Set<PtKey>>, a: PtKey, b: PtKey) {
  if (a === b) return;
  if (!adj.has(a)) adj.set(a, new Set());
  if (!adj.has(b)) adj.set(b, new Set());
  adj.get(a)!.add(b);
  adj.get(b)!.add(a);
}

function edgeKey(a: PtKey, b: PtKey): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function angleTurn(prev: Point2D, curr: Point2D, next: Point2D): number {
  // return signed angle [-pi, pi] between (curr-prev) and (next-curr)
  const ax = curr.x - prev.x;
  const ay = curr.y - prev.y;
  const bx = next.x - curr.x;
  const by = next.y - curr.y;
  const aLen = Math.hypot(ax, ay);
  const bLen = Math.hypot(bx, by);
  if (aLen === 0 || bLen === 0) return 0;
  const anx = ax / aLen;
  const any = ay / aLen;
  const bnx = bx / bLen;
  const bny = by / bLen;
  const cross = anx * bny - any * bnx;
  const dot = anx * bnx + any * bny;
  return Math.atan2(cross, dot);
}

function extractLongestClosedLoop(
  adj: Map<PtKey, Set<PtKey>>,
  keyToPoint: Map<PtKey, Point2D>
): Point2D[] {
  // Walk edges and try to close cycles; keep the longest cycle found.
  const visitedEdges = new Set<string>();
  let bestLoop: PtKey[] = [];

  const keys = [...adj.keys()];
  for (const start of keys) {
    const neighbors = [...(adj.get(start) ?? [])];
    for (const first of neighbors) {
      const e0 = edgeKey(start, first);
      if (visitedEdges.has(e0)) continue;

      let prev = start;
      let curr = first;
      const path: PtKey[] = [start, first];
      visitedEdges.add(e0);

      // hard cap to avoid infinite loops on pathological graphs
      for (let steps = 0; steps < 10000; steps++) {
        if (curr === start) {
          // closed (path ends at start)
          const loop = path.slice(0, -1); // remove duplicated start
          if (loop.length >= 3 && loop.length > bestLoop.length) bestLoop = loop;
          break;
        }

        const currNeighbors = [...(adj.get(curr) ?? [])].filter(n => n !== prev);
        if (currNeighbors.length === 0) break;

        let next = currNeighbors[0];
        if (currNeighbors.length > 1) {
          const prevPt = keyToPoint.get(prev);
          const currPt = keyToPoint.get(curr);
          if (prevPt && currPt) {
            // Choose the neighbor that makes the most consistent boundary walk.
            // We prefer a RIGHT-HAND traversal (keep exterior on right), i.e.
            // smallest (most negative) turn; fallback to smallest abs turn.
            let best = currNeighbors[0];
            let bestScore = Infinity;
            for (const cand of currNeighbors) {
              const candPt = keyToPoint.get(cand);
              if (!candPt) continue;
              const turn = angleTurn(prevPt, currPt, candPt);
              const score = turn > 0 ? 1000 + turn : Math.abs(turn); // prefer <=0
              if (score < bestScore) {
                bestScore = score;
                best = cand;
              }
            }
            next = best;
          }
        }

        const e = edgeKey(curr, next);
        if (visitedEdges.has(e)) break;
        visitedEdges.add(e);

        prev = curr;
        curr = next;
        path.push(curr);
      }
    }
  }

  // Convert to points
  const pts = bestLoop.map(k => keyToPoint.get(k)).filter(Boolean) as Point2D[];
  return pts;
}

// Point in polygon test (ray casting)
function pointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
  if (polygon.length < 3) return false;
  
  let inside = false;
  const n = polygon.length;
  
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    
    if (((yi > point.y) !== (yj > point.y)) &&
        (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  
  return inside;
}

// Try to extract outerPolygon from layout payload (best source for concave buildings)
function extractOuterPolygonFromPayload(
  layout: NormalizedExternalAnalysis
): Point2D[] | null {
  // Check various locations where outerPolygon might exist
  const candidates = [
    (layout as any).analysis?.footprint?.outerPolygon,
    (layout as any).meta?.outerPolygon,
    (layout as any).outerPolygon,
    (layout as any).footprint?.outerPolygon,
  ];
  
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length >= 3) {
      const pts = filterValidPoints(candidate);
      if (pts.length >= 3) {
        console.log(`[Footprint] Using outerPolygon from payload (${pts.length} points)`);
        return pts;
      }
    }
  }
  return null;
}

// Build footprint using the robust wall-chains algorithm (same as DXF footprint detection)
// Converts GraphWall[] to WallSegment[] (centerlines in mm) and runs buildWallChainsAutoTuned
function buildFootprintViaWallChains(walls: GraphWall[]): Point2D[] {
  if (walls.length === 0) return [];
  
  // Convert GraphWall[] to WallSegment[] (centerlines in mm)
  const wallSegmentsMm: WallSegment[] = [];
  
  for (let i = 0; i < walls.length; i++) {
    const wall = walls[i];
    const leftPts = filterValidPoints((wall.offsets?.left as unknown[]) || []);
    const rightPts = filterValidPoints((wall.offsets?.right as unknown[]) || []);
    
    if (leftPts.length < 2 || rightPts.length < 2) continue;
    
    // Derive centerline endpoints (average of left/right at start and end)
    const startX = ((leftPts[0].x + rightPts[0].x) / 2) * 1000; // meters to mm
    const startY = ((leftPts[0].y + rightPts[0].y) / 2) * 1000;
    const endX = ((leftPts[leftPts.length - 1].x + rightPts[rightPts.length - 1].x) / 2) * 1000;
    const endY = ((leftPts[leftPts.length - 1].y + rightPts[rightPts.length - 1].y) / 2) * 1000;
    
    const dx = endX - startX;
    const dy = endY - startY;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    
    wallSegmentsMm.push({
      id: wall.id || `wall-${i}`,
      projectId: 'external-engine',
      startX,
      startY,
      endX,
      endY,
      length,
      angle,
    });
  }
  
  if (wallSegmentsMm.length === 0) return [];
  
  // Run the robust chain-based footprint detection
  const chainsResult = buildWallChainsAutoTuned(wallSegmentsMm);
  const outerPolygonMm = chainsResult.footprint?.outerPolygon;
  
  if (outerPolygonMm && outerPolygonMm.length >= 3) {
    // Convert back to meters
    const outerPolygonM = outerPolygonMm.map(pt => ({
      x: pt.x / 1000,
      y: pt.y / 1000,
    }));
    console.log(`[Footprint] Using chain-based footprint (wall-chains) with ${outerPolygonM.length} vertices`);
    return outerPolygonM;
  }
  
  return [];
}

// Compute the building footprint - prioritizes payload outerPolygon, falls back to concave construction
function computeBuildingFootprint(
  walls: GraphWall[],
  layout?: NormalizedExternalAnalysis
): { 
  centroid: Point2D; 
  hull: Point2D[];
} {
  // First: collect all wall points for centroid calculation
  const allWallPoints: Point2D[] = [];
  
  for (const wall of walls) {
    const leftPts = filterValidPoints((wall.offsets?.left as unknown[]) || []);
    const rightPts = filterValidPoints((wall.offsets?.right as unknown[]) || []);
    allWallPoints.push(...leftPts, ...rightPts);
  }
  
  if (allWallPoints.length === 0) {
    return { centroid: { x: 0, y: 0 }, hull: [] };
  }
  
  // Calculate centroid from all points
  const centroid = {
    x: allWallPoints.reduce((sum, p) => sum + p.x, 0) / allWallPoints.length,
    y: allWallPoints.reduce((sum, p) => sum + p.y, 0) / allWallPoints.length,
  };
  
  // Priority #1: Use outerPolygon from payload if available (handles concave shapes correctly)
  if (layout) {
    const payloadPolygon = extractOuterPolygonFromPayload(layout);
    if (payloadPolygon && payloadPolygon.length >= 3) {
      return { centroid, hull: payloadPolygon };
    }
  }
  
  // Priority #2: Use robust chain-based footprint detection (handles L/U shapes)
  const chainBasedPolygon = buildFootprintViaWallChains(walls);
  if (chainBasedPolygon.length >= 3) {
    return { centroid, hull: chainBasedPolygon };
  }
  
  // No convex hull fallback (explicit requirement).
  console.warn('[Footprint] No outerPolygon in payload and could not build concave loop from walls');
  return { centroid, hull: [] };
}

// ===== Wall Geometry Data =====

interface WallGeometryData {
  leftPts: { x: number; y: number }[];
  rightPts: { x: number; y: number }[];
  u2: { x: number; y: number };      // Unit vector along wall (2D)
  n2: { x: number; y: number };      // Normal vector (perpendicular, 2D)
  length: number;
  isExteriorWall: boolean;           // True if wall is on building perimeter
  exteriorSide: 'left' | 'right' | null;  // Which side faces exterior
}

// Determine wall exterior status using footprint hull
// Robust exterior detection using multiple test offsets
// Tests at various distances to handle walls near the footprint boundary
function chooseOutNormal(
  mid: Point2D,
  n: Point2D,
  outerPoly: Point2D[]
): { isExterior: boolean; outN: Point2D } {
  if (outerPoly.length < 3) {
    return { isExterior: false, outN: n };
  }
  
  // Test at multiple distances for robustness
  const testEps = [0.05, 0.1, 0.15, 0.25, 0.5, 0.75, 1.0]; // meters - added smaller offsets
  
  for (const eps of testEps) {
    const pPlus = { x: mid.x + n.x * eps, y: mid.y + n.y * eps };
    const pMinus = { x: mid.x - n.x * eps, y: mid.y - n.y * eps };
    
    const inPlus = pointInPolygon(pPlus, outerPoly);
    const inMinus = pointInPolygon(pMinus, outerPoly);
    
    if (inPlus !== inMinus) {
      // If pPlus is INSIDE, then outN points in the opposite direction (-n)
      // If pMinus is INSIDE, then outN = n
      const outN = inPlus ? { x: -n.x, y: -n.y } : n;
      return { isExterior: true, outN };
    }
  }
  
  // Both sides equal at all offsets - check if wall is ON the footprint boundary
  // This handles edge cases where the wall centerline coincides with the footprint edge
  const distToEdge = distanceToPolygonEdge(mid, outerPoly);
  
  // If wall midpoint is within 200mm of a footprint edge, it's a perimeter wall
  if (distToEdge < 0.2) {
    // Determine exterior direction by checking which side is further from centroid
    // or by testing at a very small offset
    const pPlus = { x: mid.x + n.x * 0.01, y: mid.y + n.y * 0.01 };
    const pMinus = { x: mid.x - n.x * 0.01, y: mid.y - n.y * 0.01 };
    
    const inPlus = pointInPolygon(pPlus, outerPoly);
    const inMinus = pointInPolygon(pMinus, outerPoly);
    
    // If one is inside, the other is exterior
    if (inPlus && !inMinus) {
      return { isExterior: true, outN: n };
    } else if (!inPlus && inMinus) {
      return { isExterior: true, outN: { x: -n.x, y: -n.y } };
    }
    
    // If still ambiguous but close to edge, assume exterior with default normal
    // Use direction away from polygon centroid
    const centroid = polygonCentroid(outerPoly);
    const toMid = { x: mid.x - centroid.x, y: mid.y - centroid.y };
    const dotN = toMid.x * n.x + toMid.y * n.y;
    const outN = dotN > 0 ? n : { x: -n.x, y: -n.y };
    
    return { isExterior: true, outN };
  }
  
  // Both sides equal at all offsets and not on edge → interior partition wall
  return { isExterior: false, outN: n };
}

// Helper: distance from point to polygon edge
function distanceToPolygonEdge(p: Point2D, polygon: Point2D[]): number {
  if (polygon.length < 2) return Infinity;
  
  let minDist = Infinity;
  const n = polygon.length;
  
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dist = pointToSegmentDistance(p, polygon[i], polygon[j]);
    if (dist < minDist) minDist = dist;
  }
  
  return minDist;
}

// Helper: distance from point to line segment
function pointToSegmentDistance(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  
  if (lenSq < 0.0001) {
    return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
  }
  
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  
  return Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
}

// Helper: polygon centroid
function polygonCentroid(polygon: Point2D[]): Point2D {
  if (polygon.length === 0) return { x: 0, y: 0 };
  
  let cx = 0, cy = 0;
  for (const p of polygon) {
    cx += p.x;
    cy += p.y;
  }
  return { x: cx / polygon.length, y: cy / polygon.length };
}

// A wall is exterior if one side is outside the footprint hull
// Interior/partition walls have both sides inside the hull
function computeWallGeometry(
  wall: GraphWall,
  footprintHull: Point2D[],
  buildingCentroid: Point2D
): WallGeometryData | null {
  const leftPts = filterValidPoints((wall.offsets?.left as unknown[]) || []);
  const rightPts = filterValidPoints((wall.offsets?.right as unknown[]) || []);
  
  if (leftPts.length < 2 || rightPts.length < 2) return null;
  
  // Get axis vectors
  let u2 = { x: 1, y: 0 };
  
  if (wall.axis?.u) {
    u2 = toVec2(wall.axis.u);
  } else {
    const dx = leftPts[leftPts.length - 1].x - leftPts[0].x;
    const dy = leftPts[leftPts.length - 1].y - leftPts[0].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      u2 = { x: dx / len, y: dy / len };
    }
  }
  
  // Perpendicular: perp(u) = (u.y, -u.x)
  const n2 = { x: u2.y, y: -u2.x };
  
  const wallLength = wall.length ?? Math.sqrt(
    Math.pow(leftPts[leftPts.length - 1].x - leftPts[0].x, 2) +
    Math.pow(leftPts[leftPts.length - 1].y - leftPts[0].y, 2)
  );
  
  // Calculate centerline midpoint (for the wall's center position)
  const wallCenterMid = {
    x: (leftPts[0].x + leftPts[leftPts.length - 1].x + rightPts[0].x + rightPts[rightPts.length - 1].x) / 4,
    y: (leftPts[0].y + leftPts[leftPts.length - 1].y + rightPts[0].y + rightPts[rightPts.length - 1].y) / 4,
  };
  
  // Use robust multi-offset detection
  const { isExterior, outN } = chooseOutNormal(wallCenterMid, n2, footprintHull);
  
  let isExteriorWall = isExterior;
  let exteriorSide: 'left' | 'right' | null = null;
  
  if (isExteriorWall && footprintHull.length >= 3) {
    // Determine which polyline (left or right) is on the exterior side
    // by testing which midpoint is further in the outN direction
    
    // Calculate midpoints of each polyline
    const leftMid = {
      x: (leftPts[0].x + leftPts[leftPts.length - 1].x) / 2,
      y: (leftPts[0].y + leftPts[leftPts.length - 1].y) / 2,
    };
    const rightMid = {
      x: (rightPts[0].x + rightPts[rightPts.length - 1].x) / 2,
      y: (rightPts[0].y + rightPts[rightPts.length - 1].y) / 2,
    };
    
    // Vector from wall center to left polyline midpoint
    const toLeft = { 
      x: leftMid.x - wallCenterMid.x, 
      y: leftMid.y - wallCenterMid.y 
    };
    
    // Dot product with outN - positive means left is on exterior side
    const dotLeft = toLeft.x * outN.x + toLeft.y * outN.y;
    
    exteriorSide = dotLeft > 0 ? 'left' : 'right';
    
    // Enhanced debug logging
    console.log(`[Wall ${wall.id}] isExterior: true, exteriorPolyline: ${exteriorSide}, dotLeft: ${dotLeft.toFixed(3)}`);
  } else {
    console.log(`[Wall ${wall.id}] isExterior: ${isExteriorWall} (partition)`);
  }
  
  return {
    leftPts,
    rightPts,
    u2,
    n2,
    length: wallLength,
    isExteriorWall,
    exteriorSide,
  };
}

// ===== Calculate bounding box offset for auto-centering =====

function calculateCenterOffset(
  nodes: GraphNode[],
  walls: GraphWall[]
): { x: number; y: number } {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  for (const node of nodes) {
    const x = px(node.position);
    const y = py(node.position);
    if (x !== undefined && y !== undefined) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  for (const wall of walls) {
    const leftPts = filterValidPoints((wall.offsets?.left as unknown[]) || []);
    const rightPts = filterValidPoints((wall.offsets?.right as unknown[]) || []);
    for (const p of [...leftPts, ...rightPts]) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }

  if (!isFinite(minX) || !isFinite(minY)) return { x: 0, y: 0 };

  return { x: -(minX + maxX) / 2, y: -(minY + maxY) / 2 };
}

// ===== Panel Skin Mesh =====
// Renders a single panel skin (rectangle) at given Z range

interface PanelSkinProps {
  x0: number;           // Start position along wall
  x1: number;           // End position along wall
  z0: number;           // Bottom Y (height)
  z1: number;           // Top Y (height)
  startPt: { x: number; y: number };  // Start point of this skin polyline
  u2: { x: number; y: number };       // Direction along wall
  color: number;
  isSelected: boolean;
}

function PanelSkin({ x0, x1, z0, z1, startPt, u2, color, isSelected }: PanelSkinProps) {
  const geometry = useMemo(() => {
    // 4 corners of the panel skin
    const bl = { x: startPt.x + u2.x * x0, y: startPt.y + u2.y * x0 }; // bottom-left
    const br = { x: startPt.x + u2.x * x1, y: startPt.y + u2.y * x1 }; // bottom-right
    
    const vertices = new Float32Array([
      // Bottom-left
      bl.x, z0, bl.y,
      // Bottom-right
      br.x, z0, br.y,
      // Top-right
      br.x, z1, br.y,
      // Top-left
      bl.x, z1, bl.y,
    ]);
    
    const indices = [0, 1, 2, 0, 2, 3]; // Two triangles
    
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
  }, [x0, x1, z0, z1, startPt, u2]);
  
  const displayColor = isSelected ? COLORS.SELECTED : color;
  
  return (
    <mesh geometry={geometry} renderOrder={5}>
      <meshBasicMaterial
        color={displayColor}
        side={THREE.DoubleSide}
        depthWrite={true}
        depthTest={true}
        transparent={false}
        opacity={1}
        polygonOffset
        polygonOffsetFactor={1}
        polygonOffsetUnits={1}
      />
    </mesh>
  );
}

// ===== Panel Outline =====

interface PanelOutlineProps {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  startPt: { x: number; y: number };
  u2: { x: number; y: number };
}

function PanelOutline({ x0, x1, z0, z1, startPt, u2 }: PanelOutlineProps) {
  const bl = { x: startPt.x + u2.x * x0, y: startPt.y + u2.y * x0 };
  const br = { x: startPt.x + u2.x * x1, y: startPt.y + u2.y * x1 };
  
  const points = [
    new THREE.Vector3(bl.x, z0, bl.y),
    new THREE.Vector3(br.x, z0, br.y),
    new THREE.Vector3(br.x, z1, br.y),
    new THREE.Vector3(bl.x, z1, bl.y),
    new THREE.Vector3(bl.x, z0, bl.y),
  ];
  
  return (
    <Line
      points={points}
      color={COLORS.OUTLINE}
      lineWidth={1.5}
      // IMPORTANT: must respect depth buffer so you can't see outlines through panels
      depthTest={true}
      renderOrder={20}
    />
  );
}

// ===== Panel Stripe (Solid stripe overlay) =====
// Replaces old ExteriorOverlay with solid rectangular stripes
// Blue for exterior walls, white for interior walls - on BOTH faces

interface PanelStripeProps {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  startPt: { x: number; y: number };
  u2: { x: number; y: number };
  n2: { x: number; y: number };
  color: string;
  offset: number; // positive = front face, negative = back face
}

function PanelStripe({ x0, x1, z0, z1, startPt, u2, n2, color, offset }: PanelStripeProps) {
  const geometry = useMemo(() => {
    // Center of panel along wall
    const centerX = (x0 + x1) / 2;
    
    // Stripe height: 85% of course height, centered vertically
    const courseHeight = z1 - z0;
    const stripeHeight = courseHeight * STRIPE_HEIGHT_RATIO;
    const stripeZ0 = z0 + (courseHeight - stripeHeight) / 2;
    const stripeZ1 = stripeZ0 + stripeHeight;
    
    // Stripe width: 100mm centered
    const halfWidth = STRIPE_WIDTH / 2;
    const stripeX0 = centerX - halfWidth;
    const stripeX1 = centerX + halfWidth;
    
    // Apply offset from surface (perpendicular to wall)
    const offsetPt = {
      x: startPt.x + n2.x * offset,
      y: startPt.y + n2.y * offset,
    };
    
    // 4 corners of stripe
    const bl = { x: offsetPt.x + u2.x * stripeX0, y: offsetPt.y + u2.y * stripeX0 };
    const br = { x: offsetPt.x + u2.x * stripeX1, y: offsetPt.y + u2.y * stripeX1 };
    
    const vertices = new Float32Array([
      bl.x, stripeZ0, bl.y,
      br.x, stripeZ0, br.y,
      br.x, stripeZ1, br.y,
      bl.x, stripeZ1, bl.y,
    ]);
    
    const indices = [0, 1, 2, 0, 2, 3];
    
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
  }, [x0, x1, z0, z1, startPt, u2, n2, offset]);
  
  return (
    <mesh geometry={geometry} renderOrder={15}>
      <meshBasicMaterial
        color={color}
        side={THREE.DoubleSide}
        depthTest={true}
        depthWrite={true}
        transparent={false}
        opacity={1}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
      />
    </mesh>
  );
}

// ===== Single Panel (Dual Skin) =====
// 
// KEY FIX: For EXTERIOR walls (perimeter), we have TWO skins:
// - Exterior skin (facing outside building): BLUE overlay
// - Interior skin (facing inside building): WHITE overlay
// 
// For INTERIOR walls (partitions), BOTH skins get WHITE overlay

interface DualSkinPanelProps {
  panel: EnginePanel;
  course: Course;
  wallGeom: WallGeometryData;
  coreThickness: number;
  isSelected: boolean;
}

function DualSkinPanel({ panel, course, wallGeom, coreThickness, isSelected }: DualSkinPanelProps) {
  const { leftPts, rightPts, u2, n2, isExteriorWall, exteriorSide } = wallGeom;
  
  const z0 = course.z0 ?? 0;
  const z1 = course.z1 ?? 0.4;
  const x0 = panel.x0;
  const x1 = panel.x1;
  
  // Panel base color (FULL=yellow, CUT=red) - same for both skins
  const panelColor = panel.type === 'FULL' ? COLORS.PANEL_FULL : COLORS.PANEL_CUT;
  
  // Get the polyline start points for left and right
  const leftStart = leftPts[0];
  const rightStart = rightPts[0];
  
  // Determine which polyline is exterior and which is interior
  // based on which side faces outside the building
  let extStart: { x: number; y: number };
  let intStart: { x: number; y: number };
  
  if (exteriorSide === 'left') {
    extStart = leftStart;
    intStart = rightStart;
  } else if (exteriorSide === 'right') {
    extStart = rightStart;
    intStart = leftStart;
  } else {
    // Interior/partition wall: assign left as "ext" and right as "int" arbitrarily
    // Both will get white stripes anyway
    extStart = leftStart;
    intStart = rightStart;
  }
  
  // Normal directions for stripe offset positioning
  const extNormalDir = exteriorSide === 'right' ? { x: -n2.x, y: -n2.y } : n2;
  const intNormalDir = exteriorSide === 'right' ? n2 : { x: -n2.x, y: -n2.y };
  
  // ============= KEY FIX: Stripe colors per-skin =============
  // EXTERIOR WALL:
  //   - Exterior skin (facing OUT) → BLUE stripe
  //   - Interior skin (facing IN)  → WHITE stripe
  // INTERIOR WALL (partition):
  //   - Both skins → WHITE stripe
  const exteriorSkinStripeColor = isExteriorWall ? COLORS.STRIPE_EXTERIOR : COLORS.STRIPE_INTERIOR;
  const interiorSkinStripeColor = COLORS.STRIPE_INTERIOR; // Always white for the inside-facing skin
  
  return (
    <group>
      {/* ===== Exterior Skin (the panel facing OUTSIDE the building) ===== */}
      <PanelSkin
        x0={x0}
        x1={x1}
        z0={z0}
        z1={z1}
        startPt={extStart}
        u2={u2}
        color={panelColor}
        isSelected={isSelected}
      />
      <PanelOutline
        x0={x0}
        x1={x1}
        z0={z0}
        z1={z1}
        startPt={extStart}
        u2={u2}
      />
      {/* Stripe on front face of exterior skin */}
      <PanelStripe
        x0={x0}
        x1={x1}
        z0={z0}
        z1={z1}
        startPt={extStart}
        u2={u2}
        n2={extNormalDir}
        color={exteriorSkinStripeColor}
        offset={STRIPE_OFFSET}
      />
      {/* Stripe on back face of exterior skin */}
      <PanelStripe
        x0={x0}
        x1={x1}
        z0={z0}
        z1={z1}
        startPt={extStart}
        u2={u2}
        n2={extNormalDir}
        color={exteriorSkinStripeColor}
        offset={-STRIPE_OFFSET}
      />
      
      {/* ===== Interior Skin (the panel facing INSIDE the building) ===== */}
      <PanelSkin
        x0={x0}
        x1={x1}
        z0={z0}
        z1={z1}
        startPt={intStart}
        u2={u2}
        color={panelColor}
        isSelected={isSelected}
      />
      <PanelOutline
        x0={x0}
        x1={x1}
        z0={z0}
        z1={z1}
        startPt={intStart}
        u2={u2}
      />
      {/* Stripe on front face of interior skin - ALWAYS WHITE */}
      <PanelStripe
        x0={x0}
        x1={x1}
        z0={z0}
        z1={z1}
        startPt={intStart}
        u2={u2}
        n2={intNormalDir}
        color={interiorSkinStripeColor}
        offset={STRIPE_OFFSET}
      />
      {/* Stripe on back face of interior skin - ALWAYS WHITE */}
      <PanelStripe
        x0={x0}
        x1={x1}
        z0={z0}
        z1={z1}
        startPt={intStart}
        u2={u2}
        n2={intNormalDir}
        color={interiorSkinStripeColor}
        offset={-STRIPE_OFFSET}
      />
    </group>
  );
}

// ===== Wall Fallback (when no panels) =====

interface WallFallbackProps {
  wallGeom: WallGeometryData;
  wallHeight: number;
  courses: Course[];
  isSelected: boolean;
}

function WallFallback({ wallGeom, wallHeight, courses, isSelected }: WallFallbackProps) {
  const { leftPts, rightPts, u2, n2, length, isExteriorWall, exteriorSide } = wallGeom;
  
  // Create wall surfaces using polyline strip geometry
  const createSurfaceGeometry = (pts: { x: number; y: number }[]) => {
    const vertices: number[] = [];
    const indices: number[] = [];
    
    for (let i = 0; i < pts.length; i++) {
      vertices.push(pts[i].x, 0, pts[i].y);
      vertices.push(pts[i].x, wallHeight, pts[i].y);
    }
    
    for (let i = 0; i < pts.length - 1; i++) {
      const bl = i * 2;
      const tl = i * 2 + 1;
      const br = (i + 1) * 2;
      const tr = (i + 1) * 2 + 1;
      indices.push(bl, br, tl, tl, br, tr);
    }
    
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
  };
  
  const leftGeom = useMemo(() => createSurfaceGeometry(leftPts), [leftPts]);
  const rightGeom = useMemo(() => createSurfaceGeometry(rightPts), [rightPts]);
  
  // Both surfaces use FULL color (yellow) as fallback base color
  const baseColor = COLORS.PANEL_FULL;
  
  // ============= KEY FIX: Stripe colors per-side for fallback =============
  // EXTERIOR WALL:
  //   - Exterior side (left or right depending on exteriorSide) → BLUE
  //   - Interior side → WHITE
  // INTERIOR WALL:
  //   - Both sides → WHITE
  const leftStripeColor = isExteriorWall && exteriorSide === 'left' 
    ? COLORS.STRIPE_EXTERIOR 
    : COLORS.STRIPE_INTERIOR;
  const rightStripeColor = isExteriorWall && exteriorSide === 'right' 
    ? COLORS.STRIPE_EXTERIOR 
    : COLORS.STRIPE_INTERIOR;
  
  // Course lines
  const courseLines = courses.map(course => {
    const z = course.z1 ?? 0;
    return (
      <group key={`course-${course.index}`}>
        <Line
          points={leftPts.map(p => new THREE.Vector3(p.x, z, p.y))}
          color={COLORS.COURSE_LINE}
          lineWidth={1}
        />
        <Line
          points={rightPts.map(p => new THREE.Vector3(p.x, z, p.y))}
          color={COLORS.COURSE_LINE}
          lineWidth={1}
        />
      </group>
    );
  });
  
  // Module lines (vertical at 1.2m intervals)
  const moduleLines: JSX.Element[] = [];
  const moduleSpacing = 1.2;
  const moduleCount = Math.floor(length / moduleSpacing);
  
  for (let k = 1; k <= moduleCount; k++) {
    const t = k * moduleSpacing;
    const lp = { x: leftPts[0].x + u2.x * t, y: leftPts[0].y + u2.y * t };
    const rp = { x: rightPts[0].x + u2.x * t, y: rightPts[0].y + u2.y * t };
    
    moduleLines.push(
      <Line
        key={`mod-l-${k}`}
        points={[new THREE.Vector3(lp.x, 0, lp.y), new THREE.Vector3(lp.x, wallHeight, lp.y)]}
        color={COLORS.COURSE_LINE}
        lineWidth={0.5}
        dashed
        dashSize={0.05}
        gapSize={0.05}
      />,
      <Line
        key={`mod-r-${k}`}
        points={[new THREE.Vector3(rp.x, 0, rp.y), new THREE.Vector3(rp.x, wallHeight, rp.y)]}
        color={COLORS.COURSE_LINE}
        lineWidth={0.5}
        dashed
        dashSize={0.05}
        gapSize={0.05}
      />
    );
  }
  
  // Generate stripe overlays for fallback (solid rectangles per course)
  const fallbackStripes: JSX.Element[] = [];
  const leftNormal = n2;
  const rightNormal = { x: -n2.x, y: -n2.y };
  
  courses.forEach((course, ci) => {
    const z0 = course.z0 ?? 0;
    const z1 = course.z1 ?? 0.4;
    const courseHeight = z1 - z0;
    const stripeHeight = courseHeight * STRIPE_HEIGHT_RATIO;
    const stripeZ0 = z0 + (courseHeight - stripeHeight) / 2;
    const stripeZ1 = stripeZ0 + stripeHeight;
    
    // Create stripe geometry at center of wall
    const centerT = length / 2;
    const halfW = STRIPE_WIDTH / 2;
    
    // Left surface stripes (front and back)
    const leftCenter = { x: leftPts[0].x + u2.x * centerT, y: leftPts[0].y + u2.y * centerT };
    const leftBl = { x: leftCenter.x + u2.x * (-halfW), y: leftCenter.y + u2.y * (-halfW) };
    const leftBr = { x: leftCenter.x + u2.x * halfW, y: leftCenter.y + u2.y * halfW };
    
    // Front stripe on left surface
    fallbackStripes.push(
      <mesh key={`left-front-${ci}`} renderOrder={10}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[new Float32Array([
              leftBl.x + leftNormal.x * STRIPE_OFFSET, stripeZ0, leftBl.y + leftNormal.y * STRIPE_OFFSET,
              leftBr.x + leftNormal.x * STRIPE_OFFSET, stripeZ0, leftBr.y + leftNormal.y * STRIPE_OFFSET,
              leftBr.x + leftNormal.x * STRIPE_OFFSET, stripeZ1, leftBr.y + leftNormal.y * STRIPE_OFFSET,
              leftBl.x + leftNormal.x * STRIPE_OFFSET, stripeZ1, leftBl.y + leftNormal.y * STRIPE_OFFSET,
            ]), 3]}
          />
          <bufferAttribute attach="index" args={[new Uint16Array([0, 1, 2, 0, 2, 3]), 1]} />
        </bufferGeometry>
        <meshBasicMaterial
          color={leftStripeColor}
          side={THREE.DoubleSide}
          depthWrite={true}
          depthTest={true}
          transparent={false}
          opacity={1}
          polygonOffset
          polygonOffsetFactor={-2}
          polygonOffsetUnits={-2}
        />
      </mesh>
    );
    
    // Back stripe on left surface
    fallbackStripes.push(
      <mesh key={`left-back-${ci}`} renderOrder={10}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[new Float32Array([
              leftBl.x - leftNormal.x * STRIPE_OFFSET, stripeZ0, leftBl.y - leftNormal.y * STRIPE_OFFSET,
              leftBr.x - leftNormal.x * STRIPE_OFFSET, stripeZ0, leftBr.y - leftNormal.y * STRIPE_OFFSET,
              leftBr.x - leftNormal.x * STRIPE_OFFSET, stripeZ1, leftBr.y - leftNormal.y * STRIPE_OFFSET,
              leftBl.x - leftNormal.x * STRIPE_OFFSET, stripeZ1, leftBl.y - leftNormal.y * STRIPE_OFFSET,
            ]), 3]}
          />
          <bufferAttribute attach="index" args={[new Uint16Array([0, 1, 2, 0, 2, 3]), 1]} />
        </bufferGeometry>
        <meshBasicMaterial
          color={leftStripeColor}
          side={THREE.DoubleSide}
          depthWrite={true}
          depthTest={true}
          transparent={false}
          opacity={1}
          polygonOffset
          polygonOffsetFactor={-2}
          polygonOffsetUnits={-2}
        />
      </mesh>
    );
    
    // Right surface stripes
    const rightCenter = { x: rightPts[0].x + u2.x * centerT, y: rightPts[0].y + u2.y * centerT };
    const rightBl = { x: rightCenter.x + u2.x * (-halfW), y: rightCenter.y + u2.y * (-halfW) };
    const rightBr = { x: rightCenter.x + u2.x * halfW, y: rightCenter.y + u2.y * halfW };
    
    // Front stripe on right surface
    fallbackStripes.push(
      <mesh key={`right-front-${ci}`} renderOrder={10}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[new Float32Array([
              rightBl.x + rightNormal.x * STRIPE_OFFSET, stripeZ0, rightBl.y + rightNormal.y * STRIPE_OFFSET,
              rightBr.x + rightNormal.x * STRIPE_OFFSET, stripeZ0, rightBr.y + rightNormal.y * STRIPE_OFFSET,
              rightBr.x + rightNormal.x * STRIPE_OFFSET, stripeZ1, rightBr.y + rightNormal.y * STRIPE_OFFSET,
              rightBl.x + rightNormal.x * STRIPE_OFFSET, stripeZ1, rightBl.y + rightNormal.y * STRIPE_OFFSET,
            ]), 3]}
          />
          <bufferAttribute attach="index" args={[new Uint16Array([0, 1, 2, 0, 2, 3]), 1]} />
        </bufferGeometry>
        <meshBasicMaterial
          color={rightStripeColor}
          side={THREE.DoubleSide}
          depthWrite={true}
          depthTest={true}
          transparent={false}
          opacity={1}
          polygonOffset
          polygonOffsetFactor={-2}
          polygonOffsetUnits={-2}
        />
      </mesh>
    );
    
    // Back stripe on right surface
    fallbackStripes.push(
      <mesh key={`right-back-${ci}`} renderOrder={10}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[new Float32Array([
              rightBl.x - rightNormal.x * STRIPE_OFFSET, stripeZ0, rightBl.y - rightNormal.y * STRIPE_OFFSET,
              rightBr.x - rightNormal.x * STRIPE_OFFSET, stripeZ0, rightBr.y - rightNormal.y * STRIPE_OFFSET,
              rightBr.x - rightNormal.x * STRIPE_OFFSET, stripeZ1, rightBr.y - rightNormal.y * STRIPE_OFFSET,
              rightBl.x - rightNormal.x * STRIPE_OFFSET, stripeZ1, rightBl.y - rightNormal.y * STRIPE_OFFSET,
            ]), 3]}
          />
          <bufferAttribute attach="index" args={[new Uint16Array([0, 1, 2, 0, 2, 3]), 1]} />
        </bufferGeometry>
        <meshBasicMaterial
          color={rightStripeColor}
          side={THREE.DoubleSide}
          depthWrite={true}
          depthTest={true}
          transparent={false}
          opacity={1}
          polygonOffset
          polygonOffsetFactor={-2}
          polygonOffsetUnits={-2}
        />
      </mesh>
    );
  });
  
  const displayColor = isSelected ? COLORS.SELECTED : baseColor;
  
  return (
    <group>
      {/* Left surface */}
      <mesh geometry={leftGeom} renderOrder={5}>
        <meshBasicMaterial color={displayColor} side={THREE.DoubleSide} depthWrite={true} depthTest={true} transparent={false} opacity={1} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
      </mesh>
      
      {/* Right surface */}
      <mesh geometry={rightGeom} renderOrder={5}>
        <meshBasicMaterial color={displayColor} side={THREE.DoubleSide} depthWrite={true} depthTest={true} transparent={false} opacity={1} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
      </mesh>
      
      {/* Course lines */}
      {courseLines}
      
      {/* Module lines */}
      {moduleLines}
      
      {/* Stripe overlays */}
      {fallbackStripes}
      
      {/* Wall outlines */}
      <Line
        points={[...leftPts.map(p => new THREE.Vector3(p.x, 0, p.y)), ...leftPts.map(p => new THREE.Vector3(p.x, 0, p.y)).slice(0, 1)]}
        color={COLORS.OUTLINE}
        lineWidth={1.5}
      />
      <Line
        points={[...leftPts.map(p => new THREE.Vector3(p.x, wallHeight, p.y))]}
        color={COLORS.OUTLINE}
        lineWidth={1.5}
      />
      <Line
        points={[...rightPts.map(p => new THREE.Vector3(p.x, 0, p.y))]}
        color={COLORS.OUTLINE}
        lineWidth={1.5}
      />
      <Line
        points={[...rightPts.map(p => new THREE.Vector3(p.x, wallHeight, p.y))]}
        color={COLORS.OUTLINE}
        lineWidth={1.5}
      />
    </group>
  );
}

// ===== Single Wall Renderer =====

interface WallRendererProps {
  wall: GraphWall;
  wallHeight: number;
  courses: Course[];
  panels: EnginePanel[];
  footprintHull: Point2D[];
  buildingCentroid: Point2D;
  coreThickness: number;
  isSelected: boolean;
  onWallClick?: (wallId: string) => void;
}

function WallRenderer({
  wall,
  wallHeight,
  courses,
  panels,
  footprintHull,
  buildingCentroid,
  coreThickness,
  isSelected,
  onWallClick,
}: WallRendererProps) {
  const wallGeom = useMemo(
    () => computeWallGeometry(wall, footprintHull, buildingCentroid),
    [wall, footprintHull, buildingCentroid]
  );

  if (!wallGeom) return null;

  const wallPanels = panels.filter(p => p.wall_id === wall.id);
  const hasPanels = wallPanels.length > 0;

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onWallClick?.(wall.id);
  };

  return (
    <group onClick={handleClick}>
      {hasPanels ? (
        // Render individual panels
        wallPanels.map((panel, idx) => {
          const course = courses.find(c => c.index === panel.course);
          if (!course) return null;
          
          return (
            <DualSkinPanel
              key={`panel-${wall.id}-${panel.course}-${idx}`}
              panel={panel}
              course={course}
              wallGeom={wallGeom}
              coreThickness={coreThickness}
              isSelected={isSelected}
            />
          );
        })
      ) : (
        // Fallback: render as continuous wall
        <WallFallback
          wallGeom={wallGeom}
          wallHeight={wallHeight}
          courses={courses}
          isSelected={isSelected}
        />
      )}
    </group>
  );
}

// ===== Node Spheres =====

function NodeSpheres({ nodes }: { nodes: GraphNode[] }) {
  return (
    <group>
      {nodes.map((node) => {
        const x = px(node.position);
        const y = py(node.position);
        if (x === undefined || y === undefined) return null;

        return (
          <mesh key={node.id} position={[x, 0.05, y]}>
            <sphereGeometry args={[0.08, 16, 16]} />
            <meshStandardMaterial color={COLORS.NODE} />
          </mesh>
        );
      })}
    </group>
  );
}

// ===== Course Labels =====

interface CourseLabelsProps {
  courses: Course[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

function CourseLabels({ courses, bounds }: CourseLabelsProps) {
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;

  return (
    <group>
      {courses.map((course) => (
        <Text
          key={`label-${course.index}`}
          position={[bounds.minX - 0.3, ((course.z0 ?? 0) + (course.z1 ?? 0)) / 2, centerZ]}
          fontSize={0.12}
          color={course.pattern === 'A' ? '#4caf50' : '#ff9800'}
          anchorX="right"
          anchorY="middle"
        >
          {`F${course.index + 1}`}
        </Text>
      ))}
    </group>
  );
}

// ===== Warning Badge =====

function SkippedWarning({ count }: { count: number }) {
  if (count === 0) return null;

  return (
    <Html position={[0, 0, 0]} center>
      <div className="bg-yellow-500/90 text-black px-3 py-1 rounded text-sm font-medium whitespace-nowrap">
        ⚠️ {count} parede(s) ignorada(s) por dados inválidos
      </div>
    </Html>
  );
}

// ===== No Data Placeholder =====

function NoDataPlaceholder() {
  return (
    <Html center>
      <div className="bg-orange-600/90 text-white px-4 py-2 rounded-lg text-sm font-medium">
        Sem dados do motor externo
      </div>
    </Html>
  );
}

// ===== Main Component =====

export function ExternalEngineRenderer({
  normalizedAnalysis,
  selectedWallId,
  onWallClick,
  showCourseMarkers = true,
}: ExternalEngineRendererProps) {
  const groupRef = useRef<THREE.Group>(null);
  const [skippedCount, setSkippedCount] = useState(0);

  const { nodes, walls, courses, panels, wallHeight, thickness } = normalizedAnalysis;

  const hasPanels = panels.length > 0;
  const coreThickness = thickness > 0 ? thickness : DEFAULT_CORE_THICKNESS;

  // Calculate auto-centering offset
  const centerOffset = useMemo(
    () => calculateCenterOffset(nodes, walls),
    [nodes, walls]
  );

  // Apply offset to nodes
  const adjustedNodes = useMemo(() => {
    if (centerOffset.x === 0 && centerOffset.y === 0) return nodes;
    return nodes.map(node => ({
      ...node,
      position: {
        x: (px(node.position) ?? 0) + centerOffset.x,
        y: (py(node.position) ?? 0) + centerOffset.y,
        z: (node.position as { z?: number })?.z ?? 0,
      },
    }));
  }, [nodes, centerOffset]);

  // Apply offset to walls
  const adjustedWalls = useMemo((): GraphWall[] => {
    if (centerOffset.x === 0 && centerOffset.y === 0) return walls;
    return walls.map(wall => {
      const adjustPts = (pts: unknown[]): Vec3[] => {
        return filterValidPoints(pts).map(p => ({
          x: p.x + centerOffset.x,
          y: p.y + centerOffset.y,
          z: 0,
        }));
      };
      return {
        ...wall,
        offsets: {
          left: adjustPts((wall.offsets?.left as unknown[]) || []),
          right: adjustPts((wall.offsets?.right as unknown[]) || []),
        },
      };
    });
  }, [walls, centerOffset]);

  // Compute building footprint (hull + centroid) for exterior detection
  const buildingFootprint = useMemo(
    () => computeBuildingFootprint(adjustedWalls, normalizedAnalysis),
    [adjustedWalls, normalizedAnalysis]
  );
  const { hull: footprintHull, centroid: buildingCentroid } = buildingFootprint;

  // Log for debugging
  useEffect(() => {
    console.log('[ExternalEngineRenderer] Rendering:', {
      walls: walls.length,
      panels: panels.length,
      courses: courses.length,
      wallHeight,
      thickness: coreThickness,
      centerOffset,
      buildingCentroid,
    });
  }, [walls, panels, courses, wallHeight, coreThickness, centerOffset, buildingCentroid]);

  // Calculate bounds for labels
  const bounds = useMemo(() => {
    if (adjustedNodes.length === 0 && adjustedWalls.length === 0) {
      return { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
    }

    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const node of adjustedNodes) {
      const x = px(node.position);
      const y = py(node.position);
      if (x !== undefined) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
      if (y !== undefined) {
        minZ = Math.min(minZ, y);
        maxZ = Math.max(maxZ, y);
      }
    }

    for (const wall of adjustedWalls) {
      const leftPts = filterValidPoints((wall.offsets?.left as unknown[]) || []);
      const rightPts = filterValidPoints((wall.offsets?.right as unknown[]) || []);
      for (const p of [...leftPts, ...rightPts]) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.y);
        maxZ = Math.max(maxZ, p.y);
      }
    }

    if (!isFinite(minX)) return { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };

    return { minX, maxX, minZ, maxZ };
  }, [adjustedNodes, adjustedWalls]);

  // Count skipped walls
  const validWallsCount = useMemo(() => {
    let valid = 0;
    let skipped = 0;

    for (const wall of adjustedWalls) {
      const geom = computeWallGeometry(wall, footprintHull, buildingCentroid);
      if (!geom) skipped++;
      else valid++;
    }

    return { valid, skipped };
  }, [adjustedWalls, buildingCentroid]);

  useEffect(() => {
    setSkippedCount(validWallsCount.skipped);
  }, [validWallsCount.skipped]);

  // No data state
  if (walls.length === 0 && nodes.length === 0) {
    return <NoDataPlaceholder />;
  }

  return (
    <group ref={groupRef}>
      {skippedCount > 0 && <SkippedWarning count={skippedCount} />}

      {adjustedWalls.map((wall) => (
        <WallRenderer
          key={wall.id}
          wall={wall}
          wallHeight={wallHeight}
          courses={courses}
          panels={panels}
          footprintHull={footprintHull}
          buildingCentroid={buildingCentroid}
          coreThickness={coreThickness}
          isSelected={wall.id === selectedWallId}
          onWallClick={onWallClick}
        />
      ))}

      <NodeSpheres nodes={adjustedNodes} />

      {showCourseMarkers && courses.length > 0 && (
        <CourseLabels courses={courses} bounds={bounds} />
      )}
    </group>
  );
}
