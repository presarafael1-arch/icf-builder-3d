/**
 * ExternalEngineRenderer - Renders 3D geometry from external ICF engine analysis
 * 
 * This component renders ONLY from normalized external engine data.
 * No fallback to internal calculations - if data is empty, nothing renders.
 * 
 * It renders:
 * 1. Walls from normalizedAnalysis.walls[] using offsets.left/right or fallback to axis.u
 * 2. Course bands/markers at each course height
 * 3. Shift markers for pattern "B" courses
 * 4. Handles wall selection on click
 */

import { useMemo, useRef, useState, useEffect } from 'react';
import * as THREE from 'three';
import { ThreeEvent } from '@react-three/fiber';
import { Text, Html } from '@react-three/drei';
import { NormalizedExternalAnalysis, GraphWall, Course, Vec3 } from '@/types/external-engine';

interface ExternalEngineRendererProps {
  normalizedAnalysis: NormalizedExternalAnalysis;
  selectedWallId: string | null;
  onWallClick?: (wallId: string) => void;
  showCourseMarkers?: boolean;
  showShiftArrows?: boolean;
}

// ===== Point Format Helpers =====
// Backend may return points as [x, y], {x, y}, or {0: x, 1: y}
type PointLike = [number, number] | { x: number; y: number } | { 0: number; 1: number } | Vec3;

// Extract X coordinate from any point format
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

// Extract Y coordinate from any point format
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

// Extract Z coordinate (optional, defaults to 0)
function pz(p: unknown): number {
  if (p == null) return 0;
  if (Array.isArray(p)) return typeof p[2] === 'number' ? p[2] : 0;
  if (typeof p === 'object') {
    const obj = p as Record<string, unknown>;
    if (typeof obj.z === 'number') return obj.z;
    if (typeof obj['2'] === 'number') return obj['2'];
  }
  return 0;
}

// Convert any point format to {x, y} with safe defaults
function toVec2(p: unknown): { x: number; y: number } {
  return { x: px(p) ?? 0, y: py(p) ?? 0 };
}

// Check if point is valid (has at least x and y)
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

// Filter and convert points array to valid {x, y} objects
function filterValidPoints(points: unknown[]): { x: number; y: number }[] {
  if (!Array.isArray(points)) return [];
  return points.filter(isValidPt).map(toVec2);
}

// Convert Vec3 (or array) to THREE.Vector3 (with validation)
function toVector3(v: unknown): THREE.Vector3 | null {
  const x = px(v);
  const y = py(v);
  if (x === undefined || y === undefined) return null;
  const z = pz(v);
  return new THREE.Vector3(x, z, y); // Swap Y/Z for Three.js coordinate system
}

// ===== Mesh Creation =====

// Create wall mesh from offsets (left + reverse(right) = closed loop)
function createWallMeshFromOffsets(
  wall: GraphWall,
  wallHeight: number,
  isSelected: boolean
): { mesh: THREE.Mesh; skipped: boolean } | null {
  // Validate offsets exist
  if (!wall.offsets || !wall.offsets.left || !wall.offsets.right) {
    return null;
  }
  
  const leftPoints = filterValidPoints(wall.offsets.left as unknown[]);
  const rightPoints = filterValidPoints(wall.offsets.right as unknown[]);
  
  // Need at least 2 points on each side
  if (leftPoints.length < 2 || rightPoints.length < 2) {
    // Mark as skipped if we had some points but not enough
    const hadSomePoints = (wall.offsets.left.length > 0 || wall.offsets.right.length > 0);
    return hadSomePoints ? { mesh: null as unknown as THREE.Mesh, skipped: true } : null;
  }

  // Build 2D closed shape from left + reverse(right)
  const shape = new THREE.Shape();
  const reversedRight = [...rightPoints].reverse();
  
  // Start at first left point
  shape.moveTo(leftPoints[0].x, leftPoints[0].y);
  
  // Draw left side
  for (let i = 1; i < leftPoints.length; i++) {
    shape.lineTo(leftPoints[i].x, leftPoints[i].y);
  }
  
  // Continue to right side (reversed)
  for (const p of reversedRight) {
    shape.lineTo(p.x, p.y);
  }
  
  // Close back to start
  shape.lineTo(leftPoints[0].x, leftPoints[0].y);

  // Extrude to wall height
  const extrudeSettings: THREE.ExtrudeGeometryOptions = {
    depth: wallHeight,
    bevelEnabled: false,
  };

  const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  
  // Rotate to make extrusion go up (along Z in world = Y in Three.js)
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshStandardMaterial({
    color: isSelected ? 0x4a90d9 : 0x888888,
    transparent: true,
    opacity: isSelected ? 0.9 : 0.7,
    side: THREE.DoubleSide,
  });

  return { mesh: new THREE.Mesh(geometry, material), skipped: false };
}

