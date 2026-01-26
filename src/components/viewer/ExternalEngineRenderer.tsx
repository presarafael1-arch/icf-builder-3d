/**
 * ExternalEngineRenderer - Standard External Engine 3D Render
 * 
 * When "External Engine" is active, this is the ONLY renderer.
 * All geometry comes from the external motor (source of truth).
 * 
 * Features:
 * - Wall extrusion from left/right offset polylines
 * - Exterior vs interior detection using wall.axis.n and perpendicular check
 * - Exterior face: blue with horizontal stripe overlay (faixa)
 * - Interior face: white/gray solid
 * - Always-visible outlines (walls, courses, modules/panels)
 * - Panel rendering: FULL=yellow, CUT=red with outlines
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
// Backend may return points as [x, y], {x, y}, or {0: x, 1: y}

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
  EXTERIOR: 0x2196f3,       // Blue
  INTERIOR: 0xf5f5f5,       // Light gray/white
  EXTERIOR_STRIPE: 0x42a5f5, // Lighter blue for stripes
  OUTLINE: 0x333333,        // Dark outline
  COURSE_LINE: 0x666666,    // Course line color
  MODULE_LINE: 0x888888,    // Module/placeholder line
  PANEL_FULL: 0xffc107,     // Yellow for FULL
  PANEL_CUT: 0xf44336,      // Red for CUT
  NODE: 0x4caf50,           // Green for nodes
  SELECTED: 0x00bcd4,       // Cyan for selected
};

// ===== Wall Geometry Data =====

interface WallGeometryData {
  leftPts: { x: number; y: number }[];
  rightPts: { x: number; y: number }[];
  u2: { x: number; y: number };      // Unit vector along wall (2D)
  n2: { x: number; y: number };      // Normal vector (perpendicular, 2D)
  length: number;
  isLeftExterior: boolean;           // True if left side is exterior
}

// Compute wall geometry from offsets and axis
function computeWallGeometry(
  wall: GraphWall,
  centroid: { x: number; y: number }
): WallGeometryData | null {
  // Get left/right offset points
  const leftPts = filterValidPoints((wall.offsets?.left as unknown[]) || []);
  const rightPts = filterValidPoints((wall.offsets?.right as unknown[]) || []);
  
  if (leftPts.length < 2 || rightPts.length < 2) {
    return null;
  }
  
  // Get axis vectors from wall data, or compute from points
  let u2 = { x: 1, y: 0 };
  let n2 = { x: 0, y: 1 };
  
  if (wall.axis?.u) {
    u2 = toVec2(wall.axis.u);
  } else {
    // Compute from left points
    const dx = leftPts[leftPts.length - 1].x - leftPts[0].x;
    const dy = leftPts[leftPts.length - 1].y - leftPts[0].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      u2 = { x: dx / len, y: dy / len };
    }
  }
  
  if (wall.axis?.n) {
    n2 = toVec2(wall.axis.n);
  } else {
    // Perpendicular: perp(u) = (u.y, -u.x) for right-hand rule
    n2 = { x: u2.y, y: -u2.x };
  }
  
  // Wall length
  const wallLength = wall.length ?? Math.sqrt(
    Math.pow(leftPts[leftPts.length - 1].x - leftPts[0].x, 2) +
    Math.pow(leftPts[leftPts.length - 1].y - leftPts[0].y, 2)
  );
  
  // Determine which side is exterior using perpendicular normal
  // The exterior is the side that is FURTHER from the building centroid
  
  // Calculate normal of left polyline
  const leftDir = {
    x: leftPts[leftPts.length - 1].x - leftPts[0].x,
    y: leftPts[leftPts.length - 1].y - leftPts[0].y,
  };
  const leftLen = Math.sqrt(leftDir.x * leftDir.x + leftDir.y * leftDir.y);
  if (leftLen > 0) {
    leftDir.x /= leftLen;
    leftDir.y /= leftLen;
  }
  
  // Perpendicular of left direction: perp = (y, -x)
  const leftNormal = { x: leftDir.y, y: -leftDir.x };
  
  // Check if leftNormal points toward centroid or away
  const leftMid = {
    x: (leftPts[0].x + leftPts[leftPts.length - 1].x) / 2,
    y: (leftPts[0].y + leftPts[leftPts.length - 1].y) / 2,
  };
  
  // Vector from left midpoint to centroid
  const toCenter = {
    x: centroid.x - leftMid.x,
    y: centroid.y - leftMid.y,
  };
  
  // Dot product: if positive, leftNormal points toward center (so left is interior)
  // If negative, leftNormal points away from center (so left is exterior)
  const dotProduct = leftNormal.x * toCenter.x + leftNormal.y * toCenter.y;
  
  // Also check distance from centroid as fallback
  const rightMid = {
    x: (rightPts[0].x + rightPts[rightPts.length - 1].x) / 2,
    y: (rightPts[0].y + rightPts[rightPts.length - 1].y) / 2,
  };
  
  const leftDist = Math.sqrt((leftMid.x - centroid.x) ** 2 + (leftMid.y - centroid.y) ** 2);
  const rightDist = Math.sqrt((rightMid.x - centroid.x) ** 2 + (rightMid.y - centroid.y) ** 2);
  
  // Use perpendicular test primarily, distance as tiebreaker
  let isLeftExterior: boolean;
  if (Math.abs(dotProduct) < 0.001) {
    // Very small dot product - use distance fallback
    isLeftExterior = leftDist > rightDist;
  } else {
    // Normal pointing away from center means that side is exterior
    isLeftExterior = dotProduct < 0;
  }
  
  return {
    leftPts,
    rightPts,
    u2,
    n2,
    length: wallLength,
    isLeftExterior,
  };
}

// Calculate building centroid from nodes
function calculateCentroid(nodes: GraphNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: 0 };
  
  let sumX = 0, sumY = 0;
  let count = 0;
  
  for (const node of nodes) {
    const x = px(node.position);
    const y = py(node.position);
    if (x !== undefined && y !== undefined) {
      sumX += x;
      sumY += y;
      count++;
    }
  }
  
  if (count === 0) return { x: 0, y: 0 };
  return { x: sumX / count, y: sumY / count };
}

// ===== Wall Extrusion Geometry =====
// Creates extruded geometry from a closed shape (left + reversed right points)

function createWallExtrusionGeometry(
  leftPts: { x: number; y: number }[],
  rightPts: { x: number; y: number }[],
  wallHeight: number
): THREE.ExtrudeGeometry | null {
  if (leftPts.length < 2 || rightPts.length < 2) return null;
  
  // Create closed shape: left[0] -> left[n] -> right[n] -> right[0] -> left[0]
  const shape = new THREE.Shape();
  
  // Start from left[0]
  shape.moveTo(leftPts[0].x, leftPts[0].y);
  
  // Draw along left side
  for (let i = 1; i < leftPts.length; i++) {
    shape.lineTo(leftPts[i].x, leftPts[i].y);
  }
  
  // Draw along right side (reversed)
  for (let i = rightPts.length - 1; i >= 0; i--) {
    shape.lineTo(rightPts[i].x, rightPts[i].y);
  }
  
  // Close the shape
  shape.lineTo(leftPts[0].x, leftPts[0].y);
  
  // Extrude settings
  const extrudeSettings: THREE.ExtrudeGeometryOptions = {
    depth: wallHeight,
    bevelEnabled: false,
    steps: 1,
  };
  
  // Create geometry - extruded in Z direction
  const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  
  // Rotate to make Y up (extrude went in local Z, we need world Y)
  geometry.rotateX(-Math.PI / 2);
  
  return geometry;
}

// ===== Wall Surface (separate faces for exterior/interior) =====

interface WallSurfaceProps {
  pts: { x: number; y: number }[];
  wallHeight: number;
  color: number;
  isExterior: boolean;
  isSelected: boolean;
}

function WallSurface({ pts, wallHeight, color, isExterior, isSelected }: WallSurfaceProps) {
  // Create a strip geometry from the polyline
  const geometry = useMemo(() => {
    const vertices: number[] = [];
    const indices: number[] = [];
    
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      // Bottom vertex
      vertices.push(p.x, 0, p.y);
      // Top vertex
      vertices.push(p.x, wallHeight, p.y);
    }
    
    // Create triangles connecting adjacent vertices
    for (let i = 0; i < pts.length - 1; i++) {
      const bl = i * 2;       // bottom-left
      const tl = i * 2 + 1;   // top-left
      const br = (i + 1) * 2; // bottom-right
      const tr = (i + 1) * 2 + 1; // top-right
      
      // Two triangles per quad
      indices.push(bl, br, tl);
      indices.push(tl, br, tr);
    }
    
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
  }, [pts, wallHeight]);
  
  const displayColor = isSelected ? COLORS.SELECTED : color;
  
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={displayColor}
        transparent
        opacity={isExterior ? 0.85 : 0.9}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// ===== Horizontal Stripe Lines (faixa effect for exterior) =====

interface ExteriorStripeLinesProps {
  pts: { x: number; y: number }[];
  wallHeight: number;
  stripeSpacing?: number;
}

function ExteriorStripeLines({ pts, wallHeight, stripeSpacing = 0.1 }: ExteriorStripeLinesProps) {
  const stripeCount = Math.floor(wallHeight / stripeSpacing);
  
  if (pts.length < 2 || stripeCount < 1) return null;
  
  const lines: JSX.Element[] = [];
  
  for (let i = 0; i <= stripeCount; i++) {
    const y = i * stripeSpacing;
    if (y > wallHeight) break;
    
    const linePoints = pts.map(p => new THREE.Vector3(p.x, y, p.y));
    
    lines.push(
      <Line
        key={`stripe-${i}`}
        points={linePoints}
        color={COLORS.EXTERIOR_STRIPE}
        lineWidth={0.8}
        transparent
        opacity={0.6}
      />
    );
  }
  
  return <group>{lines}</group>;
}

// ===== Wall Outlines =====

interface WallOutlinesProps {
  leftPts: { x: number; y: number }[];
  rightPts: { x: number; y: number }[];
  wallHeight: number;
}

function WallOutlines({ leftPts, rightPts, wallHeight }: WallOutlinesProps) {
  if (leftPts.length < 2 || rightPts.length < 2) return null;

  // Bottom loop: left -> right (reversed) -> back to start
  const bottomLoop = [
    ...leftPts.map(p => new THREE.Vector3(p.x, 0, p.y)),
    ...[...rightPts].reverse().map(p => new THREE.Vector3(p.x, 0, p.y)),
  ];
  bottomLoop.push(bottomLoop[0].clone());

  // Top loop
  const topLoop = [
    ...leftPts.map(p => new THREE.Vector3(p.x, wallHeight, p.y)),
    ...[...rightPts].reverse().map(p => new THREE.Vector3(p.x, wallHeight, p.y)),
  ];
  topLoop.push(topLoop[0].clone());

  // Vertical edges at corners
  const verticals: THREE.Vector3[][] = [];
  
  // Left side start and end
  verticals.push([
    new THREE.Vector3(leftPts[0].x, 0, leftPts[0].y),
    new THREE.Vector3(leftPts[0].x, wallHeight, leftPts[0].y),
  ]);
  verticals.push([
    new THREE.Vector3(leftPts[leftPts.length - 1].x, 0, leftPts[leftPts.length - 1].y),
    new THREE.Vector3(leftPts[leftPts.length - 1].x, wallHeight, leftPts[leftPts.length - 1].y),
  ]);
  
  // Right side start and end
  verticals.push([
    new THREE.Vector3(rightPts[0].x, 0, rightPts[0].y),
    new THREE.Vector3(rightPts[0].x, wallHeight, rightPts[0].y),
  ]);
  verticals.push([
    new THREE.Vector3(rightPts[rightPts.length - 1].x, 0, rightPts[rightPts.length - 1].y),
    new THREE.Vector3(rightPts[rightPts.length - 1].x, wallHeight, rightPts[rightPts.length - 1].y),
  ]);

  return (
    <group>
      <Line points={bottomLoop} color={COLORS.OUTLINE} lineWidth={2} />
      <Line points={topLoop} color={COLORS.OUTLINE} lineWidth={2} />
      {verticals.map((pts, i) => (
        <Line key={`vert-${i}`} points={pts} color={COLORS.OUTLINE} lineWidth={2} />
      ))}
    </group>
  );
}

// ===== Course Lines (horizontal at each course height) =====

interface CourseLinesProps {
  courses: Course[];
  leftPts: { x: number; y: number }[];
  rightPts: { x: number; y: number }[];
}

function CourseLines({ courses, leftPts, rightPts }: CourseLinesProps) {
  if (courses.length === 0 || leftPts.length < 2 || rightPts.length < 2) {
    return null;
  }

  return (
    <group>
      {courses.map((course) => {
        const z = course.z1 ?? 0;
        
        const leftLinePoints = leftPts.map(p => new THREE.Vector3(p.x, z, p.y));
        const rightLinePoints = rightPts.map(p => new THREE.Vector3(p.x, z, p.y));

        return (
          <group key={`course-${course.index}`}>
            <Line
              points={leftLinePoints}
              color={COLORS.COURSE_LINE}
              lineWidth={1}
              dashed={false}
            />
            <Line
              points={rightLinePoints}
              color={COLORS.COURSE_LINE}
              lineWidth={1}
              dashed={false}
            />
          </group>
        );
      })}
    </group>
  );
}

// ===== Module Lines (vertical lines at 1.2m intervals when no panels) =====

interface ModuleLinesProps {
  wallGeom: WallGeometryData;
  wallHeight: number;
}

function ModuleLines({ wallGeom, wallHeight }: ModuleLinesProps) {
  const moduleSpacing = 1.2; // 1200mm = 1.2m
  const { length, leftPts, rightPts, u2 } = wallGeom;
  
  if (length < moduleSpacing) return null;
  
  const moduleCount = Math.floor(length / moduleSpacing);
  const lines: JSX.Element[] = [];
  
  // Get start points for left and right
  const startLeft = leftPts[0];
  const startRight = rightPts[0];
  
  // Direction along left and right polylines
  const leftDir = {
    x: leftPts[leftPts.length - 1].x - leftPts[0].x,
    y: leftPts[leftPts.length - 1].y - leftPts[0].y,
  };
  const leftLen = Math.sqrt(leftDir.x * leftDir.x + leftDir.y * leftDir.y);
  if (leftLen > 0) {
    leftDir.x /= leftLen;
    leftDir.y /= leftLen;
  }
  
  const rightDir = {
    x: rightPts[rightPts.length - 1].x - rightPts[0].x,
    y: rightPts[rightPts.length - 1].y - rightPts[0].y,
  };
  const rightLen = Math.sqrt(rightDir.x * rightDir.x + rightDir.y * rightDir.y);
  if (rightLen > 0) {
    rightDir.x /= rightLen;
    rightDir.y /= rightLen;
  }

  for (let k = 1; k <= moduleCount; k++) {
    const t = k * moduleSpacing;

    // Left face line
    const lx = startLeft.x + leftDir.x * t;
    const ly = startLeft.y + leftDir.y * t;
    lines.push(
      <Line
        key={`mod-l-${k}`}
        points={[
          new THREE.Vector3(lx, 0, ly),
          new THREE.Vector3(lx, wallHeight, ly),
        ]}
        color={COLORS.MODULE_LINE}
        lineWidth={0.5}
        dashed
        dashSize={0.05}
        gapSize={0.05}
      />
    );

    // Right face line
    const rx = startRight.x + rightDir.x * t;
    const ry = startRight.y + rightDir.y * t;
    lines.push(
      <Line
        key={`mod-r-${k}`}
        points={[
          new THREE.Vector3(rx, 0, ry),
          new THREE.Vector3(rx, wallHeight, ry),
        ]}
        color={COLORS.MODULE_LINE}
        lineWidth={0.5}
        dashed
        dashSize={0.05}
        gapSize={0.05}
      />
    );
  }

  return <group>{lines}</group>;
}

// ===== Panel Outline (for FULL/CUT panels) =====

interface PanelOutlineProps {
  panel: EnginePanel;
  course: Course;
  wallGeom: WallGeometryData;
}

function PanelOutline({ panel, course, wallGeom }: PanelOutlineProps) {
  const { leftPts, rightPts, u2, isLeftExterior } = wallGeom;
  
  const z0 = course.z0 ?? 0;
  const z1 = course.z1 ?? 0;
  const x0 = panel.x0;
  const x1 = panel.x1;
  
  // Get start points
  const startLeft = leftPts[0];
  const startRight = rightPts[0];
  
  // Compute positions along the wall
  // Left side corners
  const leftX0 = { x: startLeft.x + u2.x * x0, y: startLeft.y + u2.y * x0 };
  const leftX1 = { x: startLeft.x + u2.x * x1, y: startLeft.y + u2.y * x1 };
  
  // Right side corners
  const rightX0 = { x: startRight.x + u2.x * x0, y: startRight.y + u2.y * x0 };
  const rightX1 = { x: startRight.x + u2.x * x1, y: startRight.y + u2.y * x1 };
  
  // Panel color
  const panelColor = panel.type === 'FULL' ? COLORS.PANEL_FULL : COLORS.PANEL_CUT;
  
  // Create outline as 4 vertical lines and horizontal connections
  const exteriorPts = isLeftExterior ? [leftX0, leftX1] : [rightX0, rightX1];
  const interiorPts = isLeftExterior ? [rightX0, rightX1] : [leftX0, leftX1];
  
  return (
    <group>
      {/* Exterior face rectangle */}
      <Line
        points={[
          new THREE.Vector3(exteriorPts[0].x, z0, exteriorPts[0].y),
          new THREE.Vector3(exteriorPts[1].x, z0, exteriorPts[1].y),
          new THREE.Vector3(exteriorPts[1].x, z1, exteriorPts[1].y),
          new THREE.Vector3(exteriorPts[0].x, z1, exteriorPts[0].y),
          new THREE.Vector3(exteriorPts[0].x, z0, exteriorPts[0].y),
        ]}
        color={panelColor}
        lineWidth={1.5}
      />
      
      {/* Interior face rectangle */}
      <Line
        points={[
          new THREE.Vector3(interiorPts[0].x, z0, interiorPts[0].y),
          new THREE.Vector3(interiorPts[1].x, z0, interiorPts[1].y),
          new THREE.Vector3(interiorPts[1].x, z1, interiorPts[1].y),
          new THREE.Vector3(interiorPts[0].x, z1, interiorPts[0].y),
          new THREE.Vector3(interiorPts[0].x, z0, interiorPts[0].y),
        ]}
        color={panelColor}
        lineWidth={1.5}
      />
    </group>
  );
}

