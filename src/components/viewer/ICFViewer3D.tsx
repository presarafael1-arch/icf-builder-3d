import { useRef, useMemo, useEffect, useState, useCallback } from 'react';
import { Canvas, useThree, ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Grid, Environment, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { PANEL_WIDTH, PANEL_HEIGHT, PANEL_THICKNESS, WallSegment, ViewerSettings, TOOTH, ConcreteThickness } from '@/types/icf';
import { OpeningData, OpeningCandidate, getAffectedRows } from '@/types/openings';
import { calculateWallAngle, calculateWallLength, calculateGridRows, calculateWebsPerRow } from '@/lib/icf-calculations';
import { buildWallChains, buildWallChainsAutoTuned, WallChain } from '@/lib/wall-chains';
import { getRemainingIntervalsForRow } from '@/lib/openings-calculations';
import { 
  generatePanelLayout, 
  PanelType, 
  ClassifiedPanel, 
  TopoPlacement,
  detectLJunctions,
  detectTJunctions 
} from '@/lib/panel-layout';
import { DiagnosticsHUD } from './DiagnosticsHUD';
import { PanelLegend } from './PanelLegend';
import { DebugVisualizations } from './DebugVisualizations';
import { SideStripeOverlays } from './SideStripeOverlays';
import { usePanelGeometry } from '@/hooks/usePanelGeometry';
import { CoreConcreteMm, ExtendedPanelData, PanelOverride } from '@/types/panel-selection';

// Panel counts by type for legend
export interface PanelCounts {
  FULL: number;
  CUT_SINGLE: number;
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
// EXT panels are rendered with a BLUE tint, INT panels with a PURPLE tint
// =============================================
export const PANEL_COLORS: Record<PanelType | 'OPENING_VOID', string> = {
  FULL: '#E6D44A',        // YELLOW - full panel (1200mm)
  CUT_SINGLE: '#6FD36F',  // LIGHT GREEN - cut on ONE side only
  CORNER_CUT: '#C83A3A',  // RED - corner/adjustment cut (one side only)
  TOPO: '#0F6B3E',        // DARK GREEN - topos
  END_CUT: '#F2992E',     // ORANGE - end termination cuts
  OPENING_VOID: '#FF4444', // RED translucent - opening voids and candidates
};

// Side-specific color modifiers
export const SIDE_COLORS = {
  exterior: '#3B82F6',  // BLUE tint for exterior panels
  interior: '#A855F7',  // PURPLE tint for interior panels
};

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
  const chainsResult = useMemo(() => buildWallChainsAutoTuned(walls), [walls]);
  
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

// Footprint polygon visualization (green lines outlining detected outer polygon)
// Uses depthTest=false and high renderOrder to always be visible
function FootprintVisualization({ walls }: { walls: WallSegment[] }) {
  const chainsResult = useMemo(() => buildWallChainsAutoTuned(walls), [walls]);
  
  const geometry = useMemo(() => {
    const footprint = chainsResult.footprint;
    if (!footprint || !footprint.outerPolygon || footprint.outerPolygon.length < 3) return null;
    
    const polygon = footprint.outerPolygon;
    // Create closed loop: each segment connects consecutive vertices, plus last-to-first
    const positions = new Float32Array(polygon.length * 2 * 3);
    
    for (let i = 0; i < polygon.length; i++) {
      const p1 = polygon[i];
      const p2 = polygon[(i + 1) % polygon.length];
      
      // Raise Y by 2mm to be visible above ground
      const yOffset = 0.005;
      positions[i * 6 + 0] = p1.x * SCALE;
      positions[i * 6 + 1] = yOffset;
      positions[i * 6 + 2] = p1.y * SCALE;
      positions[i * 6 + 3] = p2.x * SCALE;
      positions[i * 6 + 4] = yOffset;
      positions[i * 6 + 5] = p2.y * SCALE;
    }
    
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.computeBoundingSphere();
    return g;
  }, [chainsResult]);
  
  if (!geometry) return null;
  
  return (
    <lineSegments geometry={geometry} frustumCulled={false} renderOrder={100}>
      <lineBasicMaterial 
        color={'#22c55e'} 
        linewidth={3} 
        opacity={1} 
        transparent={false}
        depthTest={false}
        depthWrite={false}
      />
    </lineSegments>
  );
}

// Highlight UNRESOLVED panels with a magenta glow overlay
interface UnresolvedHighlightsProps {
  allPanels: ClassifiedPanel[];
  concreteThickness: ConcreteThickness;
  visible?: boolean;
}

function UnresolvedHighlights({ allPanels, concreteThickness, visible = true }: UnresolvedHighlightsProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  
  // Filter only UNRESOLVED panels
  const unresolvedPanels = useMemo(() => 
    allPanels.filter(p => p.chainClassification === 'UNRESOLVED'),
  [allPanels]);
  
  // Create matrices with slight scale-up for glow effect
  const matrices = useMemo(() => {
    return unresolvedPanels.map(panel => {
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      panel.matrix.decompose(pos, quat, scale);
      // Scale up slightly for highlight visibility
      scale.multiplyScalar(1.02);
      const matrix = new THREE.Matrix4();
      matrix.compose(pos, quat, scale);
      return matrix;
    });
  }, [unresolvedPanels]);
  
  useEffect(() => {
    if (!meshRef.current || matrices.length === 0) return;
    matrices.forEach((matrix, i) => {
      meshRef.current!.setMatrixAt(i, matrix);
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [matrices]);
  
  if (!visible || unresolvedPanels.length === 0) return null;
  
  const glowGeometry = useMemo(() => 
    new THREE.BoxGeometry(PANEL_WIDTH * SCALE, PANEL_HEIGHT * SCALE, PANEL_THICKNESS * SCALE),
  []);
  
  return (
    <instancedMesh 
      ref={meshRef} 
      args={[glowGeometry, undefined, unresolvedPanels.length]} 
      frustumCulled={false}
      raycast={() => null} // Non-interactive
    >
      <meshStandardMaterial 
        color="#FF00FF"
        opacity={0.5} 
        transparent 
        side={THREE.DoubleSide}
        depthWrite={false}
        emissive="#FF00FF"
        emissiveIntensity={0.8}
      />
    </instancedMesh>
  );
}

// Footprint stats overlay component (HTML overlay)
interface FootprintStatsOverlayProps {
  walls: WallSegment[];
}

function FootprintStatsOverlay({ walls }: FootprintStatsOverlayProps) {
  const chainsResult = useMemo(() => buildWallChainsAutoTuned(walls), [walls]);
  
  const footprint = chainsResult.footprint;
  if (!footprint) return null;
  
  const areaM2 = footprint.outerAreaMm2 / 1e6;
  const { exteriorChains, interiorPartitions, unresolved } = footprint.stats;
  const total = exteriorChains + interiorPartitions + unresolved;
  const hasUnresolved = unresolved > 0;
  const unresolvedIds = footprint.unresolvedChainIds || [];
  
  return (
    <div className="absolute top-16 left-4 z-20 bg-background/90 backdrop-blur-sm border border-border rounded-lg p-3 text-xs space-y-2 shadow-lg max-w-xs">
      <div className="font-medium text-foreground border-b border-border pb-1 flex items-center gap-2">
        <span className="inline-block w-3 h-3 rounded-full bg-green-500"></span>
        Footprint Detection Stats
      </div>
      
      <div className="space-y-1 text-muted-foreground">
        <div className="flex justify-between">
          <span>Loops encontrados:</span>
          <span className="font-mono text-foreground">{chainsResult.footprint?.stats.exteriorChains ? 1 : 0}</span>
        </div>
        <div className="flex justify-between">
          <span>Área footprint:</span>
          <span className="font-mono text-foreground">{areaM2.toFixed(2)} m²</span>
        </div>
      </div>
      
      <div className="border-t border-border pt-2 space-y-1">
        <div className="font-medium text-foreground mb-1">Classificação Chains:</div>
        <div className="flex justify-between">
          <span className="text-blue-400">⬤ Perímetro (EXT/INT):</span>
          <span className="font-mono">{exteriorChains}/{total}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-purple-400">⬤ Partições (INT/INT):</span>
          <span className="font-mono">{interiorPartitions}/{total}</span>
        </div>
        <div className={`flex justify-between ${hasUnresolved ? 'text-orange-400' : 'text-muted-foreground'}`}>
          <span>{hasUnresolved ? '⚠' : '⬤'} Não resolvidas:</span>
          <span className="font-mono">{unresolved}/{total}</span>
        </div>
      </div>
      
      {hasUnresolved && (
        <div className="border-t border-border pt-2 space-y-1">
          <div className="text-orange-400 text-[11px] font-medium">Chains não resolvidas:</div>
          <div className="flex flex-wrap gap-1">
            {unresolvedIds.map(id => (
              <span key={id} className="bg-orange-500/20 text-orange-300 px-1.5 py-0.5 rounded text-[10px] font-mono">
                {id}
              </span>
            ))}
          </div>
          <div className="text-orange-400/70 text-[10px] mt-1">
            Desligar "Não resolvidas" na Visibilidade para localizar.
          </div>
        </div>
      )}
    </div>
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

// =============================================
// BATCH RENDER: One InstancedMesh per panel type + OUTLINE mesh + TOPO mesh
// This ensures colors are ALWAYS visible
// =============================================
function BatchedPanelInstances({ 
  chains, 
  settings, 
  openings = [],
  showOutlines = true,
  highFidelity = false,
  selectedPanelId,
  panelOverrides,
  previewColor,
  onPanelClick,
  onInstanceCountChange,
  onCountsChange,
  onGeometrySourceChange,
  onGeometryMetaChange,
  onLayoutStatsChange,
  onPanelDataReady,
  flippedChains = new Set(),
}: {
  chains: WallChain[];
  settings: ViewerSettings; 
  openings: OpeningData[];
  showOutlines?: boolean;
  highFidelity?: boolean;
  selectedPanelId?: string | null;
  panelOverrides?: Map<string, PanelOverride>;
  previewColor?: string | null;
  onPanelClick?: (meshType: string, instanceId: number, panelId: string) => void;
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
  onLayoutStatsChange?: (stats: { lJunctions: number; tJunctions: number; xJunctions?: number; freeEnds?: number; templatesApplied: number; toposPlaced: number; effectiveOffset?: number }) => void;
  onPanelDataReady?: (panelsByType: Record<PanelType, ClassifiedPanel[]>, allPanels: ClassifiedPanel[], allTopos: TopoPlacement[]) => void;
  flippedChains?: Set<string>;
}) {
  // Selection mesh ref for highlight
  const selectionMeshRef = useRef<THREE.InstancedMesh>(null);
  // Refs for each panel type mesh
  const fullMeshRef = useRef<THREE.InstancedMesh>(null);
  const cutSingleMeshRef = useRef<THREE.InstancedMesh>(null);
  const cutDoubleMeshRef = useRef<THREE.InstancedMesh>(null);
  const cornerMeshRef = useRef<THREE.InstancedMesh>(null);
  
  // OUTLINE mesh ref - second InstancedMesh for permanent outlines
  const outlineMeshRef = useRef<THREE.InstancedMesh>(null);
  
  // TOPO mesh ref for T-junction topos
  const topoMeshRef = useRef<THREE.InstancedMesh>(null);

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

  // Concrete thickness for topo sizing
  const tc = parseInt(settings.concreteThickness) || 150;

  // Generate panel layout with L-corner and T-junction awareness
  const { panelsByType, allPanels, allTopos, layoutStats } = useMemo(() => {
    if (chains.length === 0) {
      console.log('[BatchedPanelInstances] No chains, skipping panel generation');
      return { 
        panelsByType: { FULL: [], CUT_SINGLE: [], CUT_DOUBLE: [], CORNER_CUT: [], TOPO: [], END_CUT: [] },
        allPanels: [] as ClassifiedPanel[],
        allTopos: [] as TopoPlacement[],
        layoutStats: { lJunctions: 0, tJunctions: 0, xJunctions: 0, freeEnds: 0, cornerTemplatesApplied: 0, toposPlaced: 0, effectiveOffset: 600 }
      };
    }

    const visibleRows = Math.min(settings.currentRow, settings.maxRows);
    
    // Create interval getter that respects openings
    const getIntervalsForRow = (chain: WallChain, row: number) => {
      return getRemainingIntervalsForRow(chain, openings, row);
    };

    console.log('[BatchedPanelInstances] flippedChains', { size: flippedChains?.size ?? 0, ids: Array.from(flippedChains ?? []).slice(0, 10) });

    const result = generatePanelLayout(chains, visibleRows, settings.maxRows, getIntervalsForRow, settings.concreteThickness, flippedChains);

    console.log('[BatchedPanelInstances] Generated panels:', {
      FULL: result.panelsByType.FULL.length,
      CUT_SINGLE: result.panelsByType.CUT_SINGLE.length,
      CORNER_CUT: result.panelsByType.CORNER_CUT.length,
      total: result.allPanels.length,
      topos: result.allTopos.length,
      stats: result.stats,
    });
    
    // Helper function to apply override to a panel's matrix
    const applyOverrideToPanel = (panel: ClassifiedPanel): ClassifiedPanel => {
      if (!panelOverrides || !panel.panelId) return panel;
      
      const override = panelOverrides.get(panel.panelId);
      if (!override) return panel;
      
      // Check if we have any geometry overrides to apply
      const hasOffsetOverride = override.offsetMm !== undefined && override.offsetMm !== 0;
      const hasWidthOverride = override.widthMm !== undefined && override.widthMm !== panel.widthMm;
      
      if (!hasOffsetOverride && !hasWidthOverride) return panel;
      
      // Decompose the current matrix
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      panel.matrix.decompose(pos, quat, scale);
      
      // Get the panel's chain to calculate direction
      const chain = chains.find(c => c.id === panel.chainId);
      if (!chain) return panel;
      
      const dirX = (chain.endX - chain.startX) / chain.lengthMm;
      const dirZ = (chain.endY - chain.startY) / chain.lengthMm;
      
      // Apply offset override (move along wall direction)
      if (hasOffsetOverride && override.offsetMm !== undefined) {
        const offsetMm = override.offsetMm;
        pos.x += dirX * offsetMm * SCALE;
        pos.z += dirZ * offsetMm * SCALE;
      }
      
      // Apply width override (change scale)
      if (hasWidthOverride && override.widthMm !== undefined) {
        const originalWidth = panel.widthMm;
        const newWidth = override.widthMm;
        scale.x = newWidth / PANEL_WIDTH;
        
        // Also adjust position if width changed (keep panel anchored at start)
        const widthDiff = newWidth - originalWidth;
        pos.x += dirX * (widthDiff / 2) * SCALE;
        pos.z += dirZ * (widthDiff / 2) * SCALE;
      }
      
      // Recompose the matrix
      const newMatrix = new THREE.Matrix4();
      newMatrix.compose(pos, quat, scale);
      
      console.log(`[OVERRIDE-APPLIED] Panel ${panel.panelId.slice(0, 16)}... offset=${override.offsetMm ?? 0}mm, width=${override.widthMm ?? panel.widthMm}mm`);
      
      return {
        ...panel,
        matrix: newMatrix,
        widthMm: override.widthMm ?? panel.widthMm,
      };
    };
    
    // Apply overrides to all panels (including type override)
    const applyOverrideWithType = (panel: ClassifiedPanel): ClassifiedPanel => {
      const processed = applyOverrideToPanel(panel);
      
      // Check for type override
      if (panelOverrides && panel.panelId) {
        const override = panelOverrides.get(panel.panelId);
        if (override?.overrideType) {
          console.log(`[OVERRIDE-TYPE] Panel ${panel.panelId.slice(0, 16)}... type changed from ${panel.type} to ${override.overrideType}`);
          return {
            ...processed,
            type: override.overrideType,
          };
        }
      }
      return processed;
    };
    
    const processedPanels = result.allPanels.map(applyOverrideWithType);
    
    // Filter panels by chain classification and side visibility settings
    const filteredPanels = processedPanels.filter(panel => {
      const panelId = panel.panelId || '';
      const isExterior = panelId.includes(':ext:');
      const isInterior = panelId.includes(':int:');
      const classification = panel.chainClassification || 'UNRESOLVED';
      
      // Filter by chain classification
      if (classification === 'PARTITION' && !settings.showPartitionPanels) return false;
      if (classification === 'UNRESOLVED' && !settings.showUnknownPanels) return false;
      
      // Filter by side (for PERIMETER chains)
      if (classification === 'PERIMETER') {
        if (isExterior && !settings.showExteriorPanels) return false;
        if (isInterior && !settings.showInteriorPanels) return false;
      }
      
      return true;
    });
    
    // Helper function to filter by visibility and apply overrides with type
    const filterBySide = (panels: ClassifiedPanel[]) => panels.map(applyOverrideWithType).filter(p => {
      const pid = p.panelId || '';
      const isExt = pid.includes(':ext:');
      const isInt = pid.includes(':int:');
      const classification = p.chainClassification || 'UNRESOLVED';
      
      if (classification === 'PARTITION' && !settings.showPartitionPanels) return false;
      if (classification === 'UNRESOLVED' && !settings.showUnknownPanels) return false;
      if (classification === 'PERIMETER') {
        if (isExt && !settings.showExteriorPanels) return false;
        if (isInt && !settings.showInteriorPanels) return false;
      }
      return true;
    });
    
    // Combine all panels and regroup by their EFFECTIVE type (after override)
    const allProcessedPanels = filterBySide(result.allPanels);
    
    // Regroup panels by their effective type (respecting overrides)
    const regroupedByType: Record<PanelType, ClassifiedPanel[]> = {
      FULL: [],
      CUT_SINGLE: [],
      CORNER_CUT: [],
      TOPO: [],
      END_CUT: [],
    };
    
    allProcessedPanels.forEach(panel => {
      const effectiveType = panel.type; // Already has overrideType applied
      if (regroupedByType[effectiveType]) {
        regroupedByType[effectiveType].push(panel);
      } else {
        // Fallback for unknown types
        regroupedByType.FULL.push(panel);
      }
    });
    
    const filteredPanelsByType = regroupedByType;
    
    // Separate panels by side for different coloring
    const exteriorPanels = filteredPanels.filter(p => p.side === 'exterior');
    const interiorPanels = filteredPanels.filter(p => p.side === 'interior');
    
    return {
      panelsByType: filteredPanelsByType,
      allPanels: filteredPanels,
      exteriorPanels,
      interiorPanels,
      allTopos: result.allTopos,
      layoutStats: result.stats,
    };
  }, [chains, openings, settings.currentRow, settings.maxRows, settings.concreteThickness, settings.showExteriorPanels, settings.showInteriorPanels, panelOverrides, flippedChains]);

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
    CORNER_CUT: panelsByType.CORNER_CUT.length,
    TOPO: allTopos.length,
    OPENING_VOID: 0,
  };

  // Build lookup table for instanceId -> panelId mapping
  const lookupTables = useMemo(() => {
    const fullLookup = new Map<number, string>();
    const cutSingleLookup = new Map<number, string>();
    const cornerLookup = new Map<number, string>();
    const allPanelLookup = new Map<number, string>();

    panelsByType.FULL.forEach((panel, idx) => {
      if (panel.panelId) {
        fullLookup.set(idx, panel.panelId);
      }
    });
    panelsByType.CUT_SINGLE.forEach((panel, idx) => {
      if (panel.panelId) {
        cutSingleLookup.set(idx, panel.panelId);
      }
    });
    panelsByType.CORNER_CUT.forEach((panel, idx) => {
      if (panel.panelId) {
        cornerLookup.set(idx, panel.panelId);
      }
    });

    // All panels lookup (for outline/selection mesh)
    allPanels.forEach((panel, idx) => {
      if (panel.panelId) {
        allPanelLookup.set(idx, panel.panelId);
      }
    });

    return { fullLookup, cutSingleLookup, cornerLookup, allPanelLookup };
  }, [panelsByType, allPanels]);

  // Handle click on panel mesh
  const handlePanelClick = useCallback((meshType: string, e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const instanceId = e.instanceId;
    if (instanceId === undefined) return;

    let panelId: string | undefined;
    switch (meshType) {
      case 'FULL':
        panelId = lookupTables.fullLookup.get(instanceId);
        break;
      case 'CUT_SINGLE':
        panelId = lookupTables.cutSingleLookup.get(instanceId);
        break;
      case 'CORNER_CUT':
        panelId = lookupTables.cornerLookup.get(instanceId);
        break;
    }

    if (panelId) {
      onPanelClick?.(meshType, instanceId, panelId);
    }
  }, [lookupTables, onPanelClick]);

  // Report counts and layout stats to parent
  useEffect(() => {
    onInstanceCountChange?.(totalCount);
    onCountsChange?.(counts);
    onLayoutStatsChange?.({
      lJunctions: layoutStats.lJunctions,
      tJunctions: layoutStats.tJunctions,
      xJunctions: 'xJunctions' in layoutStats ? layoutStats.xJunctions : 0,
      freeEnds: 'freeEnds' in layoutStats ? layoutStats.freeEnds : 0,
      templatesApplied: layoutStats.cornerTemplatesApplied,
      toposPlaced: layoutStats.toposPlaced,
      effectiveOffset: 'effectiveOffset' in layoutStats ? layoutStats.effectiveOffset : 600,
    });
  }, [totalCount, counts.FULL, counts.CUT_SINGLE, counts.CORNER_CUT, counts.TOPO, layoutStats]);

  // Notify parent about panel data
  useEffect(() => {
    onPanelDataReady?.(panelsByType, allPanels, allTopos);
  }, [panelsByType, allPanels, allTopos, onPanelDataReady]);

  // Update selection highlight mesh - MUST match exact panel size
  useEffect(() => {
    if (!selectionMeshRef.current || !selectedPanelId) return;
    
    // Find the selected panel in allPanels
    const selectedIdx = allPanels.findIndex(p => p.panelId === selectedPanelId);
    if (selectedIdx >= 0) {
      const panel = allPanels[selectedIdx];
      // Use EXACT same matrix as panel - no scaling for accurate visual match
      // Just copy the matrix directly so selection matches panel exactly
      selectionMeshRef.current.setMatrixAt(0, panel.matrix);
      selectionMeshRef.current.instanceMatrix.needsUpdate = true;
      selectionMeshRef.current.visible = true;
    } else {
      selectionMeshRef.current.visible = false;
    }
  }, [selectedPanelId, allPanels]);

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

  // Update CORNER_CUT panels mesh
  useEffect(() => {
    if (!cornerMeshRef.current || panelsByType.CORNER_CUT.length === 0) return;
    panelsByType.CORNER_CUT.forEach((panel, i) => {
      cornerMeshRef.current!.setMatrixAt(i, panel.matrix);
    });
    cornerMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [panelsByType.CORNER_CUT, panelGeometry]);

  // Update OUTLINE mesh (all panels get outlines)
  // Re-run when showOutlines changes so meshes get repopulated after remount
  useEffect(() => {
    if (!outlineMeshRef.current || allPanels.length === 0 || !showOutlines) return;
    allPanels.forEach((panel, i) => {
      // Clone matrix and apply slight scale-up for outline visibility
      const outlineMatrix = panel.matrix.clone();
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      outlineMatrix.decompose(pos, quat, scale);
      // Scale up slightly for outline offset
      scale.multiplyScalar(1.002);
      outlineMatrix.compose(pos, quat, scale);
      outlineMeshRef.current!.setMatrixAt(i, outlineMatrix);
    });
    outlineMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [allPanels, outlineGeometry, showOutlines]);

  // Update TOPO mesh (T-junction topos)
  useEffect(() => {
    if (!topoMeshRef.current || allTopos.length === 0) return;
    allTopos.forEach((topo, i) => {
      topoMeshRef.current!.setMatrixAt(i, topo.matrix);
    });
    topoMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [allTopos]);

  const wireframe = settings.wireframe;

  // Topo geometry - unit box, scale comes from each instance's matrix
  // The matrix contains: scaleX = topoWidth, scaleY = panelHeight, scaleZ = wallThickness
  const topoGeometry = useMemo(() => {
    return new THREE.BoxGeometry(1, 1, 1); // Unit box - scale applied via matrix
  }, []);

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
          onClick={(e) => handlePanelClick('FULL', e)}
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
          onClick={(e) => handlePanelClick('CUT_SINGLE', e)}
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

      {/* CORNER_CUT panels - RED with optional highlight effect */}
      {panelsByType.CORNER_CUT.length > 0 && (
        <instancedMesh 
          ref={cornerMeshRef} 
          args={[panelGeometry, undefined, panelsByType.CORNER_CUT.length]} 
          frustumCulled={false}
          onClick={(e) => handlePanelClick('CORNER_CUT', e)}
        >
          <meshStandardMaterial 
            color={settings.highlightCornerCuts ? '#FF0000' : PANEL_COLORS.CORNER_CUT}
            roughness={settings.highlightCornerCuts ? 0.2 : 0.4} 
            metalness={settings.highlightCornerCuts ? 0.4 : 0.1}
            wireframe={wireframe}
            emissive={settings.highlightCornerCuts ? '#FF4444' : PANEL_COLORS.CORNER_CUT}
            emissiveIntensity={settings.highlightCornerCuts ? 0.6 : 0.15}
            transparent={settings.highlightCornerCuts}
            opacity={settings.highlightCornerCuts ? 0.9 : 1}
          />
        </instancedMesh>
      )}

      {/* SELECTION HIGHLIGHT mesh - shows selected panel with emissive glow */}
      {/* Uses previewColor when hovering over classification buttons, otherwise default cyan */}
      {selectedPanelId && (
        <instancedMesh 
          ref={selectionMeshRef} 
          args={[panelGeometry, undefined, 1]} 
          frustumCulled={false}
          renderOrder={15}
        >
          <meshStandardMaterial 
            color={previewColor || "#00FFFF"}
            roughness={0.2} 
            metalness={0.5}
            emissive={previewColor || "#00FFFF"}
            emissiveIntensity={previewColor ? 1.0 : 0.8}
            transparent
            opacity={previewColor ? 0.85 : 0.6}
            depthTest={true}
            depthWrite={false}
          />
        </instancedMesh>
      )}

      {/* OUTLINE mesh - PERMANENT wireframe overlay for all panels */}
      {/* Uses slightly larger geometry with wireframe material + polygonOffset for z-fighting prevention */}
      {showOutlines && allPanels.length > 0 && !wireframe && (
        <instancedMesh 
          ref={outlineMeshRef} 
          args={[outlineGeometry, undefined, allPanels.length]} 
          frustumCulled={false}
          renderOrder={10}
        >
          <meshBasicMaterial 
            color="#0B0F14"
            wireframe={true}
            opacity={0.65}
            transparent
            polygonOffset={true}
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
            depthTest={true}
            depthWrite={false}
          />
        </instancedMesh>
      )}

      {/* TOPO mesh - Dark green blocks at T-junctions */}
      {settings.showTopos && allTopos.length > 0 && (
        <instancedMesh 
          ref={topoMeshRef} 
          args={[topoGeometry, undefined, allTopos.length]} 
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

      {/* EXT/INT side stripe overlays - Blue (exterior) and White (interior) */}
      <SideStripeOverlays 
        allPanels={allPanels} 
        concreteThickness={settings.concreteThickness}
        visible={settings.showSideStripes}
      />

      {/* Highlight UNRESOLVED panels when toggle is on (magenta glow overlay) */}
      <UnresolvedHighlights 
        allPanels={allPanels} 
        concreteThickness={settings.concreteThickness}
        visible={settings.highlightUnresolved}
      />
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

// WASD keyboard controls for camera panning
function WASDControls() {
  const { camera, controls } = useThree();
  const keysPressed = useRef<Set<string>>(new Set());
  const PAN_SPEED = 0.15; // meters per frame
  
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      const key = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'q', 'e'].includes(key)) {
        keysPressed.current.add(key);
      }
    };
    
    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      keysPressed.current.delete(key);
    };
    
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);
  
  // Animation loop for smooth movement
  useEffect(() => {
    let animationId: number;
    
    const animate = () => {
      if (keysPressed.current.size > 0 && controls) {
        const orbitControls = controls as any;
        const target = orbitControls.target as THREE.Vector3;
        
        // Get camera's horizontal forward direction (ignoring Y)
        const cameraDir = new THREE.Vector3();
        camera.getWorldDirection(cameraDir);
        cameraDir.y = 0;
        cameraDir.normalize();
        
        // Get right direction
        const rightDir = new THREE.Vector3();
        rightDir.crossVectors(cameraDir, new THREE.Vector3(0, 1, 0)).normalize();
        
        // Calculate movement delta
        const delta = new THREE.Vector3();
        
        if (keysPressed.current.has('w')) {
          delta.add(cameraDir.clone().multiplyScalar(PAN_SPEED));
        }
        if (keysPressed.current.has('s')) {
          delta.add(cameraDir.clone().multiplyScalar(-PAN_SPEED));
        }
        if (keysPressed.current.has('a')) {
          delta.add(rightDir.clone().multiplyScalar(-PAN_SPEED));
        }
        if (keysPressed.current.has('d')) {
          delta.add(rightDir.clone().multiplyScalar(PAN_SPEED));
        }
        // Q/E for vertical movement
        if (keysPressed.current.has('q')) {
          delta.y -= PAN_SPEED;
        }
        if (keysPressed.current.has('e')) {
          delta.y += PAN_SPEED;
        }
        
        // Move both camera and target
        camera.position.add(delta);
        target.add(delta);
        orbitControls.update();
      }
      
      animationId = requestAnimationFrame(animate);
    };
    
    animate();
    
    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [camera, controls]);
  
  return null;
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
  selectedPanelId?: string | null;
  panelOverrides?: Map<string, PanelOverride>;
  previewColor?: string | null; // Color to preview on selected panel (hex)
  onPanelClick?: (meshType: string, instanceId: number, panelId: string) => void;
  onPanelDataReady?: (panelsByType: Record<PanelType, ClassifiedPanel[]>, allPanels: ClassifiedPanel[], allTopos: TopoPlacement[]) => void;
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
  onLayoutStatsChange?: (stats: { lJunctions: number; tJunctions: number; xJunctions?: number; freeEnds?: number; templatesApplied: number; toposPlaced: number; effectiveOffset?: number }) => void;
  // Corner node selection and offsets
  selectedCornerNode?: string | null;
  onSelectCornerNode?: (nodeId: string | null) => void;
  cornerNodeOffsets?: Map<string, { nodeId: string; offsetX: number; offsetY: number }>;
  // Chain overrides (side flip)
  flippedChains?: Set<string>;
}

function Scene({ 
  walls, 
  settings, 
  openings = [], 
  candidates = [], 
  selectedPanelId,
  panelOverrides,
  previewColor,
  onPanelClick,
  onPanelDataReady,
  onPanelCountChange, 
  onPanelCountsChange, 
  onGeometrySourceChange, 
  onGeometryMetaChange, 
  onLayoutStatsChange,
  selectedCornerNode,
  onSelectCornerNode,
  cornerNodeOffsets,
  flippedChains = new Set(),
}: SceneProps) {
  const controlsRef = useRef<any>(null);

  // Build chains once for the scene (auto-tuned presets) with candidate detection enabled
  const chainsResult = useMemo(() => buildWallChainsAutoTuned(walls), [walls]);
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
      <WASDControls />
      <CameraController walls={walls} settings={settings} />

      {/* LIGHTING - Strong enough for colors to be ALWAYS visible */}
      <ambientLight intensity={1.2} />
      <directionalLight position={[10, 20, 10]} intensity={1.5} castShadow shadow-mapSize={[2048, 2048]} />
      <directionalLight position={[-10, 10, -10]} intensity={0.8} />
      <directionalLight position={[0, 15, -15]} intensity={0.5} />
      <hemisphereLight intensity={0.6} />

      {showSegmentsLayer && <DXFDebugLines walls={walls} />}
      {showLinesLayer && <ChainOverlay walls={walls} />}
      {settings.showFootprint && <FootprintVisualization walls={walls} />}
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

      {/* ICF Panels - BATCH RENDER by type for permanent colors + OUTLINES + TOPOS */}
      {showPanelsLayer && (
        <BatchedPanelInstances 
          chains={chains}
          settings={settings} 
          openings={openings}
          showOutlines={settings.showOutlines}
          highFidelity={settings.highFidelityPanels}
          selectedPanelId={selectedPanelId}
          panelOverrides={panelOverrides}
          previewColor={previewColor}
          onPanelClick={onPanelClick}
          onInstanceCountChange={onPanelCountChange}
          onCountsChange={onPanelCountsChange}
          onGeometrySourceChange={onGeometrySourceChange}
          onGeometryMetaChange={onGeometryMetaChange}
          onLayoutStatsChange={onLayoutStatsChange}
          onPanelDataReady={onPanelDataReady}
          flippedChains={flippedChains}
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

      {/* Debug Visualizations */}
      <DebugVisualizations 
        chainsResult={chainsResult} 
        settings={settings} 
        selectedCornerNode={selectedCornerNode}
        onSelectCornerNode={onSelectCornerNode}
        cornerNodeOffsets={cornerNodeOffsets}
        flippedChains={flippedChains}
      />

      <Environment preset="city" />
    </>
  );
}

interface ICFViewer3DProps {
  walls: WallSegment[];
  settings: ViewerSettings;
  openings?: OpeningData[];
  candidates?: OpeningCandidate[];
  selectedPanelId?: string | null;
  panelOverrides?: Map<string, PanelOverride>;
  previewColor?: string | null; // Color to preview on selected panel (hex)
  onPanelClick?: (meshType: string, instanceId: number, panelId: string) => void;
  onPanelDataReady?: (panelsByType: Record<PanelType, ClassifiedPanel[]>, allPanels: ClassifiedPanel[], allTopos: TopoPlacement[]) => void;
  className?: string;
  // Corner node selection and offsets
  selectedCornerNode?: string | null;
  onSelectCornerNode?: (nodeId: string | null) => void;
  cornerNodeOffsets?: Map<string, { nodeId: string; offsetX: number; offsetY: number }>;
  // Chain overrides (side flip)
  flippedChains?: Set<string>;
}

export function ICFViewer3D({ 
  walls, 
  settings, 
  openings = [], 
  candidates = [], 
  selectedPanelId,
  panelOverrides,
  previewColor,
  onPanelClick,
  onPanelDataReady,
  className = '',
  selectedCornerNode,
  onSelectCornerNode,
  cornerNodeOffsets,
  flippedChains = new Set(),
}: ICFViewer3DProps) {
  const [panelInstancesCount, setPanelInstancesCount] = useState(0);
  const [panelCounts, setPanelCounts] = useState<PanelCounts>({
    FULL: 0, CUT_SINGLE: 0, CORNER_CUT: 0, TOPO: 0, OPENING_VOID: 0
  });
  const [geometrySource, setGeometrySource] = useState<'glb' | 'step' | 'cache' | 'procedural' | 'simple'>('simple');
  const [geometryBBoxM, setGeometryBBoxM] = useState<{ x: number; y: number; z: number } | undefined>(undefined);
  const [geometryScaleApplied, setGeometryScaleApplied] = useState<number | undefined>(undefined);
  const [panelMeshVisible, setPanelMeshVisible] = useState<boolean | undefined>(undefined);
  const [panelMeshBBoxSizeM, setPanelMeshBBoxSizeM] = useState<{ x: number; y: number; z: number } | undefined>(undefined);
  const [instancePosRangeM, setInstancePosRangeM] = useState<{ min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | undefined>(undefined);
  const [layoutStats, setLayoutStats] = useState<{ lJunctions: number; tJunctions: number; xJunctions?: number; freeEnds?: number; templatesApplied: number; toposPlaced: number; effectiveOffset?: number } | undefined>(undefined);
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
          selectedPanelId={selectedPanelId}
          panelOverrides={panelOverrides}
          previewColor={previewColor}
          onPanelClick={onPanelClick}
          onPanelDataReady={onPanelDataReady}
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
          onLayoutStatsChange={setLayoutStats}
          selectedCornerNode={selectedCornerNode}
          onSelectCornerNode={onSelectCornerNode}
          cornerNodeOffsets={cornerNodeOffsets}
          flippedChains={flippedChains}
        />
      </Canvas>

      {showPanelsMode && panelInstancesCount > 0 && (
        <PanelLegend 
          visible={showLegend}
          onToggle={() => setShowLegend(!showLegend)}
          showOpenings={settings.showOpenings && (openings.length > 0 || candidates.length > 0)}
          showTopos={settings.showTopos && (openings.length > 0 || (layoutStats?.toposPlaced || 0) > 0)}
          counts={panelCounts}
        />
      )}

      {/* Footprint Stats Overlay */}
      {settings.showFootprintStats && walls.length > 0 && (
        <FootprintStatsOverlay walls={walls} />
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
        layoutStats={layoutStats}
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
