import { useRef, useMemo, useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, Environment, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { PANEL_WIDTH, PANEL_HEIGHT, PANEL_THICKNESS, WallSegment, ViewerSettings } from '@/types/icf';
import { calculateWallAngle, calculateWallLength, calculateGridRows, calculateWebsPerRow } from '@/lib/icf-calculations';

interface ICFPanelInstancesProps {
  walls: WallSegment[];
  settings: ViewerSettings;
}

// Scale factor: convert mm to 3D units (1 unit = 1 meter)
const SCALE = 0.001;

// Calculate bounding box of walls in 3D space
function calculateWallsBoundingBox(walls: WallSegment[], maxRows: number) {
  if (walls.length === 0) return null;
  
  let minX = Infinity, minY = Infinity, minZ = 0;
  let maxX = -Infinity, maxY = -Infinity, maxZ = maxRows * PANEL_HEIGHT;
  
  walls.forEach(wall => {
    minX = Math.min(minX, wall.startX, wall.endX);
    maxX = Math.max(maxX, wall.startX, wall.endX);
    minY = Math.min(minY, wall.startY, wall.endY);
    maxY = Math.max(maxY, wall.startY, wall.endY);
  });
  
  return {
    min: new THREE.Vector3(minX * SCALE, minZ * SCALE, minY * SCALE),
    max: new THREE.Vector3(maxX * SCALE, maxZ * SCALE, maxY * SCALE),
    center: new THREE.Vector3(
      ((minX + maxX) / 2) * SCALE,
      ((minZ + maxZ) / 2) * SCALE,
      ((minY + maxY) / 2) * SCALE
    ),
    size: new THREE.Vector3(
      (maxX - minX) * SCALE,
      (maxZ - minZ) * SCALE,
      (maxY - minY) * SCALE
    )
  };
}

function ICFPanelInstances({ walls, settings }: ICFPanelInstancesProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  
  const { positions, count } = useMemo(() => {
    const positions: { matrix: THREE.Matrix4; color: THREE.Color }[] = [];
    
    walls.forEach(wall => {
      const length = calculateWallLength(wall);
      const angle = calculateWallAngle(wall);
      const panelCount = Math.ceil(length / PANEL_WIDTH);
      
      // Only show up to current row
      for (let row = 0; row < Math.min(settings.currentRow, settings.maxRows); row++) {
        for (let i = 0; i < panelCount; i++) {
          const progress = (i + 0.5) / panelCount;
          const x = wall.startX + (wall.endX - wall.startX) * progress;
          const y = wall.startY + (wall.endY - wall.startY) * progress;
          const z = row * PANEL_HEIGHT;
          
          const matrix = new THREE.Matrix4();
          matrix.compose(
            new THREE.Vector3(x * SCALE, z * SCALE, y * SCALE),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
            new THREE.Vector3(1, 1, 1)
          );
          
          positions.push({
            matrix,
            color: new THREE.Color().setHSL(0.55, 0.1, 0.7 + (row % 2) * 0.05)
          });
        }
      }
    });
    
    return { positions, count: positions.length };
  }, [walls, settings.currentRow, settings.maxRows]);
  
  // Update instance matrices
  useMemo(() => {
    if (!meshRef.current || count === 0) return;
    
    positions.forEach((pos, i) => {
      meshRef.current!.setMatrixAt(i, pos.matrix);
      meshRef.current!.setColorAt(i, pos.color);
    });
    
    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.needsUpdate = true;
    }
  }, [positions, count]);
  
  if (count === 0) return null;
  
  const panelGeometry = new THREE.BoxGeometry(
    PANEL_WIDTH * SCALE,
    PANEL_HEIGHT * SCALE,
    PANEL_THICKNESS * SCALE
  );
  
  return (
    <instancedMesh
      ref={meshRef}
      args={[panelGeometry, undefined, count]}
      frustumCulled={false}
    >
      <meshStandardMaterial
        color="#a8b4c4"
        roughness={0.7}
        metalness={0.1}
        wireframe={settings.wireframe}
      />
    </instancedMesh>
  );
}

