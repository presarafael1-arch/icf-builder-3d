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

import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { ThreeEvent } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { NormalizedExternalAnalysis, GraphWall, Course, Vec3 } from '@/types/external-engine';

interface ExternalEngineRendererProps {
  normalizedAnalysis: NormalizedExternalAnalysis;
  selectedWallId: string | null;
  onWallClick?: (wallId: string) => void;
  showCourseMarkers?: boolean;
  showShiftArrows?: boolean;
}

// Convert Vec3 to THREE.Vector3 (with validation)
function toVector3(v: Vec3 | undefined | null): THREE.Vector3 | null {
  if (!v || typeof v.x !== 'number' || typeof v.y !== 'number') {
    return null;
  }
  return new THREE.Vector3(v.x, v.z ?? 0, v.y); // Swap Y/Z for Three.js coordinate system
}

// Create wall mesh from offsets (left + reverse(right) = closed loop)
function createWallMeshFromOffsets(
  wall: GraphWall,
  wallHeight: number,
  isSelected: boolean
): THREE.Mesh | null {
  // Validate offsets exist and have valid points
  if (!wall.offsets || !wall.offsets.left || !wall.offsets.right) {
    return null;
  }
  
  const leftPoints = wall.offsets.left.filter(p => p && typeof p.x === 'number' && typeof p.y === 'number');
  const rightPoints = wall.offsets.right.filter(p => p && typeof p.x === 'number' && typeof p.y === 'number');
  
  if (leftPoints.length < 2 || rightPoints.length < 2) {
    return null;
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

  return new THREE.Mesh(geometry, material);
}

// Create fallback rectangular wall from axis.u and thickness
function createWallMeshFromAxis(
  wall: GraphWall,
  wallHeight: number,
  thickness: number,
  nodes: Map<string, Vec3>,
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
            position={[centerX, course.z1, centerZ]}
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
            position={[bounds.minX - 0.5, (course.z0 + course.z1) / 2, centerZ]}
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
  nodes: Map<string, Vec3>;
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
            
            // Calculate arrow position along wall
            const u = wall.axis.u;
            const arrowPos = new THREE.Vector3(
              start.x + (u.x ?? 0) * (wall.length / 2),
              arrowY,
              start.z + (u.y ?? 0) * (wall.length / 2) // Note: u.y maps to z in Three.js
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

export function ExternalEngineRenderer({
  normalizedAnalysis,
  selectedWallId,
  onWallClick,
  showCourseMarkers = true,
  showShiftArrows = true,
}: ExternalEngineRendererProps) {
  const groupRef = useRef<THREE.Group>(null);

  // Destructure normalized data (all have safe defaults)
  const { nodes, walls, courses, wallHeight, thickness } = normalizedAnalysis;

  // Build node position map
  const nodesMap = useMemo(() => {
    const map = new Map<string, Vec3>();
    for (const node of nodes) {
      map.set(node.id, node.position);
    }
    return map;
  }, [nodes]);

  // Calculate bounds for course bands
  const bounds = useMemo(() => {
    if (nodes.length === 0) {
      return { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
    }

    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const node of nodes) {
      minX = Math.min(minX, node.position.x);
      maxX = Math.max(maxX, node.position.x);
      minZ = Math.min(minZ, node.position.y); // y in 2D = z in 3D
      maxZ = Math.max(maxZ, node.position.y);
    }

    return { minX, maxX, minZ, maxZ };
  }, [nodes]);

  // Scale factor based on units (assume meters for now)
  const scale = 1;

  // Handle wall click
  const handleClick = (e: ThreeEvent<MouseEvent>, wallId: string) => {
    e.stopPropagation();
    onWallClick?.(wallId);
  };

  return (
    <group ref={groupRef} scale={[scale, scale, scale]}>
      {/* Render walls */}
      {walls.map((wall) => {
        const isSelected = wall.id === selectedWallId;
        
        // Try to create mesh from offsets first
        let meshFromOffsets: THREE.Mesh | null = null;
        if (wall.offsets) {
          meshFromOffsets = createWallMeshFromOffsets(wall, wallHeight, isSelected);
        }

        // Fallback to axis-based box
        if (!meshFromOffsets) {
          const fallbackMesh = createWallMeshFromAxis(wall, wallHeight, thickness, nodesMap, isSelected);
          if (!fallbackMesh) return null;

          return (
            <primitive
              key={wall.id}
              object={fallbackMesh}
              onClick={(e: ThreeEvent<MouseEvent>) => handleClick(e, wall.id)}
            />
          );
        }

        return (
          <primitive
            key={wall.id}
            object={meshFromOffsets}
            onClick={(e: ThreeEvent<MouseEvent>) => handleClick(e, wall.id)}
          />
        );
      })}

      {/* Render node spheres */}
      {nodes.map((node) => (
        <mesh
          key={node.id}
          position={[node.position.x, 0.1, node.position.y]}
        >
          <sphereGeometry args={[0.1, 16, 16]} />
          <meshBasicMaterial color={0x2196f3} />
        </mesh>
      ))}

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
