import { useRef, useMemo, useEffect, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, Environment, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { PANEL_WIDTH, PANEL_HEIGHT, PANEL_THICKNESS, WallSegment, ViewerSettings } from '@/types/icf';
import { OpeningData, getAffectedRows } from '@/types/openings';
import { calculateWallAngle, calculateWallLength, calculateGridRows, calculateWebsPerRow } from '@/lib/icf-calculations';
import { buildWallChains } from '@/lib/wall-chains';
import { getRemainingIntervalsForRow } from '@/lib/openings-calculations';
import { DiagnosticsHUD } from './DiagnosticsHUD';
import { PanelLegend } from './PanelLegend';

// Panel counts by type for legend
export interface PanelCounts {
  FULL: number;
  CUT_SINGLE: number;
  CUT_DOUBLE: number;
  CORNER_CUT: number;
  TOPO: number;
  OPENING_VOID: number;
}

interface ICFPanelInstancesProps {
  walls: WallSegment[];
  settings: ViewerSettings;
  openings?: OpeningData[];
  onInstanceCountChange?: (count: number) => void;
  onCountsChange?: (counts: PanelCounts) => void;
}

// Scale factor: convert mm to 3D units (1 unit = 1 meter)
const SCALE = 0.001;

// Calculate bounding box of WALL SEGMENTS in 3D space
function calculateWallsBoundingBox(walls: WallSegment[], maxRows: number) {
  if (walls.length === 0) return null;

  let minX = Infinity,
    minY = Infinity,
    minZ = 0;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = maxRows * PANEL_HEIGHT;

  walls.forEach((wall) => {
    minX = Math.min(minX, wall.startX, wall.endX);
    maxX = Math.max(maxX, wall.startX, wall.endX);
    minY = Math.min(minY, wall.startY, wall.endY);
    maxY = Math.max(maxY, wall.startY, wall.endY);
  });

  return {
    min: new THREE.Vector3(minX * SCALE, minZ * SCALE, minY * SCALE),
    max: new THREE.Vector3(maxX * SCALE, maxZ * SCALE, maxY * SCALE),
    center: new THREE.Vector3(((minX + maxX) / 2) * SCALE, ((minZ + maxZ) / 2) * SCALE, ((minY + maxY) / 2) * SCALE),
    size: new THREE.Vector3((maxX - minX) * SCALE, (maxZ - minZ) * SCALE, (maxY - minY) * SCALE),
  };
}

// Calculate bounding box of CHAINS in 3D space (preferred for fit view)
function calculateChainsBoundingBox(chains: { startX: number; startY: number; endX: number; endY: number }[], maxRows: number) {
  if (chains.length === 0) return null;

  let minX = Infinity,
    minY = Infinity,
    minZ = 0;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = maxRows * PANEL_HEIGHT;

  chains.forEach((c) => {
    minX = Math.min(minX, c.startX, c.endX);
    maxX = Math.max(maxX, c.startX, c.endX);
    minY = Math.min(minY, c.startY, c.endY);
    maxY = Math.max(maxY, c.startY, c.endY);
  });

  return {
    min: new THREE.Vector3(minX * SCALE, minZ * SCALE, minY * SCALE),
    max: new THREE.Vector3(maxX * SCALE, maxZ * SCALE, maxY * SCALE),
    center: new THREE.Vector3(((minX + maxX) / 2) * SCALE, ((minZ + maxZ) / 2) * SCALE, ((minY + maxY) / 2) * SCALE),
    size: new THREE.Vector3((maxX - minX) * SCALE, (maxZ - minZ) * SCALE, (maxY - minY) * SCALE),
  };
}

// DXF Segments debug layer (thin gray lines)
function DXFDebugLines({ walls }: { walls: WallSegment[] }) {
  const geometry = useMemo(() => {
    const positions = new Float32Array(walls.length * 2 * 3);

    for (let i = 0; i < walls.length; i++) {
      const w = walls[i];
      // Plane: XZ (Y is up). We map 2D Y -> Z.
      positions[i * 6 + 0] = w.startX * SCALE;
      positions[i * 6 + 1] = 0.01; // Slightly above ground
      positions[i * 6 + 2] = w.startY * SCALE;
      positions[i * 6 + 3] = w.endX * SCALE;
      positions[i * 6 + 4] = 0.01;
      positions[i * 6 + 5] = w.endY * SCALE;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.computeBoundingSphere();
    return g;
  }, [walls]);

  if (walls.length === 0) return null;

  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial color={'#666666'} linewidth={1} opacity={0.5} transparent />
    </lineSegments>
  );
}

// Chain overlay (thick cyan lines) - uses consolidated chains
function ChainOverlay({ walls }: { walls: WallSegment[] }) {
  const chainsResult = useMemo(() => buildWallChains(walls), [walls]);
  
  const geometry = useMemo(() => {
    const chains = chainsResult.chains;
    const positions = new Float32Array(chains.length * 2 * 3);

    for (let i = 0; i < chains.length; i++) {
      const c = chains[i];
      positions[i * 6 + 0] = c.startX * SCALE;
      positions[i * 6 + 1] = 0.02; // Above segments
      positions[i * 6 + 2] = c.startY * SCALE;
      positions[i * 6 + 3] = c.endX * SCALE;
      positions[i * 6 + 4] = 0.02;
      positions[i * 6 + 5] = c.endY * SCALE;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.computeBoundingSphere();
    return g;
  }, [chainsResult]);

  if (chainsResult.chains.length === 0) return null;

  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial color={'#00ffff'} linewidth={2} />
    </lineSegments>
  );
}

function DebugHelpers({ walls, settings }: { walls: WallSegment[]; settings: ViewerSettings }) {
  const bbox = useMemo(() => calculateWallsBoundingBox(walls, settings.maxRows), [walls, settings.maxRows]);

  const box = useMemo(() => {
    if (!bbox) return null;
    const b = new THREE.Box3(bbox.min.clone(), bbox.max.clone());
    return b;
  }, [bbox]);

  if (!bbox || !box) return null;

  return (
    <>
      <axesHelper args={[2]} />
      <box3Helper args={[box, new THREE.Color('hsl(50 90% 55%)')]} />
    </>
  );
}

// Panel type for coloring - PERMANENT colors by classification
export type PanelType = 'FULL' | 'CUT_SINGLE' | 'CUT_DOUBLE' | 'CORNER_CUT' | 'TOPO';

// Color palette for panel types (matching reference image)
export const PANEL_COLORS = {
  FULL: new THREE.Color('#d4a83a'),        // Yellow - full panel (1200mm)
  CUT_SINGLE: new THREE.Color('#7cb342'),  // Light green - cut on ONE side only
  CUT_DOUBLE: new THREE.Color('#d97734'),  // Orange - cut on BOTH sides (miolo)
  CORNER_CUT: new THREE.Color('#c62828'),  // Red - corner adjustment panels
  TOPO: new THREE.Color('#2d5a27'),        // Dark green - topos
  OPENING_VOID: new THREE.Color('#ff6b6b'), // Red translucent - opening voids
};

// Stagger offset for odd rows (for interlocking pattern)
const STAGGER_OFFSET = 600; // mm

// Minimum cut length (anything less is waste)
const MIN_CUT_MM = 100;

// Panel instance with classification
interface ClassifiedPanel {
  matrix: THREE.Matrix4;
  type: PanelType;
  widthMm: number;
  isStartCut: boolean;
  isEndCut: boolean;
  isCorner: boolean;
  rowIndex: number;
}

// Main panel instances component - renders panels based on chains with opening gaps and stagger
// PERMANENT COLORS by panel type (not hover-dependent)
function ICFPanelInstances({ walls, settings, openings = [], onInstanceCountChange, onCountsChange }: ICFPanelInstancesProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  // IMPORTANT: render panels from CHAINS (logical runs), not raw segments
  const chainsResult = useMemo(
    () => buildWallChains(walls, { snapTolMm: 5, gapTolMm: 10, angleTolDeg: 2, noiseMinMm: 100 }),
    [walls]
  );
  const chains = chainsResult.chains;

  // Stable geometry (memoized to avoid recreation on each render)
  const panelGeometry = useMemo(() => {
    return new THREE.BoxGeometry(PANEL_WIDTH * SCALE, PANEL_HEIGHT * SCALE, PANEL_THICKNESS * SCALE);
  }, []);

  // Generate classified panel placements
  const { panels, counts } = useMemo(() => {
    const panels: ClassifiedPanel[] = [];
    const counts = { FULL: 0, CUT_SINGLE: 0, CUT_DOUBLE: 0, CORNER_CUT: 0, TOPO: 0 };

    if (chains.length === 0) {
      console.log('[ICFPanelInstances] No chains, skipping panel generation');
      return { panels, counts };
    }

    // For each chain
    chains.forEach((chain, chainIndex) => {
      const chainLength = chain.lengthMm;
      if (chainLength < 50) return; // Skip tiny chains
      
      const angle = Math.atan2(chain.endY - chain.startY, chain.endX - chain.startX);
      const dirX = (chain.endX - chain.startX) / chainLength;
      const dirY = (chain.endY - chain.startY) / chainLength;
      
      // Check if this chain is at a corner (first or last in sequence might be corner)
      const isCornerChain = chainIndex === 0 || chainIndex === chains.length - 1;

      // Only show up to current row (slider controls this)
      const visibleRows = Math.min(settings.currentRow, settings.maxRows);
      
      for (let row = 0; row < visibleRows; row++) {
        // Apply stagger offset for odd rows (interlocking pattern)
        const isOddRow = row % 2 === 1;
        const staggerOffset = isOddRow ? STAGGER_OFFSET : 0;
        
        // Get remaining intervals for this row (accounting for openings)
        const intervals = getRemainingIntervalsForRow(chain, openings, row);

        // For each interval, place panels
        intervals.forEach((interval) => {
          const intervalStart = interval.start;
          const intervalEnd = interval.end;
          const intervalLength = intervalEnd - intervalStart;
          
          if (intervalLength < MIN_CUT_MM) return; // Skip tiny intervals
          
          // For stagger: offset the starting position for the first interval only
          let cursor = intervalStart;
          
          // Handle stagger cut piece at the very start of chain (row odd, first interval)
          if (isOddRow && intervalStart === 0 && staggerOffset > 0) {
            const cutWidth = Math.min(staggerOffset, intervalEnd);
            if (cutWidth >= MIN_CUT_MM) {
              // Create stagger cut panel
              const posX = chain.startX + dirX * (cutWidth / 2);
              const posZ = chain.startY + dirY * (cutWidth / 2);
              const posY = row * PANEL_HEIGHT + PANEL_HEIGHT / 2;

              const matrix = new THREE.Matrix4();
              matrix.compose(
                new THREE.Vector3(posX * SCALE, posY * SCALE, posZ * SCALE),
                new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
                new THREE.Vector3(cutWidth / PANEL_WIDTH, 1, 1)
              );

              const panelType: PanelType = isCornerChain ? 'CORNER_CUT' : 'CUT_SINGLE';
              counts[panelType]++;
              
              panels.push({
                matrix,
                type: panelType,
                widthMm: cutWidth,
                isStartCut: true,
                isEndCut: false,
                isCorner: isCornerChain,
                rowIndex: row,
              });
            }
            cursor = staggerOffset;
          }
          
          // Place panels from cursor to interval end
          while (cursor < intervalEnd) {
            const remainingLength = intervalEnd - cursor;
            const panelWidth = Math.min(PANEL_WIDTH, remainingLength);
            
            if (panelWidth < MIN_CUT_MM) break;
            
            const panelCenter = cursor + panelWidth / 2;
            const posX = chain.startX + dirX * panelCenter;
            const posZ = chain.startY + dirY * panelCenter;
            const posY = row * PANEL_HEIGHT + PANEL_HEIGHT / 2;

            const matrix = new THREE.Matrix4();
            matrix.compose(
              new THREE.Vector3(posX * SCALE, posY * SCALE, posZ * SCALE),
              new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
              new THREE.Vector3(panelWidth / PANEL_WIDTH, 1, 1)
            );

            // Determine panel type based on width
            let panelType: PanelType = 'FULL';
            const isCut = panelWidth < PANEL_WIDTH - 10;
            
            if (isCut) {
              const isAtChainEnd = (cursor < 50) || (chainLength - (cursor + panelWidth) < 50);
              if (isCornerChain && isAtChainEnd && isOddRow) {
                panelType = 'CORNER_CUT'; // Red - corner adjustment
              } else {
                panelType = 'CUT_SINGLE'; // Light green - cut on one side
              }
            }

            counts[panelType]++;
            
            panels.push({
              matrix,
              type: panelType,
              widthMm: panelWidth,
              isStartCut: cursor === intervalStart,
              isEndCut: isCut,
              isCorner: isCornerChain,
              rowIndex: row,
            });
            
            cursor += PANEL_WIDTH;
          }
        });
      }
    });

    console.log('[ICFPanelInstances] Generated panels:', panels.length, 'counts:', counts);
    return { panels, counts };
  }, [chains, openings, settings.currentRow, settings.maxRows]);

  // Report count and counts-by-type to parent
  useEffect(() => {
    onInstanceCountChange?.(panels.length);
    onCountsChange?.({ ...counts, TOPO: 0, OPENING_VOID: 0 });
  }, [panels.length, counts, onInstanceCountChange, onCountsChange]);

  // Update instance matrices and colors when panels change
  useEffect(() => {
    if (!meshRef.current || panels.length === 0) return;

    panels.forEach((panel, i) => {
      meshRef.current!.setMatrixAt(i, panel.matrix);
      
      // PERMANENT color based on type
      const color = PANEL_COLORS[panel.type].clone();
      
      // Slight row-based brightness variation for visual depth
      const rowVariation = (panel.rowIndex % 3) * 0.02;
      color.offsetHSL(0, 0, rowVariation);
      
      meshRef.current!.setColorAt(i, color);
    });

    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.needsUpdate = true;
    }
  }, [panels]);

  // Don't render if no panels
  if (panels.length === 0) return null;

  return (
    <instancedMesh 
      ref={meshRef} 
      args={[panelGeometry, undefined, panels.length]} 
      frustumCulled={false}
      key={`panels-${panels.length}`}
    >
      <meshStandardMaterial 
        vertexColors
        roughness={0.4} 
        metalness={0.1} 
        wireframe={settings.wireframe}
      />
    </instancedMesh>
  );
}

