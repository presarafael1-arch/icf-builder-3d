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
  EXTERIOR_OVERLAY: 0x2196f3, // Blue overlay for exterior
  INTERIOR: 0xf5f5f5,         // Light gray/white for interior
  OUTLINE: 0x333333,          // Dark outline
  COURSE_LINE: 0x555555,      // Course line color
  NODE: 0x4caf50,             // Green for nodes
  SELECTED: 0x00bcd4,         // Cyan for selected
};

// Skin/EPS thickness (1 TOOTH ≈ 70.6mm)
const EPS_THICKNESS = 0.0706; // meters
const DEFAULT_CORE_THICKNESS = 0.15; // 150mm default

// ===== Point-in-Polygon for exterior detection =====

function pointInPolygon(px: number, py: number, polygon: Array<{ x: number; y: number }>): boolean {
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

// ===== Compute outer polygon from wall offsets =====

function computeOuterPolygon(walls: GraphWall[]): Array<{ x: number; y: number }> {
  // Collect all exterior points from walls
  const allPoints: Array<{ x: number; y: number }> = [];
  
  for (const wall of walls) {
    const leftPts = filterValidPoints((wall.offsets?.left as unknown[]) || []);
    const rightPts = filterValidPoints((wall.offsets?.right as unknown[]) || []);
    allPoints.push(...leftPts, ...rightPts);
  }
  
  if (allPoints.length < 3) return [];
  
  // Compute convex hull (Graham scan)
  const sorted = allPoints.slice().sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
  
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  
  const lower: Array<{ x: number; y: number }> = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  
  const upper: Array<{ x: number; y: number }> = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  
  lower.pop();
  upper.pop();
  
  return [...lower, ...upper];
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

// Determine wall exterior status using outer polygon
function computeWallGeometry(
  wall: GraphWall,
  outerPolygon: Array<{ x: number; y: number }>
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
  
  // Determine exterior status using outer polygon
  const EPS = 0.05; // 50mm test offset
  
  // Midpoint of left and right polylines
  const leftMid = {
    x: (leftPts[0].x + leftPts[leftPts.length - 1].x) / 2,
    y: (leftPts[0].y + leftPts[leftPts.length - 1].y) / 2,
  };
  const rightMid = {
    x: (rightPts[0].x + rightPts[rightPts.length - 1].x) / 2,
    y: (rightPts[0].y + rightPts[rightPts.length - 1].y) / 2,
  };
  
  // Wall midpoint
  const wallMid = {
    x: (leftMid.x + rightMid.x) / 2,
    y: (leftMid.y + rightMid.y) / 2,
  };
  
  // Test points perpendicular to wall
  const testLeft = { x: wallMid.x + n2.x * EPS, y: wallMid.y + n2.y * EPS };
  const testRight = { x: wallMid.x - n2.x * EPS, y: wallMid.y - n2.y * EPS };
  
  const leftInside = outerPolygon.length >= 3 ? pointInPolygon(testLeft.x, testLeft.y, outerPolygon) : true;
  const rightInside = outerPolygon.length >= 3 ? pointInPolygon(testRight.x, testRight.y, outerPolygon) : true;
  
  let isExteriorWall = false;
  let exteriorSide: 'left' | 'right' | null = null;
  
  if (!leftInside && rightInside) {
    // Left side is outside polygon = exterior wall, left faces out
    isExteriorWall = true;
    exteriorSide = 'left';
  } else if (leftInside && !rightInside) {
    // Right side is outside = exterior wall, right faces out
    isExteriorWall = true;
    exteriorSide = 'right';
  } else if (!leftInside && !rightInside) {
    // Both outside (shouldn't happen in normal geometry)
    isExteriorWall = true;
    // Use distance to polygon centroid as fallback
    const polyCentroid = outerPolygon.length >= 3 
      ? { x: outerPolygon.reduce((s, p) => s + p.x, 0) / outerPolygon.length, 
          y: outerPolygon.reduce((s, p) => s + p.y, 0) / outerPolygon.length }
      : { x: 0, y: 0 };
    const leftDist = Math.sqrt((leftMid.x - polyCentroid.x) ** 2 + (leftMid.y - polyCentroid.y) ** 2);
    const rightDist = Math.sqrt((rightMid.x - polyCentroid.x) ** 2 + (rightMid.y - polyCentroid.y) ** 2);
    exteriorSide = leftDist > rightDist ? 'left' : 'right';
  }
  // else: both inside = interior wall, no exterior side
  
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
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={displayColor}
        side={THREE.DoubleSide}
        transparent
        opacity={0.9}
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
  
  return <Line points={points} color={COLORS.OUTLINE} lineWidth={1.5} />;
}

// ===== Blue Exterior Overlay Stripes =====

interface ExteriorOverlayProps {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  startPt: { x: number; y: number };
  u2: { x: number; y: number };
  n2: { x: number; y: number };
}

function ExteriorOverlay({ x0, x1, z0, z1, startPt, u2, n2 }: ExteriorOverlayProps) {
  // Offset slightly outward to avoid z-fighting
  const offset = 0.002;
  const offsetPt = { x: startPt.x + n2.x * offset, y: startPt.y + n2.y * offset };
  
  const bl = { x: offsetPt.x + u2.x * x0, y: offsetPt.y + u2.y * x0 };
  const br = { x: offsetPt.x + u2.x * x1, y: offsetPt.y + u2.y * x1 };
  
  const lines: JSX.Element[] = [];
  
  // Vertical blue lines at panel boundaries
  lines.push(
    <Line
      key="v-left"
      points={[
        new THREE.Vector3(bl.x, z0, bl.y),
        new THREE.Vector3(bl.x, z1, bl.y),
      ]}
      color={COLORS.EXTERIOR_OVERLAY}
      lineWidth={2}
    />
  );
  lines.push(
    <Line
      key="v-right"
      points={[
        new THREE.Vector3(br.x, z0, br.y),
        new THREE.Vector3(br.x, z1, br.y),
      ]}
      color={COLORS.EXTERIOR_OVERLAY}
      lineWidth={2}
    />
  );
  
  // Horizontal stripes
  const stripeSpacing = 0.1; // 100mm
  const stripeCount = Math.floor((z1 - z0) / stripeSpacing);
  for (let i = 0; i <= stripeCount; i++) {
    const z = z0 + i * stripeSpacing;
    if (z > z1) break;
    lines.push(
      <Line
        key={`h-${i}`}
        points={[
          new THREE.Vector3(bl.x, z, bl.y),
          new THREE.Vector3(br.x, z, br.y),
        ]}
        color={COLORS.EXTERIOR_OVERLAY}
        lineWidth={1}
        transparent
        opacity={0.6}
      />
    );
  }
  
  // Cross diagonals for mesh effect
  lines.push(
    <Line
      key="diag1"
      points={[
        new THREE.Vector3(bl.x, z0, bl.y),
        new THREE.Vector3(br.x, z1, br.y),
      ]}
      color={COLORS.EXTERIOR_OVERLAY}
      lineWidth={0.5}
      transparent
      opacity={0.4}
    />
  );
  lines.push(
    <Line
      key="diag2"
      points={[
        new THREE.Vector3(br.x, z0, br.y),
        new THREE.Vector3(bl.x, z1, bl.y),
      ]}
      color={COLORS.EXTERIOR_OVERLAY}
      lineWidth={0.5}
      transparent
      opacity={0.4}
    />
  );
  
  return <group renderOrder={1}>{lines}</group>;
}

// ===== Single Panel (Dual Skin) =====

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
  
  // Panel base color
  const panelColor = panel.type === 'FULL' ? COLORS.PANEL_FULL : COLORS.PANEL_CUT;
  
  // Calculate skin start points
  // Exterior skin: on the side facing out
  // Interior skin: on the side facing in
  // Separation = coreThickness (between inner faces of EPS panels)
  
  // Get the polyline start points for left and right
  const leftStart = leftPts[0];
  const rightStart = rightPts[0];
  
  // Determine which polyline is exterior and which is interior
  let extStart: { x: number; y: number };
  let intStart: { x: number; y: number };
  let extNormal: { x: number; y: number };
  
  if (exteriorSide === 'left') {
    extStart = leftStart;
    intStart = rightStart;
    extNormal = n2; // Points in direction of left
  } else if (exteriorSide === 'right') {
    extStart = rightStart;
    intStart = leftStart;
    extNormal = { x: -n2.x, y: -n2.y }; // Points in direction of right
  } else {
    // Interior wall: both sides are "interior" colored
    extStart = leftStart;
    intStart = rightStart;
    extNormal = n2;
  }
  
  return (
    <group>
      {/* Exterior Skin */}
      <PanelSkin
        x0={x0}
        x1={x1}
        z0={z0}
        z1={z1}
        startPt={extStart}
        u2={u2}
        color={isExteriorWall ? panelColor : COLORS.INTERIOR}
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
      
      {/* Blue overlay on exterior face of exterior walls */}
      {isExteriorWall && (
        <ExteriorOverlay
          x0={x0}
          x1={x1}
          z0={z0}
          z1={z1}
          startPt={extStart}
          u2={u2}
          n2={extNormal}
        />
      )}
      
      {/* Interior Skin */}
      <PanelSkin
        x0={x0}
        x1={x1}
        z0={z0}
        z1={z1}
        startPt={intStart}
        u2={u2}
        color={COLORS.INTERIOR}
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
  
  // Determine colors
  const leftColor = isExteriorWall && exteriorSide === 'left' ? COLORS.PANEL_FULL : COLORS.INTERIOR;
  const rightColor = isExteriorWall && exteriorSide === 'right' ? COLORS.PANEL_FULL : COLORS.INTERIOR;
  
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
  
  // Exterior overlay for fallback
  const extStripes: JSX.Element[] = [];
  if (isExteriorWall) {
    const extPts = exteriorSide === 'left' ? leftPts : rightPts;
    const extNormal = exteriorSide === 'left' ? n2 : { x: -n2.x, y: -n2.y };
    const offset = 0.002;
    
    // Horizontal stripes
    const stripeSpacing = 0.1;
    const stripeCount = Math.floor(wallHeight / stripeSpacing);
    for (let i = 0; i <= stripeCount; i++) {
      const z = i * stripeSpacing;
      if (z > wallHeight) break;
      const linePts = extPts.map(p => new THREE.Vector3(
        p.x + extNormal.x * offset,
        z,
        p.y + extNormal.y * offset
      ));
      extStripes.push(
        <Line
          key={`stripe-${i}`}
          points={linePts}
          color={COLORS.EXTERIOR_OVERLAY}
          lineWidth={1}
          transparent
          opacity={0.6}
        />
      );
    }
  }
  
  const displayColorLeft = isSelected ? COLORS.SELECTED : leftColor;
  const displayColorRight = isSelected ? COLORS.SELECTED : rightColor;
  
  return (
    <group>
      {/* Left surface */}
      <mesh geometry={leftGeom}>
        <meshStandardMaterial color={displayColorLeft} side={THREE.DoubleSide} transparent opacity={0.9} />
      </mesh>
      
      {/* Right surface */}
      <mesh geometry={rightGeom}>
        <meshStandardMaterial color={displayColorRight} side={THREE.DoubleSide} transparent opacity={0.9} />
      </mesh>
      
      {/* Course lines */}
      {courseLines}
      
      {/* Module lines */}
      {moduleLines}
      
      {/* Exterior overlay stripes */}
      {extStripes}
      
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
  outerPolygon: Array<{ x: number; y: number }>;
  coreThickness: number;
  isSelected: boolean;
  onWallClick?: (wallId: string) => void;
}

function WallRenderer({
  wall,
  wallHeight,
  courses,
  panels,
  outerPolygon,
  coreThickness,
  isSelected,
  onWallClick,
}: WallRendererProps) {
  const wallGeom = useMemo(
    () => computeWallGeometry(wall, outerPolygon),
    [wall, outerPolygon]
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

  // Compute outer polygon for exterior detection
  const outerPolygon = useMemo(
    () => computeOuterPolygon(adjustedWalls),
    [adjustedWalls]
  );

  // Log for debugging
  useEffect(() => {
    console.log('[ExternalEngineRenderer] Rendering:', {
      walls: walls.length,
      panels: panels.length,
      courses: courses.length,
      wallHeight,
      thickness: coreThickness,
      centerOffset,
      outerPolygonPts: outerPolygon.length,
    });
  }, [walls, panels, courses, wallHeight, coreThickness, centerOffset, outerPolygon]);

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
      const geom = computeWallGeometry(wall, outerPolygon);
      if (!geom) skipped++;
      else valid++;
    }

    return { valid, skipped };
  }, [adjustedWalls, outerPolygon]);

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
          outerPolygon={outerPolygon}
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