// Webs visualization component
function WebsInstances({ walls, settings }: ICFPanelInstancesProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  
  const websPerRow = calculateWebsPerRow(settings.rebarSpacing);
  
  const { positions, count } = useMemo(() => {
    const positions: THREE.Matrix4[] = [];
    
    walls.forEach(wall => {
      const length = calculateWallLength(wall);
      const angle = calculateWallAngle(wall);
      
      for (let row = 0; row < Math.min(settings.currentRow, settings.maxRows); row++) {
        // Distribute webs evenly along the wall
        for (let w = 0; w < websPerRow; w++) {
          const progress = (w + 0.5) / websPerRow;
          const x = wall.startX + (wall.endX - wall.startX) * progress;
          const y = wall.startY + (wall.endY - wall.startY) * progress;
          const z = row * PANEL_HEIGHT + PANEL_HEIGHT / 2;
          
          const matrix = new THREE.Matrix4();
          matrix.compose(
            new THREE.Vector3(x * SCALE, z * SCALE, y * SCALE),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
            new THREE.Vector3(1, 1, 1)
          );
          
          positions.push(matrix);
        }
      }
    });
    
    return { positions, count: positions.length };
  }, [walls, settings.currentRow, settings.maxRows, websPerRow]);
  
  useMemo(() => {
    if (!meshRef.current || count === 0) return;
    positions.forEach((matrix, i) => {
      meshRef.current!.setMatrixAt(i, matrix);
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [positions, count]);
  
  if (count === 0) return null;
  
  // Small cylinder for webs
  const webGeometry = new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8);
  
  return (
    <instancedMesh
      ref={meshRef}
      args={[webGeometry, undefined, count]}
      frustumCulled={false}
    >
      <meshStandardMaterial color="#e8a645" roughness={0.6} metalness={0.3} />
    </instancedMesh>
  );
}

// Grids (Stabilization) visualization component
function GridsInstances({ walls, settings }: ICFPanelInstancesProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  
  const gridRows = calculateGridRows(settings.maxRows);
  
  const { positions, count } = useMemo(() => {
    const positions: THREE.Matrix4[] = [];
    
    // Only show grids for rows that are visible and are grid rows
    const visibleGridRows = gridRows.filter(row => row < settings.currentRow);
    
    walls.forEach(wall => {
      const length = calculateWallLength(wall);
      const angle = calculateWallAngle(wall);
      const numGridSegments = Math.ceil(length / 3000); // 3m segments
      
      visibleGridRows.forEach(row => {
        // Distribute grid segments along the wall
        for (let g = 0; g < numGridSegments; g++) {
          const segmentLength = Math.min(3000, length - g * 3000);
          const progress = (g * 3000 + segmentLength / 2) / length;
          const x = wall.startX + (wall.endX - wall.startX) * progress;
          const y = wall.startY + (wall.endY - wall.startY) * progress;
          const z = row * PANEL_HEIGHT + PANEL_HEIGHT * 0.9; // Near top of panel
          
          const matrix = new THREE.Matrix4();
          matrix.compose(
            new THREE.Vector3(x * SCALE, z * SCALE, y * SCALE),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
            new THREE.Vector3(segmentLength / 3000, 1, 1) // Scale based on segment length
          );
          
          positions.push(matrix);
        }
      });
    });
    
    return { positions, count: positions.length };
  }, [walls, settings.currentRow, settings.maxRows, gridRows]);
  
  useMemo(() => {
    if (!meshRef.current || count === 0) return;
    positions.forEach((matrix, i) => {
      meshRef.current!.setMatrixAt(i, matrix);
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [positions, count]);
  
  if (count === 0) return null;
  
  // Flat box for grid representation (3m long, thin)
  const gridGeometry = new THREE.BoxGeometry(3, 0.05, 0.15);
  
  return (
    <instancedMesh
      ref={meshRef}
      args={[gridGeometry, undefined, count]}
      frustumCulled={false}
    >
      <meshStandardMaterial color="#e53935" roughness={0.5} metalness={0.2} />
    </instancedMesh>
  );
}

// Camera controller that auto-fits to walls
function CameraController({ walls, settings }: { walls: WallSegment[]; settings: ViewerSettings }) {
  const { camera, controls } = useThree();
  const prevFitKeyRef = useRef<string>('');

  const fitToWalls = () => {
    const bbox = calculateWallsBoundingBox(walls, settings.maxRows);
    if (!bbox || !controls) return;

    // Always target the scene center (after normalization, center should be near origin)
    (controls as any).target.copy(bbox.center);

    const maxDim = Math.max(bbox.size.x, bbox.size.y, bbox.size.z);
    const distance = Math.max(5, maxDim * 1.8 + 5);

    // Improve clipping for large models
    camera.near = Math.max(0.01, distance / 1000);
    camera.far = Math.max(500, distance * 50);
    camera.updateProjectionMatrix();

    const angle = Math.PI / 4;
    camera.position.set(
      bbox.center.x + distance * Math.cos(angle),
      bbox.center.y + distance * 0.6,
      bbox.center.z + distance * Math.sin(angle)
    );

    (controls as any).update();
  };

  useEffect(() => {
    const bbox = calculateWallsBoundingBox(walls, settings.maxRows);
    if (!bbox || walls.length === 0) {
      prevFitKeyRef.current = '';
      return;
    }

    // Refit if geometry meaningfully changed (replace-mode imports may keep same count)
    const fitKey = [
      walls.length,
      bbox.min.x.toFixed(3),
      bbox.min.z.toFixed(3),
      bbox.max.x.toFixed(3),
      bbox.max.z.toFixed(3),
      bbox.size.x.toFixed(3),
      bbox.size.z.toFixed(3)
    ].join('|');

    if (fitKey !== prevFitKeyRef.current) {
      fitToWalls();
      prevFitKeyRef.current = fitKey;
    }
  }, [walls, settings.maxRows]);

  useEffect(() => {
    const onFit = () => {
      if (walls.length > 0) fitToWalls();
    };

    window.addEventListener('icf-fit-view', onFit as EventListener);
    return () => window.removeEventListener('icf-fit-view', onFit as EventListener);
  }, [walls]);

  return null;
}

function Scene({ walls, settings }: { walls: WallSegment[]; settings: ViewerSettings }) {
  // Calculate center of the scene for initial view
  const center = useMemo(() => {
    if (walls.length === 0) return new THREE.Vector3(0, 1, 0);
    
    const bbox = calculateWallsBoundingBox(walls, settings.maxRows);
    return bbox ? bbox.center : new THREE.Vector3(0, 1, 0);
  }, [walls, settings.maxRows]);
  
  // Calculate initial camera position based on bbox
  const initialCameraPosition = useMemo(() => {
    if (walls.length === 0) return new THREE.Vector3(10, 8, 10);
    
    const bbox = calculateWallsBoundingBox(walls, settings.maxRows);
    if (!bbox) return new THREE.Vector3(10, 8, 10);
    
    const maxDim = Math.max(bbox.size.x, bbox.size.y, bbox.size.z);
    const distance = maxDim * 1.8 + 5;
    const angle = Math.PI / 4;
    
    return new THREE.Vector3(
      bbox.center.x + distance * Math.cos(angle),
      bbox.center.y + distance * 0.6,
      bbox.center.z + distance * Math.sin(angle)
    );
  }, [walls, settings.maxRows]);
  
  return (
    <>
      <PerspectiveCamera makeDefault position={initialCameraPosition} fov={50} />
      <OrbitControls
        target={center}
        enableDamping
        dampingFactor={0.05}
        minDistance={1}
        maxDistance={2000}
      />
      <CameraController walls={walls} settings={settings} />
      
      {/* Lighting */}
      <ambientLight intensity={0.4} />
      <directionalLight
        position={[10, 20, 10]}
        intensity={1}
        castShadow
        shadow-mapSize={[2048, 2048]}
      />
      <directionalLight position={[-10, 10, -10]} intensity={0.3} />
      
      {/* Grid */}
      {settings.showGrid && (
        <Grid
          position={[center.x, 0, center.z]}
          args={[100, 100]}
          cellSize={1}
          cellThickness={0.5}
          cellColor="#1e3a5f"
          sectionSize={5}
          sectionThickness={1}
          sectionColor="#2a5280"
          fadeDistance={100}
          fadeStrength={1}
          followCamera={false}
        />
      )}
      
      {/* ICF Panels */}
      {settings.showPanels && <ICFPanelInstances walls={walls} settings={settings} />}
      
      {/* Webs */}
      {settings.showWebs && <WebsInstances walls={walls} settings={settings} />}
      
      {/* Stabilization Grids */}
      {settings.showGrids && <GridsInstances walls={walls} settings={settings} />}
      
      {/* Environment for reflections */}
      <Environment preset="city" />
    </>
  );
}

interface ICFViewer3DProps {
  walls: WallSegment[];
  settings: ViewerSettings;
  className?: string;
}

export function ICFViewer3D({ walls, settings, className = '' }: ICFViewer3DProps) {
  return (
    <div className={`viewer-container ${className}`}>
      <Canvas
        shadows
        gl={{ 
          antialias: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.2
        }}
        style={{ background: 'transparent' }}
      >
        <Scene walls={walls} settings={settings} />
      </Canvas>
      
      {/* Overlay gradient for depth */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-background/50 to-transparent" />
      </div>
    </div>
  );
}
