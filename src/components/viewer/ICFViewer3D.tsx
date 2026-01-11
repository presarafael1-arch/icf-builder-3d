import { useRef, useMemo, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid, Environment, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { PANEL_WIDTH, PANEL_HEIGHT, PANEL_THICKNESS, WallSegment, ViewerSettings } from '@/types/icf';
import { calculateWallAngle, calculateWallLength } from '@/lib/icf-calculations';

interface ICFPanelInstancesProps {
  walls: WallSegment[];
  settings: ViewerSettings;
}

// Scale factor: convert mm to 3D units (1 unit = 1 meter)
const SCALE = 0.001;

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

function Scene({ walls, settings }: { walls: WallSegment[]; settings: ViewerSettings }) {
  const controlsRef = useRef(null);
  
  // Calculate center of the scene
  const center = useMemo(() => {
    if (walls.length === 0) return new THREE.Vector3(0, 0, 0);
    
    let sumX = 0, sumY = 0;
    walls.forEach(wall => {
      sumX += (wall.startX + wall.endX) / 2;
      sumY += (wall.startY + wall.endY) / 2;
    });
    
    return new THREE.Vector3(
      (sumX / walls.length) * SCALE,
      (settings.maxRows * PANEL_HEIGHT * SCALE) / 2,
      (sumY / walls.length) * SCALE
    );
  }, [walls, settings.maxRows]);
  
  return (
    <>
      <PerspectiveCamera makeDefault position={[10, 8, 10]} fov={50} />
      <OrbitControls
        ref={controlsRef}
        target={center}
        enableDamping
        dampingFactor={0.05}
        minDistance={2}
        maxDistance={50}
      />
      
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
          position={[0, 0, 0]}
          args={[50, 50]}
          cellSize={1}
          cellThickness={0.5}
          cellColor="#1e3a5f"
          sectionSize={5}
          sectionThickness={1}
          sectionColor="#2a5280"
          fadeDistance={50}
          fadeStrength={1}
          followCamera={false}
        />
      )}
      
      {/* ICF Panels */}
      {settings.showPanels && <ICFPanelInstances walls={walls} settings={settings} />}
      
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
