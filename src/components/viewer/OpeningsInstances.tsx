// 3D rendering of openings (gaps) and TOPOS for ICF Viewer
import { useRef, useMemo } from 'react';
import * as THREE from 'three';
import { PANEL_HEIGHT, PANEL_THICKNESS, ViewerSettings } from '@/types/icf';
import { OpeningData, getAffectedRows } from '@/types/openings';
import { WallChain } from '@/lib/wall-chains';
import { getTopoPlacementsForOpenings } from '@/lib/openings-calculations';

// Scale factor: convert mm to 3D units (1 unit = 1 meter)
const SCALE = 0.001;

interface ToposInstancesProps {
  chains: WallChain[];
  openings: OpeningData[];
  settings: ViewerSettings;
}

// Topos at opening edges - dark green boxes
export function OpeningToposInstances({ chains, openings, settings }: ToposInstancesProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  
  const concreteThicknessMm = parseInt(settings.concreteThickness);
  
  const { positions, count } = useMemo(() => {
    if (openings.length === 0) return { positions: [], count: 0 };
    
    const topoPositions: { matrix: THREE.Matrix4; color: THREE.Color }[] = [];
    const placements = getTopoPlacementsForOpenings(chains, openings, concreteThicknessMm);
    
    for (const placement of placements) {
      // Only show topos up to current row
      if (placement.row >= settings.currentRow) continue;
      
      const z = placement.row * PANEL_HEIGHT;
      
      const matrix = new THREE.Matrix4();
      matrix.compose(
        new THREE.Vector3(
          placement.x * SCALE,
          z * SCALE + PANEL_HEIGHT * SCALE * 0.5, // Center of panel height
          placement.y * SCALE
        ),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -placement.angle),
        new THREE.Vector3(1, 1, 1)
      );
      
      topoPositions.push({
        matrix,
        color: new THREE.Color('#1a5a2a'), // Dark green for topos
      });
    }
    
    return { positions: topoPositions, count: topoPositions.length };
  }, [chains, openings, settings.currentRow, concreteThicknessMm]);
  
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
  
  // Topo geometry: tc x 400 x panel thickness
  const topoGeometry = new THREE.BoxGeometry(
    concreteThicknessMm * SCALE, // Width = concrete thickness
    PANEL_HEIGHT * SCALE, // Height = panel height
    PANEL_THICKNESS * SCALE // Depth = panel thickness
  );
  
  return (
    <instancedMesh 
      ref={meshRef} 
      args={[topoGeometry, undefined, Math.max(1, count)]} 
      frustumCulled={false}
    >
      <meshStandardMaterial 
        color="#1a5a2a" 
        roughness={0.5} 
        metalness={0.1} 
      />
    </instancedMesh>
  );
}

interface OpeningMarkersProps {
  chains: WallChain[];
  openings: OpeningData[];
  settings: ViewerSettings;
}

// Opening markers - colored rectangles to show opening positions
export function OpeningMarkers({ chains, openings, settings }: OpeningMarkersProps) {
  const geometry = useMemo(() => {
    if (openings.length === 0) return null;
    
    const positions: number[] = [];
    const colors: number[] = [];
    
    for (const opening of openings) {
      const chain = chains.find(c => c.id === opening.chainId);
      if (!chain) continue;
      
      const { startRow, endRow } = getAffectedRows(opening.sillMm, opening.heightMm);
      
      // Draw opening outline for affected rows (up to current row)
      for (let row = startRow; row < Math.min(endRow, settings.currentRow); row++) {
        const z = row * PANEL_HEIGHT;
        
        // Calculate positions along chain for left and right edges
        const leftProgress = opening.offsetMm / chain.lengthMm;
        const rightProgress = (opening.offsetMm + opening.widthMm) / chain.lengthMm;
        
        const leftX = chain.startX + (chain.endX - chain.startX) * leftProgress;
        const leftY = chain.startY + (chain.endY - chain.startY) * leftProgress;
        const rightX = chain.startX + (chain.endX - chain.startX) * rightProgress;
        const rightY = chain.startY + (chain.endY - chain.startY) * rightProgress;
        
        // Bottom line
        positions.push(leftX * SCALE, z * SCALE + 0.01, leftY * SCALE);
        positions.push(rightX * SCALE, z * SCALE + 0.01, rightY * SCALE);
        
        // Top line
        positions.push(leftX * SCALE, (z + PANEL_HEIGHT) * SCALE + 0.01, leftY * SCALE);
        positions.push(rightX * SCALE, (z + PANEL_HEIGHT) * SCALE + 0.01, rightY * SCALE);
        
        // Left edge
        positions.push(leftX * SCALE, z * SCALE + 0.01, leftY * SCALE);
        positions.push(leftX * SCALE, (z + PANEL_HEIGHT) * SCALE + 0.01, leftY * SCALE);
        
        // Right edge
        positions.push(rightX * SCALE, z * SCALE + 0.01, rightY * SCALE);
        positions.push(rightX * SCALE, (z + PANEL_HEIGHT) * SCALE + 0.01, rightY * SCALE);
        
        // Color based on opening type
        const color = opening.kind === 'door' 
          ? new THREE.Color('#ff8c00') // Orange for doors
          : new THREE.Color('#1e90ff'); // Blue for windows
        
        for (let i = 0; i < 8; i++) {
          colors.push(color.r, color.g, color.b);
        }
      }
    }
    
    if (positions.length === 0) return null;
    
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.computeBoundingSphere();
    return g;
  }, [chains, openings, settings.currentRow]);
  
  if (!geometry) return null;
  
  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial vertexColors linewidth={2} />
    </lineSegments>
  );
}