// ===== Single Wall Mesh =====

interface WallMeshProps {
  wall: GraphWall;
  wallHeight: number;
  courses: Course[];
  panels: EnginePanel[];
  centroid: { x: number; y: number };
  isSelected: boolean;
  onWallClick?: (wallId: string) => void;
  hasPanels: boolean;
}

function WallMesh({
  wall,
  wallHeight,
  courses,
  panels,
  centroid,
  isSelected,
  onWallClick,
  hasPanels,
}: WallMeshProps) {
  const wallGeom = useMemo(
    () => computeWallGeometry(wall, centroid),
    [wall, centroid]
  );

  if (!wallGeom) return null;

  const { leftPts, rightPts, isLeftExterior } = wallGeom;
  
  // Determine which side is exterior/interior
  const exteriorPts = isLeftExterior ? leftPts : rightPts;
  const interiorPts = isLeftExterior ? rightPts : leftPts;

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onWallClick?.(wall.id);
  };

  // Get panels for this wall
  const wallPanels = panels.filter(p => p.wall_id === wall.id);

  return (
    <group onClick={handleClick}>
      {/* Exterior Surface - Blue */}
      <WallSurface
        pts={exteriorPts}
        wallHeight={wallHeight}
        color={COLORS.EXTERIOR}
        isExterior={true}
        isSelected={isSelected}
      />
      
      {/* Interior Surface - White/Gray */}
      <WallSurface
        pts={interiorPts}
        wallHeight={wallHeight}
        color={COLORS.INTERIOR}
        isExterior={false}
        isSelected={isSelected}
      />

      {/* Horizontal Stripe Lines on Exterior (faixa effect) */}
      <ExteriorStripeLines
        pts={exteriorPts}
        wallHeight={wallHeight}
        stripeSpacing={0.1}
      />

      {/* Wall Outlines */}
      <WallOutlines
        leftPts={leftPts}
        rightPts={rightPts}
        wallHeight={wallHeight}
      />

      {/* Course Lines */}
      <CourseLines
        courses={courses}
        leftPts={leftPts}
        rightPts={rightPts}
      />

      {/* Module Lines (placeholder when no panels) */}
      {!hasPanels && (
        <ModuleLines
          wallGeom={wallGeom}
          wallHeight={wallHeight}
        />
      )}

      {/* Panel Outlines (when panels exist) */}
      {hasPanels && wallPanels.map((panel, idx) => {
        const course = courses.find(c => c.index === panel.course);
        if (!course) return null;
        
        return (
          <PanelOutline
            key={`panel-${wall.id}-${panel.course}-${idx}`}
            panel={panel}
            course={course}
            wallGeom={wallGeom}
          />
        );
      })}
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
        ⚠️ {count} wall(s) ignorada(s) por dados inválidos
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

// ===== Calculate bounding box offset for auto-centering =====

function calculateCenterOffset(
  nodes: GraphNode[],
  walls: GraphWall[]
): { x: number; y: number } {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  // Check nodes
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

  // Check wall offset points
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

  if (!isFinite(minX) || !isFinite(minY)) {
    return { x: 0, y: 0 };
  }

  // Center offset: negative of centroid
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  return { x: -centerX, y: -centerY };
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

  // Get panels from normalized analysis
  const hasPanels = panels.length > 0;

  // Calculate auto-centering offset for large CAD/UTM coordinates
  const centerOffset = useMemo(
    () => calculateCenterOffset(nodes, walls),
    [nodes, walls]
  );

  // Apply offset to nodes (for centroid calculation)
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

  // Calculate building centroid for exterior/interior detection
  const centroid = useMemo(() => calculateCentroid(adjustedNodes), [adjustedNodes]);

  // Log for debugging
  useEffect(() => {
    console.log('[ExternalEngineRenderer] Rendering:', {
      walls: walls.length,
      courses: courses.length,
      panels: panels.length,
      wallHeight,
      thickness,
      centroid,
      centerOffset,
    });
  }, [walls, courses, panels, wallHeight, thickness, centroid, centerOffset]);

  // Calculate bounds for labels (use adjusted nodes)
  const bounds = useMemo(() => {
    if (adjustedNodes.length === 0) {
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

    if (!isFinite(minX)) return { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };

    return { minX, maxX, minZ, maxZ };
  }, [adjustedNodes]);

  // Count skipped walls (invalid geometry)
  const validWallsCount = useMemo(() => {
    let valid = 0;
    let skipped = 0;

    for (const wall of adjustedWalls) {
      const geom = computeWallGeometry(wall, centroid);
      if (!geom) {
        skipped++;
      } else {
        valid++;
      }
    }

    return { valid, skipped };
  }, [adjustedWalls, centroid]);

  useEffect(() => {
    setSkippedCount(validWallsCount.skipped);
  }, [validWallsCount.skipped]);

  // No data state
  if (walls.length === 0 && nodes.length === 0) {
    return <NoDataPlaceholder />;
  }

  return (
    <group ref={groupRef}>
      {/* Skipped walls warning */}
      {skippedCount > 0 && <SkippedWarning count={skippedCount} />}

      {/* Render walls with adjusted coordinates */}
      {adjustedWalls.map((wall) => (
        <WallMesh
          key={wall.id}
          wall={wall}
          wallHeight={wallHeight}
          courses={courses}
          panels={panels}
          centroid={centroid}
          isSelected={wall.id === selectedWallId}
          onWallClick={onWallClick}
          hasPanels={hasPanels}
        />
      ))}

      {/* Node spheres with adjusted positions */}
      <NodeSpheres nodes={adjustedNodes} />

      {/* Course labels */}
      {showCourseMarkers && courses.length > 0 && (
        <CourseLabels courses={courses} bounds={bounds} />
      )}
    </group>
  );
}
