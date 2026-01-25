/**
 * ExternalEngineRenderer - Standard External Engine 3D Render
 * 
 * When "External Engine" is active, this is the ONLY renderer.
 * All geometry comes from the external motor (source of truth).
 * 
 * Features:
 * - Walls rendered from offsets.left/right polylines
 * - Exterior face (blue with wireframe) vs Interior face (white/gray)
 * - Course lines at each course.z1
 * - Module lines every 1.2m (placeholder until panels exist)
 * - Panel rendering: FULL=yellow, CUT=red (when analysis.panels[] exists)
 * - Always-visible outlines (walls, courses, modules/panels)
 */

import { useMemo, useRef, useState, useEffect } from 'react';
import * as THREE from 'three';
import { ThreeEvent } from '@react-three/fiber';
import { Text, Html, Line } from '@react-three/drei';
import { NormalizedExternalAnalysis, GraphWall, Course } from '@/types/external-engine';

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
  INTERIOR: 0xeeeeee,       // Light gray/white
  EXTERIOR_WIRE: 0x1565c0,  // Darker blue for wireframe
  OUTLINE: 0x333333,        // Dark outline
  COURSE_LINE: 0x666666,    // Course line color
  MODULE_LINE: 0x999999,    // Module/placeholder line
  PANEL_FULL: 0xffc107,     // Yellow for FULL
  PANEL_CUT: 0xf44336,      // Red for CUT
  NODE: 0x4caf50,           // Green for nodes
  SELECTED: 0x00bcd4,       // Cyan for selected
};

// ===== Wall Face Geometry =====

interface WallFaceData {
  exteriorGeometry: THREE.BufferGeometry | null;
  interiorGeometry: THREE.BufferGeometry | null;
  outlinePoints: THREE.Vector3[];
  leftPoints2D: { x: number; y: number }[];
  rightPoints2D: { x: number; y: number }[];
  wallLength: number;
  axisU: { x: number; y: number };
  axisN: { x: number; y: number };
}

function createWallFaces(
  wall: GraphWall,
  wallHeight: number
): WallFaceData | null {
  if (!wall.offsets?.left || !wall.offsets?.right) {
    return null;
  }

  const leftPts = filterValidPoints(wall.offsets.left as unknown[]);
  const rightPts = filterValidPoints(wall.offsets.right as unknown[]);

  if (leftPts.length < 2 || rightPts.length < 2) {
    return null;
  }

  // Get axis from wall
  const axisU = wall.axis?.u ? toVec2(wall.axis.u) : { x: 1, y: 0 };
  const axisN = wall.axis?.n ? toVec2(wall.axis.n) : { x: 0, y: 1 };

  // Create vertical strip geometry for left side (exterior)
  const exteriorGeometry = createVerticalStrip(leftPts, wallHeight);
  
  // Create vertical strip geometry for right side (interior)
  const interiorGeometry = createVerticalStrip(rightPts, wallHeight);

  // Collect outline points for edge rendering
  const outlinePoints: THREE.Vector3[] = [];
  
  // Bottom edges
  for (const p of leftPts) {
    outlinePoints.push(new THREE.Vector3(p.x, 0, p.y));
  }
  for (const p of [...rightPts].reverse()) {
    outlinePoints.push(new THREE.Vector3(p.x, 0, p.y));
  }
  outlinePoints.push(new THREE.Vector3(leftPts[0].x, 0, leftPts[0].y)); // Close loop

  return {
    exteriorGeometry,
    interiorGeometry,
    outlinePoints,
    leftPoints2D: leftPts,
    rightPoints2D: rightPts,
    wallLength: wall.length ?? 1.2,
    axisU,
    axisN,
  };
}

