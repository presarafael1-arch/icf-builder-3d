/**
 * ExternalEngineRenderer - Standard External Engine 3D Render
 * 
 * When "External Engine" is active, this is the ONLY renderer.
 * All geometry comes from the external motor (source of truth).
 * 
 * Features:
 * - Panel-by-panel rendering (1200x400 standard size)
 * - Centroid-based exterior/interior detection
 * - Exterior face: blue with wireframe "mesh/faixa" overlay
 * - Interior face: white/gray solid
 * - Course lines at each course.z1
 * - Fallback module lines every 1.2m when panels[] doesn't exist
 * - Panel rendering: FULL=yellow, CUT=red with outlines
 */

import { useMemo, useRef, useState, useEffect } from 'react';
import * as THREE from 'three';
import { ThreeEvent } from '@react-three/fiber';
import { Text, Html, Line } from '@react-three/drei';
import { NormalizedExternalAnalysis, GraphWall, Course, GraphNode } from '@/types/external-engine';

// ===== Panel Types (from backend) =====
interface EnginePanel {
  wall_id: string;
  course: number;
  x0: number;
  x1: number;
  type: 'FULL' | 'CUT';
  cut_reason?: string;
}

interface ExternalEngineRendererProps {
  normalizedAnalysis: NormalizedExternalAnalysis;
  selectedWallId: string | null;
  onWallClick?: (wallId: string) => void;
  showCourseMarkers?: boolean;
  showShiftArrows?: boolean;
  panels?: EnginePanel[];
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
  EXTERIOR_WIRE: 0x1565c0,  // Darker blue for wireframe overlay
  OUTLINE: 0x333333,        // Dark outline
  COURSE_LINE: 0x666666,    // Course line color
  MODULE_LINE: 0x999999,    // Module/placeholder line
  PANEL_FULL: 0xffc107,     // Yellow for FULL
  PANEL_CUT: 0xf44336,      // Red for CUT
  NODE: 0x4caf50,           // Green for nodes
  SELECTED: 0x00bcd4,       // Cyan for selected
};

// Standard EPS skin thickness (70.6mm = 1200/17 mm)
const SKIN_THICKNESS_M = 0.0706;

// ===== Centroid Calculation =====
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

// ===== Wall Axis Helpers =====

interface WallGeometryData {
  startPt: { x: number; y: number };
  endPt: { x: number; y: number };
  u3: THREE.Vector3;      // Unit vector along wall (3D)
  n3: THREE.Vector3;      // Normal vector (perpendicular, 3D)
  outwardN: THREE.Vector3; // Normal pointing outward (away from centroid)
  length: number;
  leftPts: { x: number; y: number }[];
  rightPts: { x: number; y: number }[];
  isExteriorLeft: boolean; // True if left side is exterior
}

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
    // Perpendicular: (dy, -dx) for right-hand rule
    n2 = { x: u2.y, y: -u2.x };
  }
  
  // Convert to 3D (XZ plane, Y is up)
  const u3 = new THREE.Vector3(u2.x, 0, u2.y);
  const n3 = new THREE.Vector3(n2.x, 0, n2.y);
  
  // Get start and end points
  const startPt = leftPts[0];
  const endPt = leftPts[leftPts.length - 1];
  
  // Calculate wall midpoint
  const wallLength = wall.length ?? Math.sqrt(
    Math.pow(endPt.x - startPt.x, 2) + Math.pow(endPt.y - startPt.y, 2)
  );
  const mid = {
    x: startPt.x + u2.x * (wallLength * 0.5),
    y: startPt.y + u2.y * (wallLength * 0.5),
  };
  
  // Vector from mid to centroid
  const toCenter = new THREE.Vector3(
    centroid.x - mid.x,
    0,
    centroid.y - mid.y
  );
  
  // Determine outward normal: if n3 points toward center, flip it
  const dot = n3.dot(toCenter);
  const outwardN = dot > 0 ? n3.clone().negate() : n3.clone();
  
  // Determine which side is exterior
  // Left side is exterior if leftPts are on the outward side
  const leftMid = {
    x: (leftPts[0].x + leftPts[leftPts.length - 1].x) / 2,
    y: (leftPts[0].y + leftPts[leftPts.length - 1].y) / 2,
  };
  const rightMid = {
    x: (rightPts[0].x + rightPts[rightPts.length - 1].x) / 2,
    y: (rightPts[0].y + rightPts[rightPts.length - 1].y) / 2,
  };
  
  // Check which side is further from centroid
  const leftDistSq = Math.pow(leftMid.x - centroid.x, 2) + Math.pow(leftMid.y - centroid.y, 2);
  const rightDistSq = Math.pow(rightMid.x - centroid.x, 2) + Math.pow(rightMid.y - centroid.y, 2);
  const isExteriorLeft = leftDistSq > rightDistSq;
  
  return {
    startPt,
    endPt,
    u3,
    n3,
    outwardN,
    length: wallLength,
    leftPts,
    rightPts,
    isExteriorLeft,
  };
}

