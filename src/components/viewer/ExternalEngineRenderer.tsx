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
import { findOuterPolygonFromSegments } from '@/lib/external-engine-footprint';
import { detectFootprintAndClassify } from '@/lib/footprint-detection';
import type { WallChain } from '@/lib/wall-chains';

interface ExternalEngineRendererProps {
  normalizedAnalysis: NormalizedExternalAnalysis;
  selectedWallId: string | null;
  onWallClick?: (wallId: string) => void;
  showCourseMarkers?: boolean;
  showShiftArrows?: boolean;
  showFootprintDebug?: boolean;
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


// ===== Building Footprint Calculation (Concave polygon, no convex hull) =====

interface Point2D {
  x: number;
  y: number;
}

function polylinePointAtDistance(pts: Point2D[], distance: number): Point2D {
  if (pts.length === 0) return { x: 0, y: 0 };
  if (pts.length === 1) return pts[0];
  if (distance <= 0) return pts[0];

  let remaining = distance;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLen = Math.sqrt(dx * dx + dy * dy);
    if (segLen < 1e-12) continue;
    if (remaining <= segLen) {
      const t = remaining / segLen;
      return { x: a.x + dx * t, y: a.y + dy * t };
    }
    remaining -= segLen;
  }
  return pts[pts.length - 1];
}

function polylineMidpoint(pts: Point2D[]): Point2D {
  if (pts.length === 0) return { x: 0, y: 0 };
  if (pts.length === 1) return pts[0];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return polylinePointAtDistance(pts, total / 2);
}

