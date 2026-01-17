import { useRef, useMemo, useEffect, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, Environment, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { PANEL_WIDTH, PANEL_HEIGHT, PANEL_THICKNESS, WallSegment, ViewerSettings } from '@/types/icf';
import { OpeningData, OpeningCandidate, getAffectedRows } from '@/types/openings';
import { calculateWallAngle, calculateWallLength, calculateGridRows, calculateWebsPerRow } from '@/lib/icf-calculations';
import { buildWallChains, WallChain } from '@/lib/wall-chains';
import { getRemainingIntervalsForRow } from '@/lib/openings-calculations';
import { DiagnosticsHUD } from './DiagnosticsHUD';
import { PanelLegend } from './PanelLegend';
import { usePanelGeometry } from '@/hooks/usePanelGeometry';

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

// =============================================
// PANEL COLORS - FIXED HEX VALUES (ALWAYS VISIBLE)
// =============================================
export type PanelType = 'FULL' | 'CUT_SINGLE' | 'CUT_DOUBLE' | 'CORNER_CUT' | 'TOPO';

export const PANEL_COLORS: Record<PanelType | 'OPENING_VOID', string> = {
  FULL: '#E6D44A',        // YELLOW - full panel (1200mm)
  CUT_SINGLE: '#6FD36F',  // LIGHT GREEN - cut on ONE side only (meio-corte)
  CUT_DOUBLE: '#F2992E',  // ORANGE - cut on BOTH sides (corte)
  CORNER_CUT: '#C83A3A',  // RED - corner/stagger adjustment panels
  TOPO: '#0F6B3E',        // DARK GREEN - topos
  OPENING_VOID: '#FF4444', // RED translucent - opening voids and candidates
};

// Stagger offset for odd rows (for interlocking pattern)
const STAGGER_OFFSET = 600; // mm

// Minimum cut length (anything less is waste)
const MIN_CUT_MM = 100;

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
      positions[i * 6 + 0] = w.startX * SCALE;
      positions[i * 6 + 1] = 0.01;
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
      positions[i * 6 + 1] = 0.02;
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

// Panel instance with classification
interface ClassifiedPanel {
  matrix: THREE.Matrix4;
  type: PanelType;
  widthMm: number;
  rowIndex: number;
  chainId?: string;
  isCornerPiece?: boolean;
}

// L-junction info for deterministic corner treatment
interface LJunctionInfo {
  nodeId: string;
  x: number;
  y: number;
  primaryChainId: string;   // Lower chain ID = primary
  secondaryChainId: string; // Higher chain ID = secondary
  primaryAngle: number;
  secondaryAngle: number;
}

// =============================================
// DETECT L-JUNCTIONS AND ASSIGN PRIMARY/SECONDARY ARMS
// Rule: Lower chainId = primary arm (deterministic, never flips)
// =============================================
function detectLJunctions(chains: WallChain[]): LJunctionInfo[] {
  const nodeMap = new Map<string, { x: number; y: number; chainIds: string[]; angles: number[] }>();
  const TOLERANCE = 15; // mm
  
  const getNodeKey = (x: number, y: number) => {
    const rx = Math.round(x / TOLERANCE) * TOLERANCE;
    const ry = Math.round(y / TOLERANCE) * TOLERANCE;
    return `${rx},${ry}`;
  };
  
  chains.forEach(chain => {
    // Start node
    const startKey = getNodeKey(chain.startX, chain.startY);
    if (!nodeMap.has(startKey)) {
      nodeMap.set(startKey, { x: chain.startX, y: chain.startY, chainIds: [], angles: [] });
    }
    const startNode = nodeMap.get(startKey)!;
    startNode.chainIds.push(chain.id);
    startNode.angles.push(chain.angle);
    
    // End node
    const endKey = getNodeKey(chain.endX, chain.endY);
    if (!endKey) return;
    if (!nodeMap.has(endKey)) {
      nodeMap.set(endKey, { x: chain.endX, y: chain.endY, chainIds: [], angles: [] });
    }
    const endNode = nodeMap.get(endKey)!;
    endNode.chainIds.push(chain.id);
    endNode.angles.push(chain.angle + Math.PI);
  });
  
  const lJunctions: LJunctionInfo[] = [];
  
  nodeMap.forEach((node, key) => {
    if (node.chainIds.length !== 2) return; // Not an L-junction
    
    // Check if angles are roughly perpendicular (L-shape)
    const angleDiff = Math.abs(node.angles[0] - node.angles[1]);
    const isLShape = Math.abs(angleDiff - Math.PI / 2) < 0.3 || Math.abs(angleDiff - 3 * Math.PI / 2) < 0.3;
    
    if (!isLShape) return;
    
    // DETERMINISTIC: Lower chainId = primary arm
    const [id1, id2] = node.chainIds;
    const primaryChainId = id1 < id2 ? id1 : id2;
    const secondaryChainId = id1 < id2 ? id2 : id1;
    const primaryIdx = node.chainIds.indexOf(primaryChainId);
    const secondaryIdx = 1 - primaryIdx;
    
    lJunctions.push({
      nodeId: key,
      x: node.x,
      y: node.y,
      primaryChainId,
      secondaryChainId,
      primaryAngle: node.angles[primaryIdx],
      secondaryAngle: node.angles[secondaryIdx],
    });
  });
  
  console.log('[L-Junctions] Detected:', lJunctions.length, lJunctions.map(j => `${j.primaryChainId}/${j.secondaryChainId}`));
  return lJunctions;
}

// =============================================
// CHECK IF CHAIN STARTS/ENDS AT AN L-JUNCTION
// =============================================
function getCornerInfoForChain(
  chain: WallChain,
  lJunctions: LJunctionInfo[],
  tolerance: number = 20
): { 
  startsAtL: LJunctionInfo | null; 
  endsAtL: LJunctionInfo | null;
  isPrimaryAtStart: boolean;
  isPrimaryAtEnd: boolean;
} {
  let startsAtL: LJunctionInfo | null = null;
  let endsAtL: LJunctionInfo | null = null;
  let isPrimaryAtStart = false;
  let isPrimaryAtEnd = false;
  
  for (const lj of lJunctions) {
    const distToStart = Math.sqrt((chain.startX - lj.x) ** 2 + (chain.startY - lj.y) ** 2);
    const distToEnd = Math.sqrt((chain.endX - lj.x) ** 2 + (chain.endY - lj.y) ** 2);
    
    if (distToStart < tolerance) {
      startsAtL = lj;
      isPrimaryAtStart = lj.primaryChainId === chain.id;
    }
    if (distToEnd < tolerance) {
      endsAtL = lj;
      isPrimaryAtEnd = lj.primaryChainId === chain.id;
    }
  }
  
  return { startsAtL, endsAtL, isPrimaryAtStart, isPrimaryAtEnd };
}

// =============================================
// PANEL LAYOUT ALGORITHM: L-CORNER TEMPLATE + CUTS IN THE MIDDLE
// 
// RULE FOR L-CORNERS (PAR/ÍMPAR ALTERNATION):
// - Even rows: primary arm gets FULL panel at corner, secondary gets 600mm CORNER_CUT
// - Odd rows: primary arm gets 600mm CORNER_CUT, secondary gets FULL panel at corner
// 
// RULE FOR MIDDLE:
// - Start from both ends with full panels
// - Push cuts/remainders to the CENTER
// =============================================
function layoutPanelsForChainWithLCorners(
  chain: WallChain,
  intervalStart: number,
  intervalEnd: number,
  row: number,
  lJunctions: LJunctionInfo[]
): ClassifiedPanel[] {
  const panels: ClassifiedPanel[] = [];
  const intervalLength = intervalEnd - intervalStart;
  
  if (intervalLength < MIN_CUT_MM) return panels;
  
  const isOddRow = row % 2 === 1;
  const angle = Math.atan2(chain.endY - chain.startY, chain.endX - chain.startX);
  const dirX = (chain.endX - chain.startX) / chain.lengthMm;
  const dirY = (chain.endY - chain.startY) / chain.lengthMm;
  
  const cornerInfo = getCornerInfoForChain(chain, lJunctions);
  
  // Determine corner template at START
  let leftReservation = 0;
  let leftIsCornerCut = false;
  
  if (cornerInfo.startsAtL && intervalStart === 0) {
    // L-corner at chain start
    // PAR/ÍMPAR RULE:
    // - Even rows: primary = full (1200), secondary = 600 (CORNER_CUT)
    // - Odd rows: primary = 600 (CORNER_CUT), secondary = full (1200)
    const isPrimary = cornerInfo.isPrimaryAtStart;
    
    if (!isOddRow) {
      // EVEN ROW
      leftReservation = isPrimary ? PANEL_WIDTH : STAGGER_OFFSET;
      leftIsCornerCut = !isPrimary; // Secondary gets corner cut
    } else {
      // ODD ROW
      leftReservation = isPrimary ? STAGGER_OFFSET : PANEL_WIDTH;
      leftIsCornerCut = isPrimary; // Primary gets corner cut
    }
  } else if (isOddRow && intervalStart === 0) {
    // No L-junction but odd row: apply standard stagger
    leftReservation = STAGGER_OFFSET;
    leftIsCornerCut = true;
  }
  
  // Determine corner template at END
  let rightReservation = 0;
  let rightIsCornerCut = false;
  
  if (cornerInfo.endsAtL && intervalEnd === chain.lengthMm) {
    const isPrimary = cornerInfo.isPrimaryAtEnd;
    
    if (!isOddRow) {
      rightReservation = isPrimary ? PANEL_WIDTH : STAGGER_OFFSET;
      rightIsCornerCut = !isPrimary;
    } else {
      rightReservation = isPrimary ? STAGGER_OFFSET : PANEL_WIDTH;
      rightIsCornerCut = isPrimary;
    }
  }
  
  const createPanel = (centerPos: number, width: number, type: PanelType, isCorner = false) => {
    const posX = chain.startX + dirX * centerPos;
    const posZ = chain.startY + dirY * centerPos;
    const posY = row * PANEL_HEIGHT + PANEL_HEIGHT / 2;

    const matrix = new THREE.Matrix4();
    matrix.compose(
      new THREE.Vector3(posX * SCALE, posY * SCALE, posZ * SCALE),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
      new THREE.Vector3(width / PANEL_WIDTH, 1, 1)
    );

    return { matrix, type, widthMm: width, rowIndex: row, chainId: chain.id, isCornerPiece: isCorner };
  };
  
  // Place LEFT corner reservation
  let cursor = intervalStart;
  if (leftReservation > 0) {
    const reserveWidth = Math.min(leftReservation, intervalLength);
    if (reserveWidth >= MIN_CUT_MM) {
      const centerPos = cursor + reserveWidth / 2;
      const type: PanelType = leftIsCornerCut ? 'CORNER_CUT' : 'FULL';
      panels.push(createPanel(centerPos, reserveWidth, type, true));
    }
    cursor += leftReservation;
  }
  
  // Place RIGHT corner reservation (calculate but don't place yet)
  const rightEdge = intervalEnd;
  const rightStart = rightEdge - rightReservation;
  
  // Calculate middle section
  const middleStart = cursor;
  const middleEnd = rightReservation > 0 ? rightStart : rightEdge;
  const middleLength = Math.max(0, middleEnd - middleStart);
  
  if (middleLength >= MIN_CUT_MM) {
    // Calculate how many full panels fit and the remainder
    const fullPanelCount = Math.floor(middleLength / PANEL_WIDTH);
    const remainder = middleLength - (fullPanelCount * PANEL_WIDTH);
    
    // LAYOUT: Place from BOTH ends, cut piece in MIDDLE
    const leftCount = Math.floor(fullPanelCount / 2);
    const rightCount = Math.ceil(fullPanelCount / 2);
    
    // Place LEFT side panels
    for (let i = 0; i < leftCount; i++) {
      const centerPos = cursor + PANEL_WIDTH / 2;
      panels.push(createPanel(centerPos, PANEL_WIDTH, 'FULL'));
      cursor += PANEL_WIDTH;
    }
    
    // Place MIDDLE cut piece (if any)
    if (remainder >= MIN_CUT_MM) {
      const centerPos = cursor + remainder / 2;
      panels.push(createPanel(centerPos, remainder, 'CUT_DOUBLE')); // Orange - cut on both sides
      cursor += remainder;
    }
    
    // Place RIGHT side panels
    for (let i = 0; i < rightCount; i++) {
      const centerPos = cursor + PANEL_WIDTH / 2;
      panels.push(createPanel(centerPos, PANEL_WIDTH, 'FULL'));
      cursor += PANEL_WIDTH;
    }
  }
  
  // Place RIGHT corner reservation
  if (rightReservation > 0 && rightStart < rightEdge) {
    const reserveWidth = Math.min(rightReservation, rightEdge - rightStart);
    if (reserveWidth >= MIN_CUT_MM) {
      const centerPos = rightStart + reserveWidth / 2;
      const type: PanelType = rightIsCornerCut ? 'CORNER_CUT' : 'FULL';
      panels.push(createPanel(centerPos, reserveWidth, type, true));
    }
  }
  
  return panels;
}

// =============================================
// BATCH RENDER: One InstancedMesh per panel type + OUTLINE mesh
// This ensures colors are ALWAYS visible (no instanceColor issues)
// =============================================
function BatchedPanelInstances({ 
  chains, 
  settings, 
  openings = [],
  showOutlines = true,
  highFidelity = false,
  onInstanceCountChange,
  onCountsChange,
  onGeometrySourceChange,
  onGeometryMetaChange,
  onLJunctionStatsChange,
}: { 
  chains: WallChain[];
  settings: ViewerSettings; 
  openings: OpeningData[];
  showOutlines?: boolean;
  highFidelity?: boolean;
  onInstanceCountChange?: (count: number) => void;
  onCountsChange?: (counts: PanelCounts) => void;
  onGeometrySourceChange?: (source: 'glb' | 'step' | 'cache' | 'procedural' | 'simple') => void;
  onGeometryMetaChange?: (meta: {
    geometryBBoxM: { x: number; y: number; z: number };
    geometryScaleApplied: number;
    panelMeshVisible: boolean;
    panelMeshBBoxSizeM: { x: number; y: number; z: number };
    instancePosRangeM?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  }) => void;
  onLJunctionStatsChange?: (stats: { lJunctions: number; templatesApplied: number }) => void;
}) {
  // Refs for each panel type mesh
  const fullMeshRef = useRef<THREE.InstancedMesh>(null);
  const cutSingleMeshRef = useRef<THREE.InstancedMesh>(null);
  const cutDoubleMeshRef = useRef<THREE.InstancedMesh>(null);
  const cornerMeshRef = useRef<THREE.InstancedMesh>(null);
  // Outline mesh ref
  const outlineMeshRef = useRef<THREE.InstancedMesh>(null);

  // Get panel geometry from hook (ALWAYS returns valid geometry)
  const {
    geometry: panelGeometry,
    outlineGeometry,
    isHighFidelity,
    isLoading,
    source,
    bboxSizeM,
    scaleApplied,
    geometryValid,
  } = usePanelGeometry(highFidelity);

  // Report geometry meta to parent
  useEffect(() => {
    onGeometrySourceChange?.(source);
  }, [source, onGeometrySourceChange]);

  // Log geometry mode for debugging
  useEffect(() => {
    console.log('[BatchedPanelInstances] Geometry mode:', { 
      highFidelity, isHighFidelity, isLoading, source, bboxSizeM, scaleApplied, geometryValid 
    });
  }, [highFidelity, isHighFidelity, isLoading, source, bboxSizeM, scaleApplied, geometryValid]);

  // Detect L-junctions for deterministic corner treatment
  const lJunctions = useMemo(() => detectLJunctions(chains), [chains]);

  // Generate classified panel placements using L-corner aware layout algorithm
  const { panelsByType, allPanels, lJunctionStats } = useMemo(() => {
    const byType: Record<PanelType, ClassifiedPanel[]> = {
      FULL: [],
      CUT_SINGLE: [],
      CUT_DOUBLE: [],
      CORNER_CUT: [],
      TOPO: [],
    };
    const all: ClassifiedPanel[] = [];
    let lCornerTemplatesApplied = 0;

    if (chains.length === 0) {
      console.log('[BatchedPanelInstances] No chains, skipping panel generation');
      return { panelsByType: byType, allPanels: all, lJunctionStats: { lJunctions: 0, templatesApplied: 0 } };
    }

    chains.forEach((chain) => {
      const chainLength = chain.lengthMm;
      if (chainLength < 50) return;
      
      const visibleRows = Math.min(settings.currentRow, settings.maxRows);
      
      for (let row = 0; row < visibleRows; row++) {
        const intervals = getRemainingIntervalsForRow(chain, openings, row);

        intervals.forEach((interval) => {
          const rowPanels = layoutPanelsForChainWithLCorners(
            chain, 
            interval.start, 
            interval.end, 
            row, 
            lJunctions
          );
          
          rowPanels.forEach(panel => {
            byType[panel.type].push(panel);
            all.push(panel);
            if (panel.isCornerPiece) lCornerTemplatesApplied++;
          });
        });
      }
    });

    console.log('[BatchedPanelInstances] Generated panels by type:', {
      FULL: byType.FULL.length,
      CUT_SINGLE: byType.CUT_SINGLE.length,
      CUT_DOUBLE: byType.CUT_DOUBLE.length,
      CORNER_CUT: byType.CORNER_CUT.length,
      total: all.length,
      lJunctions: lJunctions.length,
      lCornerTemplatesApplied,
    });
    
    return { 
      panelsByType: byType, 
      allPanels: all, 
      lJunctionStats: { lJunctions: lJunctions.length, templatesApplied: lCornerTemplatesApplied } 
    };
   }, [chains, openings, settings.currentRow, settings.maxRows, lJunctions]);

  // Total count and counts by type
  const totalCount = allPanels.length;

  // Report debug meta to HUD/parent
  useEffect(() => {
    const panelMeshVisible = totalCount > 0;

    // instance position range in meters
    const instanceRange = (() => {
      if (allPanels.length === 0) return undefined;
      const min = new THREE.Vector3(Infinity, Infinity, Infinity);
      const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      allPanels.forEach((p) => {
        const pos = new THREE.Vector3();
        pos.setFromMatrixPosition(p.matrix);
        min.min(pos);
        max.max(pos);
      });
      return { min: { x: min.x, y: min.y, z: min.z }, max: { x: max.x, y: max.y, z: max.z } };
    })();

    const panelMeshBBoxSizeM = instanceRange
      ? {
          x: Math.max(0, instanceRange.max.x - instanceRange.min.x),
          y: Math.max(0, instanceRange.max.y - instanceRange.min.y),
          z: Math.max(0, instanceRange.max.z - instanceRange.min.z),
        }
      : { x: 0, y: 0, z: 0 };

    onGeometryMetaChange?.({
      geometryBBoxM: bboxSizeM,
      geometryScaleApplied: scaleApplied,
      panelMeshVisible,
      panelMeshBBoxSizeM,
      instancePosRangeM: instanceRange,
    });
  }, [onGeometryMetaChange, bboxSizeM, scaleApplied, totalCount, allPanels]);
  
  const counts: PanelCounts = {
    FULL: panelsByType.FULL.length,
    CUT_SINGLE: panelsByType.CUT_SINGLE.length,
    CUT_DOUBLE: panelsByType.CUT_DOUBLE.length,
    CORNER_CUT: panelsByType.CORNER_CUT.length,
    TOPO: 0,
    OPENING_VOID: 0,
  };

  // Report counts and L-junction stats to parent
  useEffect(() => {
    onInstanceCountChange?.(totalCount);
    onCountsChange?.(counts);
    onLJunctionStatsChange?.(lJunctionStats);
  }, [totalCount, counts.FULL, counts.CUT_SINGLE, counts.CUT_DOUBLE, counts.CORNER_CUT, lJunctionStats]);

  // Update FULL panels mesh
  useEffect(() => {
    if (!fullMeshRef.current || panelsByType.FULL.length === 0) return;
    panelsByType.FULL.forEach((panel, i) => {
      fullMeshRef.current!.setMatrixAt(i, panel.matrix);
    });
    fullMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [panelsByType.FULL, panelGeometry]);

  // Update CUT_SINGLE panels mesh
  useEffect(() => {
    if (!cutSingleMeshRef.current || panelsByType.CUT_SINGLE.length === 0) return;
    panelsByType.CUT_SINGLE.forEach((panel, i) => {
      cutSingleMeshRef.current!.setMatrixAt(i, panel.matrix);
    });
    cutSingleMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [panelsByType.CUT_SINGLE, panelGeometry]);

  // Update CUT_DOUBLE panels mesh
  useEffect(() => {
    if (!cutDoubleMeshRef.current || panelsByType.CUT_DOUBLE.length === 0) return;
    panelsByType.CUT_DOUBLE.forEach((panel, i) => {
      cutDoubleMeshRef.current!.setMatrixAt(i, panel.matrix);
    });
    cutDoubleMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [panelsByType.CUT_DOUBLE, panelGeometry]);

  // Update CORNER_CUT panels mesh
  useEffect(() => {
    if (!cornerMeshRef.current || panelsByType.CORNER_CUT.length === 0) return;
    panelsByType.CORNER_CUT.forEach((panel, i) => {
      cornerMeshRef.current!.setMatrixAt(i, panel.matrix);
    });
    cornerMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [panelsByType.CORNER_CUT, panelGeometry]);

  // Update OUTLINE mesh (all panels get outlines)
  useEffect(() => {
    if (!outlineMeshRef.current || allPanels.length === 0) return;
    allPanels.forEach((panel, i) => {
      outlineMeshRef.current!.setMatrixAt(i, panel.matrix);
    });
    outlineMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [allPanels, outlineGeometry]);

  const wireframe = settings.wireframe;

  // Don't render if no panels
  if (totalCount === 0) return null;

  return (
    <>
      {/* FULL panels - YELLOW */}
      {panelsByType.FULL.length > 0 && (
        <instancedMesh 
          ref={fullMeshRef} 
          args={[panelGeometry, undefined, panelsByType.FULL.length]} 
          frustumCulled={false}
        >
          <meshStandardMaterial 
            color={PANEL_COLORS.FULL}
            roughness={0.4} 
            metalness={0.1}
            wireframe={wireframe}
            emissive={PANEL_COLORS.FULL}
            emissiveIntensity={0.15}
          />
        </instancedMesh>
      )}

      {/* CUT_SINGLE panels - LIGHT GREEN */}
      {panelsByType.CUT_SINGLE.length > 0 && (
        <instancedMesh 
          ref={cutSingleMeshRef} 
          args={[panelGeometry, undefined, panelsByType.CUT_SINGLE.length]} 
          frustumCulled={false}
        >
          <meshStandardMaterial 
            color={PANEL_COLORS.CUT_SINGLE}
            roughness={0.4} 
            metalness={0.1}
            wireframe={wireframe}
            emissive={PANEL_COLORS.CUT_SINGLE}
            emissiveIntensity={0.15}
          />
        </instancedMesh>
      )}

      {/* CUT_DOUBLE panels - ORANGE */}
      {panelsByType.CUT_DOUBLE.length > 0 && (
        <instancedMesh 
          ref={cutDoubleMeshRef} 
          args={[panelGeometry, undefined, panelsByType.CUT_DOUBLE.length]} 
          frustumCulled={false}
        >
          <meshStandardMaterial 
            color={PANEL_COLORS.CUT_DOUBLE}
            roughness={0.4} 
            metalness={0.1}
            wireframe={wireframe}
            emissive={PANEL_COLORS.CUT_DOUBLE}
            emissiveIntensity={0.15}
          />
        </instancedMesh>
      )}

      {/* CORNER_CUT panels - RED */}
      {panelsByType.CORNER_CUT.length > 0 && (
        <instancedMesh 
          ref={cornerMeshRef} 
          args={[panelGeometry, undefined, panelsByType.CORNER_CUT.length]} 
          frustumCulled={false}
        >
          <meshStandardMaterial 
            color={PANEL_COLORS.CORNER_CUT}
            roughness={0.4} 
            metalness={0.1}
            wireframe={wireframe}
            emissive={PANEL_COLORS.CORNER_CUT}
            emissiveIntensity={0.15}
          />
        </instancedMesh>
      )}

      {/* OUTLINE mesh - wireframe overlay for all panels (permanent, always visible by default) */}
      {/* Uses slightly larger geometry with wireframe material + polygonOffset for z-fighting prevention */}
      {showOutlines && allPanels.length > 0 && !wireframe && (
        <instancedMesh 
          ref={outlineMeshRef} 
          args={[outlineGeometry, undefined, allPanels.length]} 
          frustumCulled={false}
          renderOrder={1}
        >
          <meshBasicMaterial 
            color="#1a1a1a"
            wireframe={true}
            opacity={0.9}
            transparent
            polygonOffset={true}
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
            depthTest={true}
            depthWrite={false}
          />
        </instancedMesh>
      )}
    </>
  );
}

// Opening VOLUMES (red translucent voids) and TOPOS (dark green) visualization
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

  const { voidVolumes, jambTopos, lintelTopos, sillTopos } = useMemo(() => {
    const voidVolumes: { matrix: THREE.Matrix4 }[] = [];
    const jambTopos: THREE.Matrix4[] = [];
    const lintelTopos: THREE.Matrix4[] = [];
    const sillTopos: THREE.Matrix4[] = [];

    openings.forEach((opening) => {
      const chain = chains.find((c) => c.id === opening.chainId);
      if (!chain) return;

      const angle = Math.atan2(chain.endY - chain.startY, chain.endX - chain.startX);
      const dirX = (chain.endX - chain.startX) / chain.lengthMm;
      const dirY = (chain.endY - chain.startY) / chain.lengthMm;

      const { startRow, endRow } = getAffectedRows(opening.sillMm, opening.heightMm);
      const visibleEndRow = Math.min(endRow, settings.currentRow);
      
      if (visibleEndRow <= startRow) return;

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
      voidVolumes.push({ matrix: voidMatrix });

      // JAMB TOPOS
      for (let row = startRow; row < visibleEndRow; row++) {
        const rowCenterY = row * PANEL_HEIGHT + PANEL_HEIGHT / 2;

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

      // LINTEL TOPO
      if (visibleEndRow >= endRow) {
        const lintelY = endRow * PANEL_HEIGHT - PANEL_HEIGHT / 4;
        const lintelMatrix = new THREE.Matrix4();
        lintelMatrix.compose(
          new THREE.Vector3(centerX * SCALE, lintelY * SCALE, centerZ * SCALE),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
          new THREE.Vector3(opening.widthMm / PANEL_WIDTH, 0.5, 1)
        );
        lintelTopos.push(lintelMatrix);
      }

      // SILL TOPO (windows only)
      if (opening.sillMm > 0 && visibleEndRow > startRow) {
        const sillY = startRow * PANEL_HEIGHT + PANEL_HEIGHT / 4;
        const sillMatrix = new THREE.Matrix4();
        sillMatrix.compose(
          new THREE.Vector3(centerX * SCALE, sillY * SCALE, centerZ * SCALE),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
          new THREE.Vector3(opening.widthMm / PANEL_WIDTH, 0.5, 1)
        );
        sillTopos.push(sillMatrix);
      }
    });

    return { voidVolumes, jambTopos, lintelTopos, sillTopos };
  }, [chains, openings, settings.currentRow, tc]);

  useEffect(() => {
    if (!voidMeshRef.current || voidVolumes.length === 0) return;
    voidVolumes.forEach(({ matrix }, i) => {
      voidMeshRef.current!.setMatrixAt(i, matrix);
    });
    voidMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [voidVolumes]);

  useEffect(() => {
    if (!topoJambMeshRef.current || jambTopos.length === 0) return;
    jambTopos.forEach((matrix, i) => {
      topoJambMeshRef.current!.setMatrixAt(i, matrix);
    });
    topoJambMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [jambTopos]);

  useEffect(() => {
    if (!topoLintelMeshRef.current || lintelTopos.length === 0) return;
    lintelTopos.forEach((matrix, i) => {
      topoLintelMeshRef.current!.setMatrixAt(i, matrix);
    });
    topoLintelMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [lintelTopos]);

  useEffect(() => {
    if (!topoSillMeshRef.current || sillTopos.length === 0) return;
    sillTopos.forEach((matrix, i) => {
      topoSillMeshRef.current!.setMatrixAt(i, matrix);
    });
    topoSillMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [sillTopos]);

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
      {voidVolumes.length > 0 && settings.showOpenings && (
        <instancedMesh 
          ref={voidMeshRef} 
          args={[voidGeometry, undefined, voidVolumes.length]} 
          frustumCulled={false}
        >
          <meshStandardMaterial 
            color={PANEL_COLORS.OPENING_VOID} 
            opacity={0.4} 
            transparent 
            side={THREE.DoubleSide}
          />
        </instancedMesh>
      )}

      {jambTopos.length > 0 && settings.showTopos && (
        <instancedMesh 
          ref={topoJambMeshRef} 
          args={[topoJambGeometry, undefined, jambTopos.length]} 
          frustumCulled={false}
        >
          <meshStandardMaterial 
            color={PANEL_COLORS.TOPO} 
            roughness={0.4} 
            metalness={0.2}
            emissive={PANEL_COLORS.TOPO}
            emissiveIntensity={0.2}
          />
        </instancedMesh>
      )}

      {lintelTopos.length > 0 && settings.showTopos && (
        <instancedMesh 
          ref={topoLintelMeshRef} 
          args={[topoHorizGeometry, undefined, lintelTopos.length]} 
          frustumCulled={false}
        >
          <meshStandardMaterial 
            color={PANEL_COLORS.TOPO} 
            roughness={0.4} 
            metalness={0.2}
            emissive={PANEL_COLORS.TOPO}
            emissiveIntensity={0.2}
          />
        </instancedMesh>
      )}

      {sillTopos.length > 0 && settings.showTopos && (
        <instancedMesh 
          ref={topoSillMeshRef} 
          args={[topoHorizGeometry, undefined, sillTopos.length]} 
          frustumCulled={false}
        >
          <meshStandardMaterial 
            color={PANEL_COLORS.TOPO} 
            roughness={0.4} 
            metalness={0.2}
            emissive={PANEL_COLORS.TOPO}
            emissiveIntensity={0.2}
          />
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
    const visibleGridRows = gridRows.filter((row) => row < settings.currentRow);

    walls.forEach((wall) => {
      const length = calculateWallLength(wall);
      const angle = calculateWallAngle(wall);
      const numGridSegments = Math.ceil(length / 3000);

      visibleGridRows.forEach((row) => {
        for (let g = 0; g < numGridSegments; g++) {
          const segmentLength = Math.min(3000, length - g * 3000);
          const progress = (g * 3000 + segmentLength / 2) / length;
          const x = wall.startX + (wall.endX - wall.startX) * progress;
          const y = wall.startY + (wall.endY - wall.startY) * progress;
          const z = row * PANEL_HEIGHT + PANEL_HEIGHT * 0.9;

          const matrix = new THREE.Matrix4();
          matrix.compose(
            new THREE.Vector3(x * SCALE, z * SCALE, y * SCALE),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
            new THREE.Vector3(segmentLength / 3000, 1, 1)
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

  const gridGeometry = new THREE.BoxGeometry(3, 0.05, 0.15);

  return (
    <instancedMesh ref={meshRef} args={[gridGeometry, undefined, count]} frustumCulled={false}>
      <meshStandardMaterial color="#e53935" roughness={0.5} metalness={0.2} />
    </instancedMesh>
  );
}

// Camera controller that auto-fits to walls
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

// Opening CANDIDATES visualization (red translucent boxes at detected gap locations)
// ALWAYS visible when candidates exist and showOpenings is true
function CandidatesVisualization({ chains, settings, candidates = [] }: { chains: WallChain[]; settings: ViewerSettings; candidates: OpeningCandidate[] }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  
  const { volumes, count } = useMemo(() => {
    const volumes: THREE.Matrix4[] = [];
    
    // Filter only detected (not yet converted) candidates
    const activeCandidates = candidates.filter(c => c.status === 'detected');
    
    activeCandidates.forEach(candidate => {
      const chain = chains.find(c => c.id === candidate.chainId);
      if (!chain) return;
      
      const angle = Math.atan2(chain.endY - chain.startY, chain.endX - chain.startX);
      const dirX = (chain.endX - chain.startX) / chain.lengthMm;
      const dirY = (chain.endY - chain.startY) / chain.lengthMm;
      
      const centerOffset = candidate.startDistMm + candidate.widthMm / 2;
      const centerX = chain.startX + dirX * centerOffset;
      const centerZ = chain.startY + dirY * centerOffset;
      
      // Full wall height for candidate volume
      const heightMm = settings.maxRows * PANEL_HEIGHT;
      const centerY = heightMm / 2;
      
      const matrix = new THREE.Matrix4();
      matrix.compose(
        new THREE.Vector3(centerX * SCALE, centerY * SCALE, centerZ * SCALE),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
        new THREE.Vector3(
          candidate.widthMm / PANEL_WIDTH, 
          heightMm / PANEL_HEIGHT, 
          1
        )
      );
      volumes.push(matrix);
    });
    
    return { volumes, count: volumes.length };
  }, [chains, candidates, settings.maxRows]);
  
  useEffect(() => {
    if (!meshRef.current || count === 0) return;
    volumes.forEach((matrix, i) => {
      meshRef.current!.setMatrixAt(i, matrix);
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [volumes, count]);
  
  // ALWAYS show candidates if they exist
  if (count === 0) return null;
  
  const candidateGeometry = useMemo(() => 
    new THREE.BoxGeometry(PANEL_WIDTH * SCALE, PANEL_HEIGHT * SCALE, PANEL_THICKNESS * SCALE * 0.8), 
  []);
  
  return (
    <instancedMesh 
      ref={meshRef} 
      args={[candidateGeometry, undefined, count]} 
      frustumCulled={false}
    >
      <meshStandardMaterial 
        color={PANEL_COLORS.OPENING_VOID}
        opacity={0.35} 
        transparent 
        side={THREE.DoubleSide}
        depthWrite={false}
        emissive={PANEL_COLORS.OPENING_VOID}
        emissiveIntensity={0.4}
      />
    </instancedMesh>
  );
}

interface SceneProps {
  walls: WallSegment[];
  settings: ViewerSettings;
  openings?: OpeningData[];
  candidates?: OpeningCandidate[];
  onPanelCountChange?: (count: number) => void;
  onPanelCountsChange?: (counts: PanelCounts) => void;
  onGeometrySourceChange?: (source: 'glb' | 'step' | 'cache' | 'procedural' | 'simple') => void;
  onGeometryMetaChange?: (meta: {
    geometryBBoxM: { x: number; y: number; z: number };
    geometryScaleApplied: number;
    panelMeshVisible: boolean;
    panelMeshBBoxSizeM: { x: number; y: number; z: number };
    instancePosRangeM?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  }) => void;
  onLJunctionStatsChange?: (stats: { lJunctions: number; templatesApplied: number }) => void;
}

function Scene({ walls, settings, openings = [], candidates = [], onPanelCountChange, onPanelCountsChange, onGeometrySourceChange, onGeometryMetaChange, onLJunctionStatsChange }: SceneProps) {
  const controlsRef = useRef<any>(null);

  // Build chains once for the scene with candidate detection enabled
  const chainsResult = useMemo(
    () => buildWallChains(walls, { 
      snapTolMm: 5, 
      gapTolMm: 10, 
      angleTolDeg: 2, 
      noiseMinMm: 100, 
      detectCandidates: true 
    }),
    [walls]
  );
  const chains = chainsResult.chains;
  
  // Merge external candidates with auto-detected ones
  const allCandidates = useMemo(() => {
    const detected = chainsResult.candidates || [];
    // Filter out any candidates that have already been converted to openings
    const externalActive = candidates.filter(c => c.status === 'detected');
    // Combine, preferring external candidates if IDs match
    const combinedMap = new Map<string, OpeningCandidate>();
    detected.forEach(c => combinedMap.set(c.id, c));
    externalActive.forEach(c => combinedMap.set(c.id, c));
    return Array.from(combinedMap.values());
  }, [chainsResult.candidates, candidates]);

  const center = useMemo(() => {
    if (walls.length === 0) return new THREE.Vector3(0, 1, 0);
    const bbox = calculateWallsBoundingBox(walls, settings.maxRows);
    return bbox ? bbox.center : new THREE.Vector3(0, 1, 0);
  }, [walls, settings.maxRows]);

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

      {/* LIGHTING - Strong enough for colors to be ALWAYS visible */}
      <ambientLight intensity={1.2} />
      <directionalLight position={[10, 20, 10]} intensity={1.5} castShadow shadow-mapSize={[2048, 2048]} />
      <directionalLight position={[-10, 10, -10]} intensity={0.8} />
      <directionalLight position={[0, 15, -15]} intensity={0.5} />
      <hemisphereLight intensity={0.6} />

      {showSegmentsLayer && <DXFDebugLines walls={walls} />}
      {showLinesLayer && <ChainOverlay walls={walls} />}
      {settings.showHelpers && <DebugHelpers walls={walls} settings={settings} />}

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

      {/* ICF Panels - BATCH RENDER by type for permanent colors + OUTLINES */}
      {showPanelsLayer && (
        <BatchedPanelInstances 
          chains={chains}
          settings={settings} 
          openings={openings}
          showOutlines={settings.showOutlines}
          highFidelity={settings.highFidelityPanels}
          onInstanceCountChange={onPanelCountChange}
          onCountsChange={onPanelCountsChange}
          onGeometrySourceChange={onGeometrySourceChange}
          onGeometryMetaChange={onGeometryMetaChange}
          onLJunctionStatsChange={onLJunctionStatsChange}
        />
      )}

      {/* Openings and Topos visualization */}
      {openings.length > 0 && settings.showOpenings && (
        <OpeningsVisualization walls={walls} settings={settings} openings={openings} />
      )}
      
      {/* Opening CANDIDATES visualization (detected gaps - red translucent) */}
      {/* ALWAYS show if candidates exist - critical for user visibility */}
      {allCandidates.length > 0 && (
        <CandidatesVisualization chains={chains} settings={settings} candidates={allCandidates} />
      )}

      {settings.showWebs && <WebsInstances walls={walls} settings={settings} />}
      {settings.showGrids && <GridsInstances walls={walls} settings={settings} />}

      <Environment preset="city" />
    </>
  );
}

interface ICFViewer3DProps {
  walls: WallSegment[];
  settings: ViewerSettings;
  openings?: OpeningData[];
  candidates?: OpeningCandidate[];
  className?: string;
}

export function ICFViewer3D({ walls, settings, openings = [], candidates = [], className = '' }: ICFViewer3DProps) {
  const [panelInstancesCount, setPanelInstancesCount] = useState(0);
  const [panelCounts, setPanelCounts] = useState<PanelCounts>({
    FULL: 0, CUT_SINGLE: 0, CUT_DOUBLE: 0, CORNER_CUT: 0, TOPO: 0, OPENING_VOID: 0
  });
  const [geometrySource, setGeometrySource] = useState<'glb' | 'step' | 'cache' | 'procedural' | 'simple'>('simple');
  const [geometryBBoxM, setGeometryBBoxM] = useState<{ x: number; y: number; z: number } | undefined>(undefined);
  const [geometryScaleApplied, setGeometryScaleApplied] = useState<number | undefined>(undefined);
  const [panelMeshVisible, setPanelMeshVisible] = useState<boolean | undefined>(undefined);
  const [panelMeshBBoxSizeM, setPanelMeshBBoxSizeM] = useState<{ x: number; y: number; z: number } | undefined>(undefined);
  const [instancePosRangeM, setInstancePosRangeM] = useState<{ min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | undefined>(undefined);
  const [lJunctionStats, setLJunctionStats] = useState<{ lJunctions: number; templatesApplied: number } | undefined>(undefined);
  const [showLegend, setShowLegend] = useState(true);
  const bbox = useMemo(() => calculateWallsBoundingBox(walls, settings.maxRows), [walls, settings.maxRows]);

  const bboxInfo = useMemo(() => {
    if (!bbox) return null;
    return { widthM: bbox.size.x, heightM: bbox.size.z };
  }, [bbox]);

  const showPanelsMode = settings.viewMode === 'panels' || settings.viewMode === 'both';

  return (
    <div className={`viewer-container ${className} relative`}>
      <Canvas
        shadows
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.3 }}
        style={{ background: 'transparent' }}
      >
        <Scene 
          walls={walls} 
          settings={settings} 
          openings={openings}
          candidates={candidates}
          onPanelCountChange={setPanelInstancesCount}
          onPanelCountsChange={setPanelCounts}
          onGeometrySourceChange={setGeometrySource}
          onGeometryMetaChange={({ geometryBBoxM, geometryScaleApplied, panelMeshVisible, panelMeshBBoxSizeM, instancePosRangeM }) => {
            setGeometryBBoxM(geometryBBoxM);
            setGeometryScaleApplied(geometryScaleApplied);
            setPanelMeshVisible(panelMeshVisible);
            setPanelMeshBBoxSizeM(panelMeshBBoxSizeM);
            setInstancePosRangeM(instancePosRangeM);
          }}
          onLJunctionStatsChange={setLJunctionStats}
        />
      </Canvas>

      {showPanelsMode && panelInstancesCount > 0 && (
        <PanelLegend 
          visible={showLegend}
          onToggle={() => setShowLegend(!showLegend)}
          showOpenings={settings.showOpenings && (openings.length > 0 || candidates.length > 0)}
          showTopos={settings.showTopos && openings.length > 0}
          counts={panelCounts}
        />
      )}

      <DiagnosticsHUD 
        walls={walls} 
        settings={settings} 
        openings={openings}
        candidates={candidates}
        panelInstancesCount={panelInstancesCount}
        geometrySource={geometrySource}
        geometryBBoxM={geometryBBoxM}
        geometryScaleApplied={geometryScaleApplied}
        panelMeshVisible={panelMeshVisible}
        panelMeshBBoxSizeM={panelMeshBBoxSizeM}
        instancePosRangeM={instancePosRangeM}
        lJunctionStats={lJunctionStats}
        panelCountsByType={panelCounts}
      />

      {bboxInfo && settings.showHelpers && (
        <div className="absolute top-4 left-4 z-10 rounded-md bg-background/80 backdrop-blur px-3 py-2 text-xs font-mono text-foreground border border-border">
          <div>bbox: {bboxInfo.widthM.toFixed(2)}m × {bboxInfo.heightM.toFixed(2)}m</div>
          <div>paredes: {walls.length}</div>
        </div>
      )}

      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-background/50 to-transparent" />
      </div>
    </div>
  );
}