// ===== Single Panel Mesh =====

interface PanelMeshProps {
  panel: EnginePanel;
  course: Course;
  wallGeom: WallGeometryData;
  thickness: number;
  isSelected?: boolean;
}

function SinglePanelMesh({ panel, course, wallGeom, thickness, isSelected }: PanelMeshProps) {
  const { startPt, u3, outwardN, isExteriorLeft, leftPts, rightPts } = wallGeom;
  
  const z0 = course.z0 ?? 0;
  const z1 = course.z1 ?? 0;
  const height = z1 - z0;
  const width = panel.x1 - panel.x0;
  const midT = (panel.x0 + panel.x1) / 2;
  
  // Get 2D direction for positioning
  const u2 = { x: u3.x, y: u3.z };
  
  // Panel center along wall axis
  const centerX = startPt.x + u2.x * midT;
  const centerZ = startPt.y + u2.y * midT;
  const centerY = z0 + height / 2;
  
  // Skin thickness
  const skinThickness = Math.min(thickness / 2, SKIN_THICKNESS_M);
  
  // Calculate exterior and interior center positions
  const halfThickness = thickness / 2;
  const exteriorOffset = halfThickness - skinThickness / 2;
  const interiorOffset = halfThickness - skinThickness / 2;
  
  // Exterior center (on outward side)
  const extCenter = new THREE.Vector3(
    centerX + outwardN.x * exteriorOffset,
    centerY,
    centerZ + outwardN.z * exteriorOffset
  );
  
  // Interior center (on inward side)
  const intCenter = new THREE.Vector3(
    centerX - outwardN.x * interiorOffset,
    centerY,
    centerZ - outwardN.z * interiorOffset
  );
  
  // Rotation to align with wall
  const angle = Math.atan2(u2.y, u2.x);
  const rotation = new THREE.Euler(0, -angle + Math.PI / 2, 0);
  
  // Panel colors
  const panelColor = panel.type === 'FULL' ? COLORS.PANEL_FULL : COLORS.PANEL_CUT;
  const selectedColor = COLORS.SELECTED;
  
  return (
    <group>
      {/* Exterior Panel Skin - Blue with wireframe + panel color overlay */}
      <group position={extCenter} rotation={rotation}>
        {/* Base panel color (FULL/CUT) */}
        <mesh>
          <boxGeometry args={[width, height, skinThickness]} />
          <meshStandardMaterial
            color={isSelected ? selectedColor : panelColor}
            transparent
            opacity={0.85}
            side={THREE.DoubleSide}
          />
        </mesh>
        {/* Blue wireframe overlay for exterior "mesh/faixa" effect */}
        <mesh>
          <boxGeometry args={[width, height, skinThickness * 1.01]} />
          <meshBasicMaterial
            color={COLORS.EXTERIOR_WIRE}
            wireframe
            transparent
            opacity={0.4}
          />
        </mesh>
        {/* Panel outline */}
        <lineSegments>
          <edgesGeometry args={[new THREE.BoxGeometry(width, height, skinThickness)]} />
          <lineBasicMaterial color={COLORS.OUTLINE} linewidth={1} />
        </lineSegments>
      </group>
      
      {/* Interior Panel Skin - White/gray solid */}
      <group position={intCenter} rotation={rotation}>
        <mesh>
          <boxGeometry args={[width, height, skinThickness]} />
          <meshStandardMaterial
            color={isSelected ? selectedColor : COLORS.INTERIOR}
            transparent
            opacity={0.9}
            side={THREE.DoubleSide}
          />
        </mesh>
        {/* Panel outline */}
        <lineSegments>
          <edgesGeometry args={[new THREE.BoxGeometry(width, height, skinThickness)]} />
          <lineBasicMaterial color={COLORS.OUTLINE} linewidth={1} />
        </lineSegments>
      </group>
    </group>
  );
}