// Create fallback rectangular wall from axis.u and thickness
function createWallMeshFromAxis(
  wall: GraphWall,
  wallHeight: number,
  thickness: number,
  nodes: Map<string, unknown>,
  isSelected: boolean
): THREE.Mesh | null {
  const startNode = nodes.get(wall.start_node);
  const endNode = nodes.get(wall.end_node);
  
  if (!startNode || !endNode) return null;

  const start = toVector3(startNode);
  const end = toVector3(endNode);
  
  // Validate conversion succeeded
  if (!start || !end) return null;
  
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  
  // Skip zero-length walls
  if (length < 0.001) return null;
  
  direction.normalize();

  // Create box geometry
  const geometry = new THREE.BoxGeometry(length, wallHeight, thickness);
  
  // Position at midpoint
  const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
  midpoint.y = wallHeight / 2;

  const material = new THREE.MeshStandardMaterial({
    color: isSelected ? 0x4a90d9 : 0x666666,
    transparent: true,
    opacity: isSelected ? 0.9 : 0.6,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(midpoint);

  // Rotate to align with wall direction
  const angle = Math.atan2(direction.z, direction.x);
  mesh.rotation.y = -angle;

  return mesh;
}

// ===== Sub-Components =====

// Component for course band visualization
function CourseBands({ 
  courses, 
  bounds 
}: { 
  courses: Course[]; 
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}) {
  const bandSize = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) + 1;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;

  return (
    <group>
      {courses.map((course) => (
        <group key={course.index}>
          {/* Horizontal band line at course.z1 */}
          <mesh 
            position={[centerX, course.z1 ?? 0, centerZ]}
            rotation={[-Math.PI / 2, 0, 0]}
          >
            <planeGeometry args={[bandSize, bandSize]} />
            <meshBasicMaterial 
              color={course.pattern === 'A' ? 0x4caf50 : 0xff9800} 
              transparent 
              opacity={0.1}
              side={THREE.DoubleSide}
            />
          </mesh>
          
          {/* Course label */}
          <Text
            position={[bounds.minX - 0.5, ((course.z0 ?? 0) + (course.z1 ?? 0)) / 2, centerZ]}
            fontSize={0.15}
            color={course.pattern === 'A' ? '#4caf50' : '#ff9800'}
            anchorX="right"
            anchorY="middle"
          >
            {`F${course.index + 1} (${course.pattern})`}
          </Text>
        </group>
      ))}
    </group>
  );
}

// Shift arrow for pattern B courses
function ShiftArrows({
  walls,
  courses,
  nodes,
}: {
  walls: GraphWall[];
  courses: Course[];
  nodes: Map<string, unknown>;
}) {
  const patternBCourses = courses.filter(c => c.pattern === 'B');
  
  if (patternBCourses.length === 0) return null;

  return (
    <group>
      {patternBCourses.map((course) => (
        <group key={`shift-${course.index}`}>
          {walls.map((wall) => {
            const startNode = nodes.get(wall.start_node);
            if (!startNode) return null;

            const start = toVector3(startNode);
            if (!start) return null;
            
            // Validate wall.axis exists
            if (!wall.axis || !wall.axis.u) return null;
            
            const shiftAmount = course.shift_along_wall || 0;
            
            // Position arrow at wall midpoint, at course center height
            const arrowY = ((course.z0 ?? 0) + (course.z1 ?? 0)) / 2;
            
            // Calculate arrow position along wall - handle array or object format
            const u = wall.axis.u;
            const ux = px(u) ?? 0;
            const uy = py(u) ?? 0;
            
            const arrowPos = new THREE.Vector3(
              start.x + ux * (wall.length / 2),
              arrowY,
              start.z + uy * (wall.length / 2) // Note: u.y maps to z in Three.js
            );

            return (
              <group key={`${wall.id}-${course.index}`} position={arrowPos}>
                {/* Arrow cone */}
                <mesh rotation={[0, 0, Math.PI / 2]}>
                  <coneGeometry args={[0.05, 0.15, 8]} />
                  <meshBasicMaterial color={0xff5722} />
                </mesh>
                {/* Shift label */}
                <Text
                  position={[0, 0.2, 0]}
                  fontSize={0.1}
                  color="#ff5722"
                  anchorX="center"
                  anchorY="bottom"
                >
                  {`+${shiftAmount.toFixed(0)}mm`}
                </Text>
              </group>
            );
          })}
        </group>
      ))}
    </group>
  );
}

// Warning badge component
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

// ===== Main Component =====

export function ExternalEngineRenderer({
  normalizedAnalysis,
  selectedWallId,
  onWallClick,
  showCourseMarkers = true,
  showShiftArrows = true,
}: ExternalEngineRendererProps) {
  const groupRef = useRef<THREE.Group>(null);
  const [skippedCount, setSkippedCount] = useState(0);

  // Destructure normalized data (all have safe defaults)
  const { nodes, walls, courses, wallHeight, thickness } = normalizedAnalysis;

  // Build node position map - handle array [x,y] or object {x,y} format
  const nodesMap = useMemo(() => {
    const map = new Map<string, unknown>();
    for (const node of nodes) {
      // node.position could be [x,y] or {x,y}
      if (node && node.id != null) {
        map.set(node.id, node.position);
      }
    }
    return map;
  }, [nodes]);

  // Calculate bounds for course bands - using px/py helpers
  const bounds = useMemo(() => {
    if (nodes.length === 0) {
      return { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
    }

    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const node of nodes) {
      const x = px(node.position);
      const y = py(node.position); // y in 2D = z in 3D
      
      if (x !== undefined) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
      if (y !== undefined) {
        minZ = Math.min(minZ, y);
        maxZ = Math.max(maxZ, y);
      }
    }

    // Fallback if all invalid
    if (!isFinite(minX)) return { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };

    return { minX, maxX, minZ, maxZ };
  }, [nodes]);

  // Process walls and count skipped
  const { wallMeshes, skipped } = useMemo(() => {
    let skippedWalls = 0;
    const meshes: { wallId: string; mesh: THREE.Mesh }[] = [];

    for (const wall of walls) {
      const isSelected = wall.id === selectedWallId;
      
      // Try to create mesh from offsets first
      if (wall.offsets) {
        const result = createWallMeshFromOffsets(wall, wallHeight, isSelected);
        if (result) {
          if (result.skipped) {
            skippedWalls++;
          } else if (result.mesh) {
            meshes.push({ wallId: wall.id, mesh: result.mesh });
            continue;
          }
        }
      }

      // Fallback to axis-based box
      const fallbackMesh = createWallMeshFromAxis(wall, wallHeight, thickness, nodesMap, isSelected);
      if (fallbackMesh) {
        meshes.push({ wallId: wall.id, mesh: fallbackMesh });
      } else {
        skippedWalls++;
      }
    }

    return { wallMeshes: meshes, skipped: skippedWalls };
  }, [walls, wallHeight, thickness, nodesMap, selectedWallId]);

  // Update skipped count
  useEffect(() => {
    setSkippedCount(skipped);
  }, [skipped]);

  // Handle wall click
  const handleClick = (e: ThreeEvent<MouseEvent>, wallId: string) => {
    e.stopPropagation();
    onWallClick?.(wallId);
  };

  // Scale factor based on units (assume meters for now)
  const scale = 1;

  return (
    <group ref={groupRef} scale={[scale, scale, scale]}>
      {/* Skipped walls warning */}
      {skippedCount > 0 && <SkippedWarning count={skippedCount} />}

      {/* Render walls */}
      {wallMeshes.map(({ wallId, mesh }) => (
        <primitive
          key={wallId}
          object={mesh}
          onClick={(e: ThreeEvent<MouseEvent>) => handleClick(e, wallId)}
        />
      ))}

      {/* Render node spheres */}
      {nodes.map((node) => {
        const x = px(node.position);
        const y = py(node.position);
        if (x === undefined || y === undefined) return null;
        
        return (
          <mesh
            key={node.id}
            position={[x, 0.1, y]}
          >
            <sphereGeometry args={[0.1, 16, 16]} />
            <meshBasicMaterial color={0x2196f3} />
          </mesh>
        );
      })}

      {/* Course bands */}
      {showCourseMarkers && courses.length > 0 && (
        <CourseBands courses={courses} bounds={bounds} />
      )}

      {/* Shift arrows for pattern B */}
      {showShiftArrows && courses.length > 0 && (
        <ShiftArrows
          walls={walls}
          courses={courses}
          nodes={nodesMap}
        />
      )}
    </group>
  );
}