// Opening VOLUMES (red translucent voids) and TOPOS (dark green) visualization
// Renders the FULL HEIGHT of each opening as a single 3D volume, plus topos on jambs/lintel/sill
function OpeningsVisualization({ walls, settings, openings = [] }: ICFPanelInstancesProps) {
  const voidMeshRef = useRef<THREE.InstancedMesh>(null);
  const topoJambMeshRef = useRef<THREE.InstancedMesh>(null);
  const topoLintelMeshRef = useRef<THREE.InstancedMesh>(null);
  const topoSillMeshRef = useRef<THREE.InstancedMesh>(null);

  const chainsResult = useMemo(
    () => buildWallChains(walls, { snapTolMm: 5, gapTolMm: 10, angleTolDeg: 2, noiseMinMm: 100 }),
    [walls]
  );
  const chains = chainsResult.chains;

  const tc = parseInt(settings.concreteThickness) || 150;

  // Calculate opening void volumes and topos
  const { voidVolumes, jambTopos, lintelTopos, sillTopos, topoCounts } = useMemo(() => {
    const voidVolumes: { matrix: THREE.Matrix4; widthMm: number; heightMm: number }[] = [];
    const jambTopos: THREE.Matrix4[] = [];
    const lintelTopos: THREE.Matrix4[] = [];
    const sillTopos: THREE.Matrix4[] = [];

    openings.forEach(opening => {
      const chain = chains.find(c => c.id === opening.chainId);
      if (!chain) return;

      const angle = Math.atan2(chain.endY - chain.startY, chain.endX - chain.startX);
      const dirX = (chain.endX - chain.startX) / chain.lengthMm;
      const dirY = (chain.endY - chain.startY) / chain.lengthMm;
      const perpX = -dirY; // Perpendicular for topos
      const perpY = dirX;

      const { startRow, endRow } = getAffectedRows(opening.sillMm, opening.heightMm);
      const visibleEndRow = Math.min(endRow, settings.currentRow);
      
      if (visibleEndRow <= startRow) return; // Not visible yet

      // OPENING VOID VOLUME - single box covering full height of opening
      const voidHeightMm = (visibleEndRow - startRow) * PANEL_HEIGHT;
      const voidCenterY = (startRow * PANEL_HEIGHT + voidHeightMm / 2);
      
      const centerOffset = opening.offsetMm + opening.widthMm / 2;
      const centerX = chain.startX + dirX * centerOffset;
      const centerZ = chain.startY + dirY * centerOffset;

      const voidMatrix = new THREE.Matrix4();
      voidMatrix.compose(
        new THREE.Vector3(centerX * SCALE, voidCenterY * SCALE, centerZ * SCALE),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
        new THREE.Vector3(
          opening.widthMm / PANEL_WIDTH, 
          voidHeightMm / PANEL_HEIGHT, 
          1
        )
      );
      voidVolumes.push({ matrix: voidMatrix, widthMm: opening.widthMm, heightMm: voidHeightMm });

      // JAMB TOPOS (vertical pieces on left and right sides of opening)
      // One topo per affected row on each side
      for (let row = startRow; row < visibleEndRow; row++) {
        const rowCenterY = row * PANEL_HEIGHT + PANEL_HEIGHT / 2;

        // Left jamb topo
        const leftOffset = opening.offsetMm - tc / 2;
        const leftX = chain.startX + dirX * leftOffset;
        const leftZ = chain.startY + dirY * leftOffset;
        
        const leftMatrix = new THREE.Matrix4();
        leftMatrix.compose(
          new THREE.Vector3(leftX * SCALE, rowCenterY * SCALE, leftZ * SCALE),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
          new THREE.Vector3(1, 1, 1)
        );
        jambTopos.push(leftMatrix);

        // Right jamb topo
        const rightOffset = opening.offsetMm + opening.widthMm + tc / 2;
        const rightX = chain.startX + dirX * rightOffset;
        const rightZ = chain.startY + dirY * rightOffset;
        
        const rightMatrix = new THREE.Matrix4();
        rightMatrix.compose(
          new THREE.Vector3(rightX * SCALE, rowCenterY * SCALE, rightZ * SCALE),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
          new THREE.Vector3(1, 1, 1)
        );
        jambTopos.push(rightMatrix);
      }

      // LINTEL TOPO (horizontal piece at top of opening)
      if (visibleEndRow >= endRow) {
        const lintelY = endRow * PANEL_HEIGHT - PANEL_HEIGHT / 2;
        const lintelMatrix = new THREE.Matrix4();
        lintelMatrix.compose(
          new THREE.Vector3(centerX * SCALE, lintelY * SCALE, centerZ * SCALE),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
          new THREE.Vector3(opening.widthMm / PANEL_WIDTH, 0.5, 1) // Half height
        );
        lintelTopos.push(lintelMatrix);
      }

      // SILL TOPO (horizontal piece at bottom of opening - for WINDOWS only)
      if (opening.kind === 'window' && opening.sillMm > 0 && startRow >= 0 && settings.currentRow > startRow) {
        const sillY = startRow * PANEL_HEIGHT + PANEL_HEIGHT / 2;
        const sillMatrix = new THREE.Matrix4();
        sillMatrix.compose(
          new THREE.Vector3(centerX * SCALE, sillY * SCALE, centerZ * SCALE),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
          new THREE.Vector3(opening.widthMm / PANEL_WIDTH, 0.5, 1) // Half height
        );
        sillTopos.push(sillMatrix);
      }
    });

    return { 
      voidVolumes, 
      jambTopos, 
      lintelTopos, 
      sillTopos,
      topoCounts: {
        jambs: jambTopos.length,
        lintels: lintelTopos.length,
        sills: sillTopos.length,
        total: jambTopos.length + lintelTopos.length + sillTopos.length,
      }
    };
  }, [chains, openings, settings.currentRow, tc]);

  // Update void volumes
  useEffect(() => {
    if (!voidMeshRef.current || voidVolumes.length === 0) return;
    voidVolumes.forEach(({ matrix }, i) => {
      voidMeshRef.current!.setMatrixAt(i, matrix);
    });
    voidMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [voidVolumes]);

  // Update jamb topos
  useEffect(() => {
    if (!topoJambMeshRef.current || jambTopos.length === 0) return;
    jambTopos.forEach((matrix, i) => {
      topoJambMeshRef.current!.setMatrixAt(i, matrix);
    });
    topoJambMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [jambTopos]);

  // Update lintel topos
  useEffect(() => {
    if (!topoLintelMeshRef.current || lintelTopos.length === 0) return;
    lintelTopos.forEach((matrix, i) => {
      topoLintelMeshRef.current!.setMatrixAt(i, matrix);
    });
    topoLintelMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [lintelTopos]);

  // Update sill topos
  useEffect(() => {
    if (!topoSillMeshRef.current || sillTopos.length === 0) return;
    sillTopos.forEach((matrix, i) => {
      topoSillMeshRef.current!.setMatrixAt(i, matrix);
    });
    topoSillMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [sillTopos]);

  // Geometries
  const voidGeometry = useMemo(() => 
    new THREE.BoxGeometry(PANEL_WIDTH * SCALE, PANEL_HEIGHT * SCALE, PANEL_THICKNESS * SCALE * 0.8), 
  []);
  const topoJambGeometry = useMemo(() => 
    new THREE.BoxGeometry(tc * SCALE, PANEL_HEIGHT * SCALE, PANEL_THICKNESS * SCALE * 1.1),
  [tc]);
  const topoHorizGeometry = useMemo(() => 
    new THREE.BoxGeometry(PANEL_WIDTH * SCALE, PANEL_HEIGHT * SCALE * 0.5, PANEL_THICKNESS * SCALE * 1.1),
  []);

  return (
    <>
      {/* Opening VOID volumes (red translucent - ALWAYS visible) */}
      {voidVolumes.length > 0 && settings.showOpenings && (
        <instancedMesh 
          ref={voidMeshRef} 
          args={[voidGeometry, undefined, voidVolumes.length]} 
          frustumCulled={false}
        >
          <meshStandardMaterial 
            color={PANEL_COLORS.OPENING_VOID} 
            opacity={0.35} 
            transparent 
            side={THREE.DoubleSide}
          />
        </instancedMesh>
      )}

      {/* JAMB Topos (dark green - vertical on sides) */}
      {jambTopos.length > 0 && settings.showTopos && (
        <instancedMesh 
          ref={topoJambMeshRef} 
          args={[topoJambGeometry, undefined, jambTopos.length]} 
          frustumCulled={false}
        >
          <meshStandardMaterial color={PANEL_COLORS.TOPO} roughness={0.5} metalness={0.2} />
        </instancedMesh>
      )}

      {/* LINTEL Topos (dark green - horizontal at top) */}
      {lintelTopos.length > 0 && settings.showTopos && (
        <instancedMesh 
          ref={topoLintelMeshRef} 
          args={[topoHorizGeometry, undefined, lintelTopos.length]} 
          frustumCulled={false}
        >
          <meshStandardMaterial color={PANEL_COLORS.TOPO} roughness={0.5} metalness={0.2} />
        </instancedMesh>
      )}

      {/* SILL Topos (dark green - horizontal at bottom, windows only) */}
      {sillTopos.length > 0 && settings.showTopos && (
        <instancedMesh 
          ref={topoSillMeshRef} 
          args={[topoHorizGeometry, undefined, sillTopos.length]} 
          frustumCulled={false}
        >
          <meshStandardMaterial color={PANEL_COLORS.TOPO} roughness={0.5} metalness={0.2} />
        </instancedMesh>
      )}
    </>
  );
}

// Webs visualization component
function WebsInstances({ walls, settings }: ICFPanelInstancesProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const websPerRow = calculateWebsPerRow(settings.rebarSpacing);

  const { positions, count } = useMemo(() => {
    const positions: THREE.Matrix4[] = [];

    walls.forEach((wall) => {
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
    <instancedMesh ref={meshRef} args={[webGeometry, undefined, count]} frustumCulled={false}>
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
    const visibleGridRows = gridRows.filter((row) => row < settings.currentRow);

    walls.forEach((wall) => {
      const length = calculateWallLength(wall);
      const angle = calculateWallAngle(wall);
      const numGridSegments = Math.ceil(length / 3000); // 3m segments

      visibleGridRows.forEach((row) => {
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
    <instancedMesh ref={meshRef} args={[gridGeometry, undefined, count]} frustumCulled={false}>
      <meshStandardMaterial color="#e53935" roughness={0.5} metalness={0.2} />
    </instancedMesh>
  );
}

// Camera controller that auto-fits to walls (uses CHAINS bbox when available)
function CameraController({ walls, settings }: { walls: WallSegment[]; settings: ViewerSettings }) {
  const { camera, controls } = useThree();
  const prevFitKeyRef = useRef<string>('');

  const getFitBBox = () => {
    const chains = buildWallChains(walls, { snapTolMm: 5, gapTolMm: 10, angleTolDeg: 2, noiseMinMm: 100 }).chains;
    const chainBBox = calculateChainsBoundingBox(chains, settings.maxRows);
    return chainBBox ?? calculateWallsBoundingBox(walls, settings.maxRows);
  };

  const fitToWalls = () => {
    const bbox = getFitBBox();
    if (!bbox || !controls) return;

    (controls as any).target.copy(bbox.center);

    const maxDim = Math.max(bbox.size.x, bbox.size.y, bbox.size.z);
    const distance = Math.max(5, maxDim * 1.8 + 5);

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
    const bbox = getFitBBox();
    if (!bbox || walls.length === 0) {
      prevFitKeyRef.current = '';
      return;
    }

    const fitKey = [
      walls.length,
      bbox.min.x.toFixed(3),
      bbox.min.z.toFixed(3),
      bbox.max.x.toFixed(3),
      bbox.max.z.toFixed(3),
      bbox.size.x.toFixed(3),
      bbox.size.z.toFixed(3),
    ].join('|');

    if (fitKey !== prevFitKeyRef.current) {
      // small timeout helps when controls/canvas just mounted (Estimate page)
      setTimeout(() => fitToWalls(), 0);
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

interface SceneProps {
  walls: WallSegment[];
  settings: ViewerSettings;
  openings?: OpeningData[];
  onPanelCountChange?: (count: number) => void;
  onPanelCountsChange?: (counts: PanelCounts) => void;
}

function Scene({ walls, settings, openings = [], onPanelCountChange, onPanelCountsChange }: SceneProps) {
  const controlsRef = useRef<any>(null);

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

  // Determine what to show based on viewMode
  const showPanelsLayer = settings.showPanels && (settings.viewMode === 'panels' || settings.viewMode === 'both');
  const showLinesLayer = settings.showChains && (settings.viewMode === 'lines' || settings.viewMode === 'both');
  const showSegmentsLayer = settings.showDXFLines;

  return (
    <>
      <PerspectiveCamera makeDefault position={initialCameraPosition} fov={50} />
      <OrbitControls
        ref={controlsRef}
        makeDefault
        target={center}
        enableDamping
        dampingFactor={0.05}
        minDistance={1}
        maxDistance={2000}
      />
      <CameraController walls={walls} settings={settings} />

      {/* Lighting */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[10, 20, 10]} intensity={1} castShadow shadow-mapSize={[2048, 2048]} />
      <directionalLight position={[-10, 10, -10]} intensity={0.3} />

      {/* Debug lines (segments = thin gray) */}
      {showSegmentsLayer && <DXFDebugLines walls={walls} />}
      
      {/* Chain overlay (thick cyan) */}
      {showLinesLayer && <ChainOverlay walls={walls} />}

      {/* Helpers */}
      {settings.showHelpers && <DebugHelpers walls={walls} settings={settings} />}

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
      {showPanelsLayer && (
        <ICFPanelInstances 
          walls={walls} 
          settings={settings} 
          openings={openings} 
          onInstanceCountChange={onPanelCountChange}
          onCountsChange={onPanelCountsChange}
        />
      )}

      {/* Openings and Topos visualization */}
      {openings.length > 0 && settings.showOpenings && (
        <OpeningsVisualization walls={walls} settings={settings} openings={openings} />
      )}

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
  openings?: OpeningData[];
  className?: string;
}

export function ICFViewer3D({ walls, settings, openings = [], className = '' }: ICFViewer3DProps) {
  const [panelInstancesCount, setPanelInstancesCount] = useState(0);
  const [panelCounts, setPanelCounts] = useState<PanelCounts>({
    FULL: 0, CUT_SINGLE: 0, CUT_DOUBLE: 0, CORNER_CUT: 0, TOPO: 0, OPENING_VOID: 0
  });
  const [showLegend, setShowLegend] = useState(true);
  const bbox = useMemo(() => calculateWallsBoundingBox(walls, settings.maxRows), [walls, settings.maxRows]);

  const bboxInfo = useMemo(() => {
    if (!bbox) return null;

    const widthM = bbox.size.x;
    const heightM = bbox.size.z;

    return {
      widthM,
      heightM,
    };
  }, [bbox]);

  // Only show legend when in panels mode
  const showPanelsMode = settings.viewMode === 'panels' || settings.viewMode === 'both';

  return (
    <div className={`viewer-container ${className} relative`}>
      <Canvas
        shadows
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.2 }}
        style={{ background: 'transparent' }}
      >
        <Scene 
          walls={walls} 
          settings={settings} 
          openings={openings} 
          onPanelCountChange={setPanelInstancesCount}
          onPanelCountsChange={setPanelCounts}
        />
      </Canvas>

      {/* Panel Legend - only in panels mode, shows permanent colors and counts */}
      {showPanelsMode && panelInstancesCount > 0 && (
        <PanelLegend 
          visible={showLegend}
          onToggle={() => setShowLegend(!showLegend)}
          showOpenings={settings.showOpenings && openings.length > 0}
          showTopos={settings.showTopos && openings.length > 0}
          counts={panelCounts}
        />
      )}

      {/* Diagnostics HUD */}
      <DiagnosticsHUD 
        walls={walls} 
        settings={settings} 
        openings={openings}
        panelInstancesCount={panelInstancesCount}
      />

      {/* Debug UI (bbox in meters) - only when showing debug lines */}
      {bboxInfo && settings.showHelpers && (
        <div className="absolute top-4 left-4 z-10 rounded-md bg-background/80 backdrop-blur px-3 py-2 text-xs font-mono text-foreground border border-border">
          <div>bbox: {bboxInfo.widthM.toFixed(2)}m × {bboxInfo.heightM.toFixed(2)}m</div>
          <div>paredes: {walls.length}</div>
        </div>
      )}

      {/* Overlay gradient for depth */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-background/50 to-transparent" />
      </div>
    </div>
  );
}