// ===== Wall Panels (when panels[] exists) =====

interface WallPanelsProps {
  wall: GraphWall;
  panels: EnginePanel[];
  courses: Course[];
  wallGeom: WallGeometryData;
  thickness: number;
  isSelected?: boolean;
}

function WallPanels({ wall, panels, courses, wallGeom, thickness, isSelected }: WallPanelsProps) {
  const wallPanels = panels.filter(p => p.wall_id === wall.id);
  
  if (wallPanels.length === 0) return null;
  
  return (
    <group>
      {wallPanels.map((panel, idx) => {
        const course = courses.find(c => c.index === panel.course);
        if (!course) return null;
        
        return (
          <SinglePanelMesh
            key={`panel-${wall.id}-${panel.course}-${idx}`}
            panel={panel}
            course={course}
            wallGeom={wallGeom}
            thickness={thickness}
            isSelected={isSelected}
          />
        );
      })}
    </group>
  );
}

// ===== Fallback Wall Slab (when no panels) =====

interface WallSlabProps {
  wall: GraphWall;
  wallGeom: WallGeometryData;
  wallHeight: number;
  thickness: number;
  isSelected?: boolean;
}

function WallSlab({ wall, wallGeom, wallHeight, thickness, isSelected }: WallSlabProps) {
  const { leftPts, rightPts, outwardN, isExteriorLeft } = wallGeom;
  
  const skinThickness = Math.min(thickness / 2, SKIN_THICKNESS_M);
  
  // Determine which points are exterior/interior
  const exteriorPts = isExteriorLeft ? leftPts : rightPts;
  const interiorPts = isExteriorLeft ? rightPts : leftPts;
  
  // Create vertical strip geometry
  const createStrip = (pts: { x: number; y: number }[], height: number): THREE.BufferGeometry => {
    const vertices: number[] = [];
    const indices: number[] = [];
    
    for (const p of pts) {
      vertices.push(p.x, 0, p.y);
      vertices.push(p.x, height, p.y);
    }
    
    for (let i = 0; i < pts.length - 1; i++) {
      const bl = i * 2;
      const tl = i * 2 + 1;
      const br = (i + 1) * 2;
      const tr = (i + 1) * 2 + 1;
      indices.push(bl, br, tl);
      indices.push(tl, br, tr);
    }
    
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
  };
  
  const exteriorGeom = useMemo(() => createStrip(exteriorPts, wallHeight), [exteriorPts, wallHeight]);
  const interiorGeom = useMemo(() => createStrip(interiorPts, wallHeight), [interiorPts, wallHeight]);
  
  return (
    <group>
      {/* Exterior Face - Blue with wireframe */}
      <mesh geometry={exteriorGeom}>
        <meshStandardMaterial
          color={isSelected ? COLORS.SELECTED : COLORS.EXTERIOR}
          transparent
          opacity={0.7}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh geometry={exteriorGeom}>
        <meshBasicMaterial
          color={COLORS.EXTERIOR_WIRE}
          wireframe
          transparent
          opacity={0.4}
        />
      </mesh>
      
      {/* Interior Face - White/gray */}
      <mesh geometry={interiorGeom}>
        <meshStandardMaterial
          color={isSelected ? COLORS.SELECTED : COLORS.INTERIOR}
          transparent
          opacity={0.85}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

// ===== Course Lines =====

function CourseLines({
  courses,
  leftPts,
  rightPts,
}: {
  courses: Course[];
  leftPts: { x: number; y: number }[];
  rightPts: { x: number; y: number }[];
}) {
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

// ===== Module Lines (placeholder at 1.2m intervals) =====

function ModuleLines({
  wallGeom,
  wallHeight,
}: {
  wallGeom: WallGeometryData;
  wallHeight: number;
}) {
  const moduleSpacing = 1.2;
  const { length, leftPts, rightPts, startPt, u3 } = wallGeom;
  
  if (length < moduleSpacing) return null;
  
  const u2 = { x: u3.x, y: u3.z };
  
  // Same for right side
  const startR = rightPts[0];
  const endR = rightPts[rightPts.length - 1];
  const dirRX = endR.x - startR.x;
  const dirRY = endR.y - startR.y;
  const lenR = Math.sqrt(dirRX * dirRX + dirRY * dirRY);
  const uR = lenR > 0 ? { x: dirRX / lenR, y: dirRY / lenR } : u2;
  
  const moduleCount = Math.floor(length / moduleSpacing);
  const lines: JSX.Element[] = [];

  for (let k = 1; k <= moduleCount; k++) {
    const t = k * moduleSpacing;

    // Left face
    const lx = startPt.x + u2.x * t;
    const ly = startPt.y + u2.y * t;
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

    // Right face
    const rx = startR.x + uR.x * t;
    const ry = startR.y + uR.y * t;
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

// ===== Wall Outlines =====

function WallOutlines({
  leftPts,
  rightPts,
  wallHeight,
}: {
  leftPts: { x: number; y: number }[];
  rightPts: { x: number; y: number }[];
  wallHeight: number;
}) {
  if (leftPts.length < 2 || rightPts.length < 2) return null;

  // Bottom loop
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

  // Vertical edges
  const verticals: THREE.Vector3[][] = [];
  verticals.push([
    new THREE.Vector3(leftPts[0].x, 0, leftPts[0].y),
    new THREE.Vector3(leftPts[0].x, wallHeight, leftPts[0].y),
  ]);
  verticals.push([
    new THREE.Vector3(rightPts[0].x, 0, rightPts[0].y),
    new THREE.Vector3(rightPts[0].x, wallHeight, rightPts[0].y),
  ]);
  const lastL = leftPts[leftPts.length - 1];
  const lastR = rightPts[rightPts.length - 1];
  verticals.push([
    new THREE.Vector3(lastL.x, 0, lastL.y),
    new THREE.Vector3(lastL.x, wallHeight, lastL.y),
  ]);
  verticals.push([
    new THREE.Vector3(lastR.x, 0, lastR.y),
    new THREE.Vector3(lastR.x, wallHeight, lastR.y),
  ]);

  return (
    <group>
      <Line points={bottomLoop} color={COLORS.OUTLINE} lineWidth={1.5} />
      <Line points={topLoop} color={COLORS.OUTLINE} lineWidth={1.5} />
      {verticals.map((pts, i) => (
        <Line key={`vert-${i}`} points={pts} color={COLORS.OUTLINE} lineWidth={1.5} />
      ))}
    </group>
  );
}

// ===== Single Wall Component =====

interface WallMeshProps {
  wall: GraphWall;
  wallHeight: number;
  courses: Course[];
  panels: EnginePanel[];
  thickness: number;
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
  thickness,
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

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onWallClick?.(wall.id);
  };

  return (
    <group onClick={handleClick}>
      {/* Wall surfaces (panels or fallback slab) */}
      {hasPanels ? (
        <WallPanels
          wall={wall}
          panels={panels}
          courses={courses}
          wallGeom={wallGeom}
          thickness={thickness}
          isSelected={isSelected}
        />
      ) : (
        <WallSlab
          wall={wall}
          wallGeom={wallGeom}
          wallHeight={wallHeight}
          thickness={thickness}
          isSelected={isSelected}
        />
      )}

      {/* Wall Outlines */}
      <WallOutlines
        leftPts={wallGeom.leftPts}
        rightPts={wallGeom.rightPts}
        wallHeight={wallHeight}
      />

      {/* Course Lines */}
      <CourseLines
        courses={courses}
        leftPts={wallGeom.leftPts}
        rightPts={wallGeom.rightPts}
      />

      {/* Module Lines (placeholder when no panels) */}
      {!hasPanels && (
        <ModuleLines
          wallGeom={wallGeom}
          wallHeight={wallHeight}
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

function CourseLabels({
  courses,
  bounds,
}: {
  courses: Course[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}) {
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

// ===== Loading Placeholder =====

function LoadingPlaceholder() {
  return (
    <Html center>
      <div className="bg-blue-600/90 text-white px-4 py-2 rounded-lg text-sm font-medium">
        A carregar layout…
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
  panels: externalPanels,
}: ExternalEngineRendererProps) {
  const groupRef = useRef<THREE.Group>(null);
  const [skippedCount, setSkippedCount] = useState(0);

  const { nodes, walls, courses, wallHeight, thickness } = normalizedAnalysis;

  // Get panels from prop or empty array
  const panels = externalPanels ?? [];
  const hasPanels = panels.length > 0;

  // Calculate building centroid for exterior/interior detection
  const centroid = useMemo(() => calculateCentroid(nodes), [nodes]);

  // Log for debugging
  useEffect(() => {
    console.log('ExternalEngineRenderer:', {
      walls: walls.length,
      courses: courses.length,
      panels: panels.length,
      wallHeight,
      thickness,
      centroid,
    });
  }, [walls, courses, panels, wallHeight, thickness, centroid]);

  // Calculate bounds for labels
  const bounds = useMemo(() => {
    if (nodes.length === 0) {
      return { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
    }

    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const node of nodes) {
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
  }, [nodes]);

  // Count skipped walls
  const validWallsCount = useMemo(() => {
    let valid = 0;
    let skipped = 0;

    for (const wall of walls) {
      const geom = computeWallGeometry(wall, centroid);
      if (!geom) {
        skipped++;
      } else {
        valid++;
      }
    }

    return { valid, skipped };
  }, [walls, centroid]);

  useEffect(() => {
    setSkippedCount(validWallsCount.skipped);
  }, [validWallsCount.skipped]);

  // No data state
  if (walls.length === 0 && nodes.length === 0) {
    return <NoDataPlaceholder />;
  }

  // Default thickness if not provided
  const effectiveThickness = thickness > 0 ? thickness : 0.28; // 280mm default

  return (
    <group ref={groupRef}>
      {/* Skipped walls warning */}
      {skippedCount > 0 && <SkippedWarning count={skippedCount} />}

      {/* Render walls */}
      {walls.map((wall) => (
        <WallMesh
          key={wall.id}
          wall={wall}
          wallHeight={wallHeight}
          courses={courses}
          panels={panels}
          thickness={effectiveThickness}
          centroid={centroid}
          isSelected={wall.id === selectedWallId}
          onWallClick={onWallClick}
          hasPanels={hasPanels}
        />
      ))}

      {/* Node spheres */}
      <NodeSpheres nodes={nodes} />

      {/* Course labels */}
      {showCourseMarkers && courses.length > 0 && (
        <CourseLabels courses={courses} bounds={bounds} />
      )}
    </group>
  );
}