function createVerticalStrip(
  points2D: { x: number; y: number }[],
  height: number
): THREE.BufferGeometry {
  const vertices: number[] = [];
  const indices: number[] = [];

  // Create vertices: for each 2D point, create bottom and top vertex
  for (const p of points2D) {
    // Bottom vertex (y=0 in 3D)
    vertices.push(p.x, 0, p.y);
    // Top vertex (y=height in 3D)
    vertices.push(p.x, height, p.y);
  }

  // Create triangles between consecutive segments
  for (let i = 0; i < points2D.length - 1; i++) {
    const bl = i * 2;     // bottom-left
    const tl = i * 2 + 1; // top-left
    const br = (i + 1) * 2;     // bottom-right
    const tr = (i + 1) * 2 + 1; // top-right

    // Two triangles per quad
    indices.push(bl, br, tl);
    indices.push(tl, br, tr);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

// ===== Course Lines Component =====

function CourseLines({
  wall,
  courses,
  leftPts,
  rightPts,
}: {
  wall: GraphWall;
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
        
        // Left face course line
        const leftLinePoints = leftPts.map(p => new THREE.Vector3(p.x, z, p.y));
        // Right face course line
        const rightLinePoints = rightPts.map(p => new THREE.Vector3(p.x, z, p.y));

        return (
          <group key={`course-${wall.id}-${course.index}`}>
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

// ===== Module Lines (Placeholder at 1.2m intervals) =====

function ModuleLines({
  wall,
  wallHeight,
  leftPts,
  rightPts,
}: {
  wall: GraphWall;
  wallHeight: number;
  leftPts: { x: number; y: number }[];
  rightPts: { x: number; y: number }[];
}) {
  const moduleSpacing = 1.2; // 1.2m standard panel width
  const wallLength = wall.length ?? 0;

  if (wallLength < moduleSpacing || leftPts.length < 2 || rightPts.length < 2) {
    return null;
  }

  // Calculate wall direction from left points
  const startL = leftPts[0];
  const endL = leftPts[leftPts.length - 1];
  const dirX = endL.x - startL.x;
  const dirY = endL.y - startL.y;
  const len = Math.sqrt(dirX * dirX + dirY * dirY);
  const ux = len > 0 ? dirX / len : 1;
  const uy = len > 0 ? dirY / len : 0;

  // Same for right side
  const startR = rightPts[0];
  const endR = rightPts[rightPts.length - 1];
  const dirRX = endR.x - startR.x;
  const dirRY = endR.y - startR.y;
  const lenR = Math.sqrt(dirRX * dirRX + dirRY * dirRY);
  const uxR = lenR > 0 ? dirRX / lenR : 1;
  const uyR = lenR > 0 ? dirRY / lenR : 0;

  const moduleCount = Math.floor(wallLength / moduleSpacing);
  const lines: JSX.Element[] = [];

  for (let k = 1; k <= moduleCount; k++) {
    const t = k * moduleSpacing;

    // Left face vertical line
    const lx = startL.x + ux * t;
    const ly = startL.y + uy * t;
    lines.push(
      <Line
        key={`mod-l-${wall.id}-${k}`}
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

    // Right face vertical line
    const rx = startR.x + uxR * t;
    const ry = startR.y + uyR * t;
    lines.push(
      <Line
        key={`mod-r-${wall.id}-${k}`}
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

// ===== Panel Rendering =====

function PanelMeshes({
  wall,
  panels,
  courses,
  leftPts,
  rightPts,
}: {
  wall: GraphWall;
  panels: EnginePanel[];
  courses: Course[];
  leftPts: { x: number; y: number }[];
  rightPts: { x: number; y: number }[];
}) {
  const wallPanels = panels.filter(p => p.wall_id === wall.id);
  
  if (wallPanels.length === 0 || leftPts.length < 2) {
    return null;
  }

  // Get wall direction from left points
  const startL = leftPts[0];
  const endL = leftPts[leftPts.length - 1];
  const dirX = endL.x - startL.x;
  const dirY = endL.y - startL.y;
  const wallLen = Math.sqrt(dirX * dirX + dirY * dirY);
  const ux = wallLen > 0 ? dirX / wallLen : 1;
  const uy = wallLen > 0 ? dirY / wallLen : 0;

  return (
    <group>
      {wallPanels.map((panel, idx) => {
        const course = courses.find(c => c.index === panel.course);
        if (!course) return null;

        const z0 = course.z0 ?? 0;
        const z1 = course.z1 ?? 0;
        const height = z1 - z0;

        // Panel position along wall
        const x0 = panel.x0;
        const x1 = panel.x1;
        const panelWidth = x1 - x0;
        const midT = (x0 + x1) / 2;

        // Center position on left face
        const cx = startL.x + ux * midT;
        const cy = startL.y + uy * midT;
        const centerY = z0 + height / 2;

        // Color based on type
        const color = panel.type === 'FULL' ? COLORS.PANEL_FULL : COLORS.PANEL_CUT;

        // Create panel quad on exterior face
        const panelGeometry = new THREE.PlaneGeometry(panelWidth, height);
        
        // Rotate to align with wall
        const angle = Math.atan2(uy, ux);

        return (
          <group key={`panel-${wall.id}-${panel.course}-${idx}`}>
            <mesh
              position={[cx, centerY, cy]}
              rotation={[0, -angle + Math.PI / 2, 0]}
            >
              <planeGeometry args={[panelWidth, height]} />
              <meshStandardMaterial
                color={color}
                transparent
                opacity={0.85}
                side={THREE.DoubleSide}
              />
            </mesh>
            {/* Panel outline */}
            <mesh
              position={[cx, centerY, cy]}
              rotation={[0, -angle + Math.PI / 2, 0]}
            >
              <planeGeometry args={[panelWidth, height]} />
              <meshBasicMaterial
                color={COLORS.OUTLINE}
                wireframe
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
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

  // Bottom outline (closed loop)
  const bottomLoop = [
    ...leftPts.map(p => new THREE.Vector3(p.x, 0, p.y)),
    ...[...rightPts].reverse().map(p => new THREE.Vector3(p.x, 0, p.y)),
  ];
  bottomLoop.push(bottomLoop[0].clone()); // Close

  // Top outline (closed loop)
  const topLoop = [
    ...leftPts.map(p => new THREE.Vector3(p.x, wallHeight, p.y)),
    ...[...rightPts].reverse().map(p => new THREE.Vector3(p.x, wallHeight, p.y)),
  ];
  topLoop.push(topLoop[0].clone()); // Close

  // Vertical edges at corners
  const verticals: THREE.Vector3[][] = [];
  // Start corners
  verticals.push([
    new THREE.Vector3(leftPts[0].x, 0, leftPts[0].y),
    new THREE.Vector3(leftPts[0].x, wallHeight, leftPts[0].y),
  ]);
  verticals.push([
    new THREE.Vector3(rightPts[0].x, 0, rightPts[0].y),
    new THREE.Vector3(rightPts[0].x, wallHeight, rightPts[0].y),
  ]);
  // End corners
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

function WallMesh({
  wall,
  wallHeight,
  courses,
  panels,
  isSelected,
  onWallClick,
  hasPanels,
}: {
  wall: GraphWall;
  wallHeight: number;
  courses: Course[];
  panels: EnginePanel[];
  isSelected: boolean;
  onWallClick?: (wallId: string) => void;
  hasPanels: boolean;
}) {
  const faceData = useMemo(() => createWallFaces(wall, wallHeight), [wall, wallHeight]);

  if (!faceData) return null;

  const { exteriorGeometry, interiorGeometry, leftPoints2D, rightPoints2D } = faceData;

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onWallClick?.(wall.id);
  };

  return (
    <group onClick={handleClick}>
      {/* Exterior Face (Left) - Blue with wireframe effect */}
      {exteriorGeometry && (
        <group>
          {/* Base mesh */}
          <mesh geometry={exteriorGeometry}>
            <meshStandardMaterial
              color={isSelected ? COLORS.SELECTED : COLORS.EXTERIOR}
              transparent
              opacity={0.7}
              side={THREE.DoubleSide}
            />
          </mesh>
          {/* Wireframe overlay for "mesh/faixa" effect */}
          <mesh geometry={exteriorGeometry}>
            <meshBasicMaterial
              color={COLORS.EXTERIOR_WIRE}
              wireframe
              transparent
              opacity={0.5}
            />
          </mesh>
        </group>
      )}

      {/* Interior Face (Right) - White/Gray solid */}
      {interiorGeometry && (
        <mesh geometry={interiorGeometry}>
          <meshStandardMaterial
            color={isSelected ? COLORS.SELECTED : COLORS.INTERIOR}
            transparent
            opacity={0.8}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Wall Outlines */}
      <WallOutlines
        leftPts={leftPoints2D}
        rightPts={rightPoints2D}
        wallHeight={wallHeight}
      />

      {/* Course Lines */}
      <CourseLines
        wall={wall}
        courses={courses}
        leftPts={leftPoints2D}
        rightPts={rightPoints2D}
      />

      {/* Module Lines (placeholder) OR Panel Meshes */}
      {hasPanels ? (
        <PanelMeshes
          wall={wall}
          panels={panels}
          courses={courses}
          leftPts={leftPoints2D}
          rightPts={rightPoints2D}
        />
      ) : (
        <ModuleLines
          wall={wall}
          wallHeight={wallHeight}
          leftPts={leftPoints2D}
          rightPts={rightPoints2D}
        />
      )}
    </group>
  );
}

// ===== Node Spheres =====

function NodeSpheres({ nodes }: { nodes: { id: string; position: unknown }[] }) {
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

  const { nodes, walls, courses, wallHeight } = normalizedAnalysis;

  // Get panels from prop or empty array
  const panels = externalPanels ?? [];
  const hasPanels = panels.length > 0;

  // Log for debugging
  useEffect(() => {
    console.log('ExternalEngineRenderer:', {
      walls: walls.length,
      courses: courses.length,
      panels: panels.length,
      wallHeight,
    });
  }, [walls, courses, panels, wallHeight]);

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
      if (!wall.offsets?.left || !wall.offsets?.right) {
        skipped++;
        continue;
      }
      const leftPts = filterValidPoints(wall.offsets.left as unknown[]);
      const rightPts = filterValidPoints(wall.offsets.right as unknown[]);
      if (leftPts.length < 2 || rightPts.length < 2) {
        skipped++;
      } else {
        valid++;
      }
    }

    return { valid, skipped };
  }, [walls]);

  useEffect(() => {
    setSkippedCount(validWallsCount.skipped);
  }, [validWallsCount.skipped]);

  // Show loading if no data
  if (walls.length === 0 && nodes.length === 0) {
    return <LoadingPlaceholder />;
  }

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