// Local signed area calculation for CCW normalization
function signedPolygonAreaLocal(poly: Point2D[]): number {
  if (poly.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return area / 2;
}

// Ensure polygon is counter-clockwise (positive signed area)
function ensureCCW(polygon: Point2D[]): Point2D[] {
  if (polygon.length < 3) return polygon;
  const area = signedPolygonAreaLocal(polygon);
  if (area < 0) {
    console.log('[Footprint] Normalizing polygon to CCW');
    return [...polygon].reverse();
  }
  return polygon;
}

// Calculate polygon centroid
function polygonCentroid(poly: Point2D[]): Point2D {
  if (poly.length === 0) return { x: 0, y: 0 };
  let x = 0, y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

function pointToSegmentDistance(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) {
    const ddx = p.x - a.x;
    const ddy = p.y - a.y;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const proj = { x: a.x + t * dx, y: a.y + t * dy };
  const ddx = p.x - proj.x;
  const ddy = p.y - proj.y;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

function distanceToPolygonBoundary(p: Point2D, polygon: Point2D[]): number {
  if (polygon.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    best = Math.min(best, pointToSegmentDistance(p, polygon[i], polygon[j]));
  }
  return best;
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

function applyCenterOffsetToPolygon(poly: Point2D[], centerOffset: Point2D): Point2D[] {
  if (!poly.length) return poly;
  if (centerOffset.x === 0 && centerOffset.y === 0) return poly;
  return poly.map((p) => ({ x: p.x + centerOffset.x, y: p.y + centerOffset.y }));
}

// Build a concave polygon from wall outer edges (fallback when no outerPolygon in payload)
function buildConcaveFootprintFromWalls(walls: GraphWall[], centroid: Point2D): Point2D[] {
  // For each wall, take the polyline that is FURTHER from centroid (outer edge),
  // then add its segments into a segment soup and extract the best closed loop.
  const segments: Array<{ a: Point2D; b: Point2D; sourceId?: string }> = [];
  
  for (const wall of walls) {
    const leftPts = filterValidPoints((wall.offsets?.left as unknown[]) || []);
    const rightPts = filterValidPoints((wall.offsets?.right as unknown[]) || []);
    
    if (leftPts.length < 2 || rightPts.length < 2) continue;
    
    // NOTE: Using only the "outer" polyline can fail to close loops when the
    // engine graph has small gaps/branching. We therefore feed BOTH offset
    // polylines into the face-walking step; it will still select the best face.
    const polylines = [leftPts, rightPts];
    for (const pts of polylines) {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) continue;
        segments.push({ a, b, sourceId: String(wall.id ?? '') });
      }
    }
  }

  if (segments.length < 3) return [];

  // Adaptive snapping: walls/offset polylines often have small gaps at corners.
  // Try multiple tolerances (20mm → 500mm) and choose the BEST loop by area.
  const snapCandidates = [0.02, 0.05, 0.1, 0.2, 0.35, 0.5];

  type Candidate = { poly: Point2D[]; snapTol: number; areaAbs: number };
  const candidates: Candidate[] = [];
  for (const snapTol of snapCandidates) {
    const poly = findOuterPolygonFromSegments(segments, snapTol);
    if (poly.length < 3) continue;
    const areaAbs = Math.abs(signedPolygonAreaLocal(poly));
    // Reject degenerate loops (e.g., self-intersections collapsing area, tiny internal faces)
    if (!isFinite(areaAbs) || areaAbs < 1.0) continue;
    candidates.push({ poly, snapTol, areaAbs });
  }

  candidates.sort((a, b) => b.areaAbs - a.areaAbs);
  const best = candidates[0];
  if (best) {
    console.log(
      `[Footprint] Built concave polygon from wall offsets (${best.poly.length} points, snap=${Math.round(best.snapTol * 1000)}mm, area=${best.areaAbs.toFixed(1)}m²)`
    );
    return best.poly;
  }

  console.warn('[Footprint] Failed to build concave polygon from wall offsets');
  return [];
}

// NEW: Build footprint from graph centerlines (node positions + wall connectivity)
// This approach often closes loops better than offset polylines because nodes are snapped
function buildConcaveFootprintFromGraph(
  nodes: GraphNode[],
  walls: GraphWall[],
  centerOffset: Point2D
): Point2D[] {
  if (nodes.length < 3 || walls.length < 2) return [];
  
  // Build node position lookup (with centerOffset applied)
  const nodePos = new Map<string, Point2D>();
  for (const node of nodes) {
    const x = px(node.position);
    const y = py(node.position);
    if (x !== undefined && y !== undefined) {
      nodePos.set(node.id, { x: x + centerOffset.x, y: y + centerOffset.y });
    }
  }
  
  // Build segments from wall connectivity
  const segments: Array<{ a: Point2D; b: Point2D; sourceId?: string }> = [];
  
  for (const wall of walls) {
    const startPos = nodePos.get(wall.start_node);
    const endPos = nodePos.get(wall.end_node);
    
    if (!startPos || !endPos) continue;
    if (Math.abs(startPos.x - endPos.x) < 1e-6 && Math.abs(startPos.y - endPos.y) < 1e-6) continue;
    
    segments.push({ a: startPos, b: endPos, sourceId: wall.id });
  }
  
  if (segments.length < 3) return [];
  
  // Use face-walking with adaptive snapping
  const snapCandidates = [0.02, 0.05, 0.1, 0.2, 0.35, 0.5];

  type Candidate = { poly: Point2D[]; snapTol: number; areaAbs: number };
  const candidates: Candidate[] = [];
  for (const snapTol of snapCandidates) {
    const poly = findOuterPolygonFromSegments(segments, snapTol);
    if (poly.length < 3) continue;
    const areaAbs = Math.abs(signedPolygonAreaLocal(poly));
    if (!isFinite(areaAbs) || areaAbs < 1.0) continue;
    candidates.push({ poly, snapTol, areaAbs });
  }

  candidates.sort((a, b) => b.areaAbs - a.areaAbs);
  const best = candidates[0];
  if (best) {
    console.log(
      `[Footprint] Built concave polygon from graph centerlines (${best.poly.length} points, snap=${Math.round(best.snapTol * 1000)}mm, area=${best.areaAbs.toFixed(1)}m²)`
    );
    return best.poly;
  }
  
  console.warn('[Footprint] Failed to build concave polygon from graph centerlines');
  return [];
}

// Footprint source for debug purposes
export type FootprintSource = 'payload' | 'nodes' | 'offsets' | 'chains' | 'none';

interface FootprintResult {
  centroid: Point2D;
  hull: Point2D[];
  source: FootprintSource;
  chainSides?: Map<
    string,
    {
      outsideIsPositivePerp: boolean;
      isOutsideFootprint: boolean;
      classification: 'LEFT_EXT' | 'RIGHT_EXT' | 'BOTH_INT' | 'UNRESOLVED';
    }
  >;
}

function scalePolygon(poly: Array<{ x: number; y: number }>, scale: number): Point2D[] {
  return poly.map((p) => ({ x: p.x * scale, y: p.y * scale }));
}

/**
 * Build WallChain objects from external walls.
 * IMPORTANT: `walls` are expected to already be in the same coordinate space
 * used for rendering (i.e. after the renderer's auto-centering offset has been applied).
 *
 * The footprint module operates in millimeters, so we convert meters -> mm here.
 */
function buildChainsFromExternalWalls(walls: GraphWall[]): WallChain[] {
  const chains: WallChain[] = [];
  for (const wall of walls) {
    const leftPts = filterValidPoints((wall.offsets?.left as unknown[]) || []);
    const rightPts = filterValidPoints((wall.offsets?.right as unknown[]) || []);
    if (leftPts.length < 2 || rightPts.length < 2) continue;

    // Centerline endpoints (average of left/right endpoints)
    const s = {
      x: (leftPts[0].x + rightPts[0].x) / 2,
      y: (leftPts[0].y + rightPts[0].y) / 2,
    };
    const e = {
      x: (leftPts[leftPts.length - 1].x + rightPts[rightPts.length - 1].x) / 2,
      y: (leftPts[leftPts.length - 1].y + rightPts[rightPts.length - 1].y) / 2,
    };

    const dx = e.x - s.x;
    const dy = e.y - s.y;
    const lenM = Math.sqrt(dx * dx + dy * dy);
    if (lenM < 1e-6) continue;

    // Footprint module operates in millimeters (now centered around origin)
    const startX = s.x * 1000;
    const startY = s.y * 1000;
    const endX = e.x * 1000;
    const endY = e.y * 1000;
    const lengthMm = lenM * 1000;
    const angle = (() => {
      let a = Math.atan2(endY - startY, endX - startX);
      if (a < 0) a += Math.PI;
      if (a >= Math.PI) a -= Math.PI;
      return a;
    })();

    chains.push({
      id: String(wall.id),
      segments: [],
      lengthMm,
      angle,
      startX,
      startY,
      endX,
      endY,
      startNodeId: null,
      endNodeId: null,
    });
  }

  return chains;
}

// Compute the building footprint - tiered approach:
// Priority #1: payload outerPolygon
// Priority #2: graph centerlines (nodes + walls)
// Priority #3: wall offsets (left/right polylines)
function computeBuildingFootprint(
  walls: GraphWall[],
  nodes: GraphNode[],
  layout?: NormalizedExternalAnalysis,
  centerOffset: Point2D = { x: 0, y: 0 }
): FootprintResult {
  // First: collect all wall points for centroid calculation
  const allWallPoints: Point2D[] = [];
  
  for (const wall of walls) {
    const leftPts = filterValidPoints((wall.offsets?.left as unknown[]) || []);
    const rightPts = filterValidPoints((wall.offsets?.right as unknown[]) || []);
    allWallPoints.push(...leftPts, ...rightPts);
  }
  
  if (allWallPoints.length === 0) {
    return { centroid: { x: 0, y: 0 }, hull: [], source: 'none' };
  }
  
  // Calculate centroid from all points
  const centroid = {
    x: allWallPoints.reduce((sum, p) => sum + p.x, 0) / allWallPoints.length,
    y: allWallPoints.reduce((sum, p) => sum + p.y, 0) / allWallPoints.length,
  };

  // Always compute chain-based side classification when possible.
  // Even if the footprint polygon comes from payload/nodes/offsets (better for concave debug),
  // chainSides is the most deterministic per-wall EXT/INT source.
  let chainSides: FootprintResult['chainSides'] | undefined;
  try {
    const chains = buildChainsFromExternalWalls(walls);
    // External engine offsets often have small endpoint mismatches; use a more forgiving snap tolerance.
    const fp = detectFootprintAndClassify(chains, 300);
    if (fp.chainSides && fp.chainSides.size > 0) {
      const map = new Map<
        string,
        {
          outsideIsPositivePerp: boolean;
          isOutsideFootprint: boolean;
          classification: 'LEFT_EXT' | 'RIGHT_EXT' | 'BOTH_INT' | 'UNRESOLVED';
        }
      >();
      fp.chainSides.forEach((info, chainId) => {
        map.set(chainId, {
          outsideIsPositivePerp: info.outsideIsPositivePerp,
          isOutsideFootprint: info.isOutsideFootprint,
          classification: info.classification,
        });
      });
      chainSides = map;

      // Debug: Log classification stats
      let extCount = 0, intCount = 0, unresCount = 0;
      map.forEach((info) => {
        if (info.classification === 'LEFT_EXT' || info.classification === 'RIGHT_EXT') extCount++;
        else if (info.classification === 'BOTH_INT') intCount++;
        else unresCount++;
      });
      console.log(`[Footprint] chainSides: ${map.size} walls → EXT=${extCount}, PARTITION=${intCount}, UNRESOLVED=${unresCount}`);
    }
  } catch (e) {
    // Non-fatal: will fall back to geometric sampling when chainSides is absent.
    console.warn('[Footprint] Failed to compute chainSides', e);
  }
  
  // Priority #1: Use outerPolygon from payload if available (handles concave shapes correctly)
  if (layout) {
    const payloadPolygon = extractOuterPolygonFromPayload(layout);
    if (payloadPolygon && payloadPolygon.length >= 3) {
      const shiftedPoly = applyCenterOffsetToPolygon(payloadPolygon, centerOffset);
      console.log(`[Footprint] Source: PAYLOAD (${shiftedPoly.length} points)`);
      return { centroid, hull: ensureCCW(shiftedPoly), source: 'payload', chainSides };
    }
  }
  
  // Priority #2: Build from graph centerlines (tends to close loops better)
  const graphPolygon = buildConcaveFootprintFromGraph(nodes, walls, { x: 0, y: 0 });
  if (graphPolygon.length >= 3) {
    console.log(`[Footprint] Source: GRAPH NODES (${graphPolygon.length} points)`);
    return { centroid, hull: ensureCCW(graphPolygon), source: 'nodes', chainSides };
  }
  
  // Priority #3: Build concave polygon from wall outer edges
  const concavePolygon = buildConcaveFootprintFromWalls(walls, centroid);
  if (concavePolygon.length >= 3) {
    console.log(`[Footprint] Source: WALL OFFSETS (${concavePolygon.length} points)`);
    const hull = ensureCCW(concavePolygon);
    const areaM2 = Math.abs(signedPolygonAreaLocal(hull));
    // If the loop is suspiciously small/degenerate, fall through to robust chain-based detection.
    if (areaM2 >= 10 && hull.length >= 8) {
      return { centroid, hull, source: 'offsets', chainSides };
    }
    console.warn(`[Footprint] Offsets footprint looks degenerate (points=${hull.length}, area=${areaM2.toFixed(2)}m²) - trying chain-based detection`);
  }

  // Priority #4: Use robust chain-based footprint + side classification (same module used elsewhere)
  // This is the most reliable for complex graphs with T-junctions.
  try {
    const chains = buildChainsFromExternalWalls(walls);
    const fp = detectFootprintAndClassify(chains, 300);
    if (fp.outerPolygon.length >= 3) {
      const hull = ensureCCW(scalePolygon(fp.outerPolygon, 1 / 1000)); // mm -> m
      const areaM2 = (fp.outerArea / 1e6);
      const chainSides = new Map<
        string,
        {
          outsideIsPositivePerp: boolean;
          isOutsideFootprint: boolean;
          classification: 'LEFT_EXT' | 'RIGHT_EXT' | 'BOTH_INT' | 'UNRESOLVED';
        }
      >();
      fp.chainSides.forEach((info, chainId) => {
        chainSides.set(chainId, {
          outsideIsPositivePerp: info.outsideIsPositivePerp,
          isOutsideFootprint: info.isOutsideFootprint,
          classification: info.classification,
        });
      });
      console.log(`[Footprint] Source: CHAINS (${hull.length} points, area=${areaM2.toFixed(1)}m²)`);
      return { centroid, hull, source: 'chains', chainSides };
    }
  } catch (e) {
    console.warn('[Footprint] Chain-based detection failed', e);
  }
  
  // No valid footprint found
  console.warn('[Footprint] No outer polygon available (all methods failed)');
  return { centroid, hull: [], source: 'none', chainSides };
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
// Static counter for debug logging
let _chooseOutNormalCallCount = 0;

function chooseOutNormal(
  mid: Point2D,
  n: Point2D,
  outerPoly: Point2D[],
  wallId?: string
): { isExterior: boolean; outN: Point2D } {
  _chooseOutNormalCallCount++;
  const isFirstCall = _chooseOutNormalCallCount === 1;
  
  if (outerPoly.length < 3) {
    console.warn(`[Wall ${wallId}] No valid polygon (length=${outerPoly.length}) - defaulting to interior`);
    return { isExterior: false, outN: n };
  }

  // Debug: Log first wall's test results in detail
  if (isFirstCall) {
    // Calculate footprint bounds for debugging
    const polyMinX = Math.min(...outerPoly.map(p => p.x));
    const polyMaxX = Math.max(...outerPoly.map(p => p.x));
    const polyMinY = Math.min(...outerPoly.map(p => p.y));
    const polyMaxY = Math.max(...outerPoly.map(p => p.y));
    console.log(`[Footprint Debug] Polygon has ${outerPoly.length} points`);
    console.log(`[Footprint Debug] Polygon bounds: X[${polyMinX.toFixed(2)}, ${polyMaxX.toFixed(2)}] Y[${polyMinY.toFixed(2)}, ${polyMaxY.toFixed(2)}]`);
    console.log(`[Footprint Debug] Wall ${wallId} mid: (${mid.x.toFixed(2)}, ${mid.y.toFixed(2)}), n: (${n.x.toFixed(3)}, ${n.y.toFixed(3)})`);
  }

  const boundaryDist = distanceToPolygonBoundary(mid, outerPoly);
  
  // Extended test offsets - go further out for large buildings
  const testEps = [0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0];
  
  for (const eps of testEps) {
    const pPlus = { x: mid.x + n.x * eps, y: mid.y + n.y * eps };
    const pMinus = { x: mid.x - n.x * eps, y: mid.y - n.y * eps };
    
    const inPlus = pointInPolygon(pPlus, outerPoly);
    const inMinus = pointInPolygon(pMinus, outerPoly);
    
    // Debug log for first wall at 1m offset
    if (isFirstCall && eps === 1.0) {
      console.log(`[Footprint Debug] Wall ${wallId} @ eps=1.0m: pPlus(${pPlus.x.toFixed(2)}, ${pPlus.y.toFixed(2)})=${inPlus}, pMinus(${pMinus.x.toFixed(2)}, ${pMinus.y.toFixed(2)})=${inMinus}`);
    }
    
    if (inPlus !== inMinus) {
      const outN = inPlus ? { x: -n.x, y: -n.y } : n;
      console.log(`[Wall ${wallId}] EXTERIOR: eps=${eps}m, outN direction determined`);
      return { isExterior: true, outN };
    }
  }
  
  // Calculate direction from building centroid to wall midpoint (used for fallbacks)
  const centroid = polygonCentroid(outerPoly);
  const toMid = { x: mid.x - centroid.x, y: mid.y - centroid.y };
  const toMidLen = Math.sqrt(toMid.x * toMid.x + toMid.y * toMid.y);
  
  // Fallback #1: If wall midpoint is near boundary (within 5m), treat as exterior
  // Increased threshold to catch perimeter walls in buildings with complex footprints
  if (boundaryDist <= 5.0 && toMidLen > 0.01) {
    // IMPORTANT:
    // For boundary/bbox fallbacks we only know the wall is likely on the perimeter,
    // but the centroid->mid vector can be tangent to the wall, making left/right
    // selection unstable.
    // We therefore keep outN PERPENDICULAR to the wall (n) and only pick its SIGN
    // by comparing against the centroid direction.
    const sign = (n.x * toMid.x + n.y * toMid.y) >= 0 ? 1 : -1;
    const outN = { x: n.x * sign, y: n.y * sign };
    console.log(`[Wall ${wallId}] EXTERIOR (boundary fallback): dist=${boundaryDist.toFixed(3)}m`);
    return { isExterior: true, outN };
  }
  
  // Fallback #2: Check if wall is on the "edge" of the bounding box of the footprint
  // This catches perimeter walls that the point-in-polygon test missed
  const polyMinX = Math.min(...outerPoly.map(p => p.x));
  const polyMaxX = Math.max(...outerPoly.map(p => p.x));
  const polyMinY = Math.min(...outerPoly.map(p => p.y));
  const polyMaxY = Math.max(...outerPoly.map(p => p.y));
  
  const edgeMargin = 1.0; // 1.0m margin from bounding box edge
  const isOnBBoxEdge = 
    mid.x <= polyMinX + edgeMargin ||
    mid.x >= polyMaxX - edgeMargin ||
    mid.y <= polyMinY + edgeMargin ||
    mid.y >= polyMaxY - edgeMargin;
  
  if (isOnBBoxEdge && toMidLen > 0.01) {
    const sign = (n.x * toMid.x + n.y * toMid.y) >= 0 ? 1 : -1;
    const outN = { x: n.x * sign, y: n.y * sign };
    console.log(`[Wall ${wallId}] EXTERIOR (bbox edge fallback): mid=(${mid.x.toFixed(2)}, ${mid.y.toFixed(2)})`);
    return { isExterior: true, outN };
  }
  
  // Fallback #3: Normal alignment with centroid direction
  // If the wall normal aligns with the direction FROM centroid TO wall, it's likely exterior
  // This catches walls that are geometrically on the perimeter but failed other tests
  const normalDotToMid = (n.x * toMid.x + n.y * toMid.y) / toMidLen;
  const normalAlignment = Math.abs(normalDotToMid); // 0 = perpendicular, 1 = aligned
  
  // If normal is roughly aligned with centroid direction (>0.3), treat as exterior
  if (normalAlignment > 0.3 && toMidLen > 0.01) {
    // Choose outN direction: same as toMid if positive dot, opposite if negative
    const outN = normalDotToMid > 0 
      ? { x: n.x, y: n.y }
      : { x: -n.x, y: -n.y };
    console.log(`[Wall ${wallId}] EXTERIOR (normal alignment fallback): alignment=${normalAlignment.toFixed(2)}, dist=${boundaryDist.toFixed(2)}m`);
    return { isExterior: true, outN };
  }
  
  // Both sides equal at all offsets → interior partition wall
  if (isFirstCall) {
    console.log(`[Footprint Debug] Wall ${wallId} FAILED classification: boundaryDist=${boundaryDist.toFixed(2)}m, all inPlus===inMinus`);
  }
  console.log(`[Wall ${wallId}] PARTITION: all tests returned same value (boundaryDist=${boundaryDist.toFixed(2)}m)`);
  return { isExterior: false, outN: n };
}

// A wall is exterior if one side is outside the footprint hull
// Interior/partition walls have both sides inside the hull
function computeWallGeometry(
  wall: GraphWall,
  footprintHull: Point2D[],
  buildingCentroid: Point2D,
  chainSides?: Map<
    string,
    {
      outsideIsPositivePerp: boolean;
      isOutsideFootprint: boolean;
      classification: 'LEFT_EXT' | 'RIGHT_EXT' | 'BOTH_INT' | 'UNRESOLVED';
    }
  >
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
  let n2 = { x: u2.y, y: -u2.x };

  // IMPORTANT (rendering normal orientation):
  // Some payloads can flip wall.axis.u, which flips n2. That doesn't just affect
  // classification—it's critical for *rendering* because we offset stripes and
  // skin surfaces along +/-n2.
  //
  // We therefore normalize n2 so that +n2 always points from the LEFT polyline
  // towards the RIGHT polyline (geometrically), independent of axis sign.
  {
    const lMid = polylineMidpoint(leftPts);
    const rMid = polylineMidpoint(rightPts);
    const toRight = { x: rMid.x - lMid.x, y: rMid.y - lMid.y };
    const dot = toRight.x * n2.x + toRight.y * n2.y;
    if (dot < 0) n2 = { x: -n2.x, y: -n2.y };
  }

  // IMPORTANT:
  // chainSides (detectFootprintAndClassify) defines outsideIsPositivePerp relative to a
  // deterministic centerline direction (start->end). Some payloads provide wall.axis.u
  // with arbitrary sign, which flips n2 and can invert exterior side.
  // To avoid that, we compute a stable centerline-perp (nChain) from averaged endpoints
  // and use it ONLY for exterior-side decisions.
  const centerStart = {
    x: (leftPts[0].x + rightPts[0].x) / 2,
    y: (leftPts[0].y + rightPts[0].y) / 2,
  };
  const centerEnd = {
    x: (leftPts[leftPts.length - 1].x + rightPts[rightPts.length - 1].x) / 2,
    y: (leftPts[leftPts.length - 1].y + rightPts[rightPts.length - 1].y) / 2,
  };
  const chainDx = centerEnd.x - centerStart.x;
  const chainDy = centerEnd.y - centerStart.y;
  const chainLen = Math.sqrt(chainDx * chainDx + chainDy * chainDy);
  const uChain = chainLen > 1e-9 ? { x: chainDx / chainLen, y: chainDy / chainLen } : u2;
  const nChain = { x: uChain.y, y: -uChain.x };
  
  const wallLength = wall.length ?? Math.sqrt(
    Math.pow(leftPts[leftPts.length - 1].x - leftPts[0].x, 2) +
    Math.pow(leftPts[leftPts.length - 1].y - leftPts[0].y, 2)
  );
  
  // Calculate centerline midpoint (for the wall's center position)
  const wallCenterMid = {
    x: (leftPts[0].x + leftPts[leftPts.length - 1].x + rightPts[0].x + rightPts[rightPts.length - 1].x) / 4,
    y: (leftPts[0].y + leftPts[leftPts.length - 1].y + rightPts[0].y + rightPts[rightPts.length - 1].y) / 4,
  };
  
  // Prefer chain-based side classification when available (more robust and deterministic)
  const chainSide = chainSides?.get(String(wall.id));
  let isExterior = false;
  let outN = nChain;
  if (chainSide) {
    const cls = chainSide.classification;
    if (!chainSide.isOutsideFootprint && (cls === 'LEFT_EXT' || cls === 'RIGHT_EXT')) {
      isExterior = true;
      // outsideIsPositivePerp is defined against a deterministic (start->end) perp.
      // Use nChain here to avoid sign mismatches from wall.axis.u.
      outN = chainSide.outsideIsPositivePerp ? nChain : { x: -nChain.x, y: -nChain.y };
    } else {
      // If chain-based classification says PARTITION/UNRESOLVED, do a geometric sanity check.
      // This prevents perimeter walls from incorrectly falling into BOTH_INT due to minor graph issues.
      const check = chooseOutNormal(wallCenterMid, nChain, footprintHull, wall.id);
      isExterior = check.isExterior;
      outN = check.outN;

      // NOTE:
      // For cls=BOTH_INT that gets *promoted* to EXTERIOR via chooseOutNormal (boundary/bbox/etc),
      // we must NOT force outN from chainSide.outsideIsPositivePerp.
      // In BOTH_INT cases that flag can be a default and would incorrectly flip the exterior side.
    }
    // Debug log for chain-based classification
    console.log(`[Wall ${wall.id}] chainSides → cls=${cls}, isOutside=${chainSide.isOutsideFootprint}, outsideIsPosPerp=${chainSide.outsideIsPositivePerp} → isExterior=${isExterior}`);
  } else {
    // Fallback to geometric footprint sampling
    const check = chooseOutNormal(wallCenterMid, nChain, footprintHull, wall.id);
    isExterior = check.isExterior;
    outN = check.outN;
    console.log(`[Wall ${wall.id}] NO chainSide entry → fallback chooseOutNormal → isExterior=${isExterior}`);
  }
  
  let isExteriorWall = isExterior;
  let exteriorSide: 'left' | 'right' | null = null;
  
  if (isExteriorWall && footprintHull.length >= 3) {
    // Determine which polyline (left or right) is on the exterior side
    // by testing which midpoint is further in the outN direction
    
    // Calculate midpoints of each polyline.
    // IMPORTANT: endpoints-midpoint is not reliable when offsets have many segments
    // (e.g., corners/curves/joins). Use arclength midpoint.
    const leftMid = polylineMidpoint(leftPts);
    const rightMid = polylineMidpoint(rightPts);
    
    // Vector from wall center to left polyline midpoint
    const toLeft = { 
      x: leftMid.x - wallCenterMid.x, 
      y: leftMid.y - wallCenterMid.y 
    };
    
    // Dot product with outN - positive means left is on exterior side
    const dotLeft = toLeft.x * outN.x + toLeft.y * outN.y;
    
    // If dotLeft is ambiguous (close to 0), use direct point-in-polygon test
    const DOT_THRESHOLD = 0.15; // threshold for ambiguous cases
    
    if (Math.abs(dotLeft) < DOT_THRESHOLD) {
      // Ambiguous case: use distance to footprint boundary as the tiebreaker.
      // The polyline CLOSER to the footprint edge is on the exterior side.
      const leftDistToBoundary = distanceToPolygonBoundary(leftMid, footprintHull);
      const rightDistToBoundary = distanceToPolygonBoundary(rightMid, footprintHull);
      
      // If one side is significantly closer to boundary (>5cm difference), use that
      const BOUNDARY_DIFF_THRESHOLD = 0.05; // 50mm
      const boundaryDiff = leftDistToBoundary - rightDistToBoundary;
      
      if (Math.abs(boundaryDiff) > BOUNDARY_DIFF_THRESHOLD) {
        // Pick the side CLOSER to the footprint boundary (smaller distance)
        exteriorSide = leftDistToBoundary < rightDistToBoundary ? 'left' : 'right';
        console.log(`[Wall ${wall.id}] isExterior: true, exteriorPolyline: ${exteriorSide} (boundary dist: L=${leftDistToBoundary.toFixed(3)}, R=${rightDistToBoundary.toFixed(3)})`);
      } else {
        // Boundary distances are too similar - use offset PIP test
        const TEST_OFFSETS = [0.25, 0.6, 1.0]; // meters

        // IMPORTANT:
        // We MUST test along the wall normal (n2), not along (center->leftMid).
        // In some geometries center->leftMid can become nearly tangent to the wall,
        // making the PIP test meaningless and causing the logic to fall back to
        // boundary distances (which are often equal within 1-2mm).
        //
        // Here we probe the two half-spaces (+n2 and -n2) and then map them back
        // to left/right using the sign of dot(toLeft, n2).

        const dotLeftN = toLeft.x * n2.x + toLeft.y * n2.y;
        const leftIsPlusN = dotLeftN >= 0;

        const testHalfSpace = (sign: 1 | -1) => {
          for (const d of TEST_OFFSETS) {
            const p = { x: wallCenterMid.x + n2.x * d * sign, y: wallCenterMid.y + n2.y * d * sign };
            if (!pointInPolygon(p, footprintHull)) return 'outside' as const;
          }
          return 'inside' as const;
        };

        const plusTest = testHalfSpace(1);
        const minusTest = testHalfSpace(-1);

        const leftTest = leftIsPlusN ? plusTest : minusTest;
        const rightTest = leftIsPlusN ? minusTest : plusTest;

        if (leftTest === 'outside' && rightTest !== 'outside') {
          exteriorSide = 'left';
          console.log(`[Wall ${wall.id}] isExterior: true, exteriorPolyline: left (offset PIP: left outside)`);
        } else if (rightTest === 'outside' && leftTest !== 'outside') {
          exteriorSide = 'right';
          console.log(`[Wall ${wall.id}] isExterior: true, exteriorPolyline: right (offset PIP: right outside)`);
        } else {
          // Final fallback: use boundary distance (the closer one is exterior)
          exteriorSide = leftDistToBoundary < rightDistToBoundary ? 'left' : 'right';
          console.log(`[Wall ${wall.id}] isExterior: true, exteriorPolyline: ${exteriorSide} (final fallback boundary: L=${leftDistToBoundary.toFixed(3)}, R=${rightDistToBoundary.toFixed(3)})`);
        }
      }
    } else {
      exteriorSide = dotLeft > 0 ? 'left' : 'right';
      console.log(`[Wall ${wall.id}] isExterior: true, exteriorPolyline: ${exteriorSide}, dotLeft: ${dotLeft.toFixed(3)}`);
    }
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
      <meshStandardMaterial
        color={displayColor}
        side={THREE.DoubleSide}
        depthWrite={true}
        depthTest={true}
        transparent={false}
        opacity={1}
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
      depthTest={true}
      depthWrite={false}
      renderOrder={10}
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
        <meshStandardMaterial color={displayColor} side={THREE.DoubleSide} depthWrite={true} depthTest={true} transparent={false} opacity={1} />
      </mesh>
      
      {/* Right surface */}
      <mesh geometry={rightGeom} renderOrder={5}>
        <meshStandardMaterial color={displayColor} side={THREE.DoubleSide} depthWrite={true} depthTest={true} transparent={false} opacity={1} />
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
  chainSides?: Map<
    string,
    {
      outsideIsPositivePerp: boolean;
      isOutsideFootprint: boolean;
      classification: 'LEFT_EXT' | 'RIGHT_EXT' | 'BOTH_INT' | 'UNRESOLVED';
    }
  >;
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
  chainSides,
  coreThickness,
  isSelected,
  onWallClick,
}: WallRendererProps) {
  const wallGeom = useMemo(
    () => computeWallGeometry(wall, footprintHull, buildingCentroid, chainSides),
    [wall, footprintHull, buildingCentroid, chainSides]
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

// ===== Footprint Debug Visualization =====

interface FootprintDebugProps {
  hull: Point2D[];
  centroid: Point2D;
  source: FootprintSource;
  exteriorWallCount: number;
  totalWallCount: number;
}

function FootprintDebugViz({ hull, centroid, source, exteriorWallCount, totalWallCount }: FootprintDebugProps) {
  // Calculate additional debug info
  const area = hull.length >= 3 ? Math.abs(signedPolygonAreaLocal(hull)) : 0;
  const orientation = hull.length >= 3 
    ? (signedPolygonAreaLocal(hull) > 0 ? 'CCW ✓' : 'CW ⚠️') 
    : 'N/A';

  if (hull.length < 3) {
    return (
      <Html position={[centroid.x, 0.5, centroid.y]} center>
        <div className="bg-red-600/90 text-white px-3 py-2 rounded-lg text-xs font-mono shadow-lg">
          <div className="font-bold">⚠️ Footprint: NONE</div>
          <div className="text-red-200">Source: {source}</div>
          <div className="text-red-200">Todas paredes = interior</div>
        </div>
      </Html>
    );
  }

  // Create closed loop for Line
  const points = hull.map(p => new THREE.Vector3(p.x, 0.02, p.y));
  points.push(points[0].clone()); // Close the loop

  return (
    <group>
      {/* Footprint polygon outline - green */}
      <Line
        points={points}
        color="#22c55e"
        lineWidth={3}
        depthTest={false}
        depthWrite={false}
        renderOrder={100}
      />
      
      {/* Centroid marker */}
      <mesh position={[centroid.x, 0.15, centroid.y]}>
        <sphereGeometry args={[0.15, 16, 16]} />
        <meshBasicMaterial color="#22c55e" transparent opacity={0.8} depthTest={false} />
      </mesh>
      
      {/* Info label */}
      <Html position={[centroid.x, 0.8, centroid.y]} center>
        <div className="bg-green-700/95 text-white px-3 py-2 rounded-lg text-xs font-mono shadow-lg min-w-[180px]">
          <div className="font-bold text-green-200">🔍 Footprint Debug</div>
          <div className="border-t border-green-500 my-1 pt-1">
            <div>Source: <span className="text-green-300 font-bold">{source.toUpperCase()}</span></div>
            <div>Points: <span className="text-green-300">{hull.length}</span></div>
            <div>Orientation: <span className="text-green-300">{orientation}</span></div>
            <div>Area: <span className="text-green-300">{area.toFixed(1)} m²</span></div>
            <div>Exterior walls: <span className="text-blue-300">{exteriorWallCount}</span> / {totalWallCount}</div>
          </div>
        </div>
      </Html>
    </group>
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
  showFootprintDebug = false,
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
    () => computeBuildingFootprint(adjustedWalls, adjustedNodes, normalizedAnalysis, centerOffset),
    [adjustedWalls, adjustedNodes, normalizedAnalysis, centerOffset]
  );
  const { hull: footprintHull, centroid: buildingCentroid, source: footprintSource, chainSides } = buildingFootprint;

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

  // Count skipped walls and exterior walls
  const wallStats = useMemo(() => {
    let valid = 0;
    let skipped = 0;
    let exteriorCount = 0;

    for (const wall of adjustedWalls) {
      const geom = computeWallGeometry(wall, footprintHull, buildingCentroid, chainSides);
      if (!geom) {
        skipped++;
      } else {
        valid++;
        if (geom.isExteriorWall) exteriorCount++;
      }
    }

    return { valid, skipped, exteriorCount };
  }, [adjustedWalls, footprintHull, buildingCentroid, chainSides]);

  useEffect(() => {
    setSkippedCount(wallStats.skipped);
  }, [wallStats.skipped]);

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
          chainSides={chainSides}
          coreThickness={coreThickness}
          isSelected={wall.id === selectedWallId}
          onWallClick={onWallClick}
        />
      ))}

      <NodeSpheres nodes={adjustedNodes} />

      {showCourseMarkers && courses.length > 0 && (
        <CourseLabels courses={courses} bounds={bounds} />
      )}

      {showFootprintDebug && (
        <FootprintDebugViz
          hull={footprintHull}
          centroid={buildingCentroid}
          source={footprintSource}
          exteriorWallCount={wallStats.exteriorCount}
          totalWallCount={wallStats.valid}
        />
      )}
    </group>
  );
}
