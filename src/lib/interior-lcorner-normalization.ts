/**
 * Interior L-Corner Normalization
 * 
 * POST-PROCESS function that applies consistent corner cuts and phase offsets
 * to INTERIOR panels only. NEVER modifies exterior panels or pagination.
 * 
 * RULES:
 * 1. EXTERIOR PANELS ARE READ-ONLY - never modify panel.side === 'exterior'
 * 2. NO PAGINATION CHANGES - never modify startMm, endMm, placement
 * 3. Only modify local mesh/cap parameters on INTERIOR panels:
 *    - cornerCutMm (fixed at 4×TOOTH)
 *    - cornerPhaseOffsetTooth (1.5 or 2.5, chosen by alignment to exterior)
 *    - cornerRole (LEAD or SEAT)
 * 4. Manual overrides have absolute priority
 */

import { ClassifiedPanel, LJunctionInfo, WallSide } from './panel-layout';
import { WallChain } from './wall-chains';
import { TOOTH, PANEL_WIDTH } from '@/types/icf';

// Corner cut size: exactly 4×TOOTH
export const CORNER_CUT_TOOTH = 4;
export const CORNER_CUT_MM = CORNER_CUT_TOOTH * TOOTH;

// Phase offset options (in TOOTH units)
export const PHASE_OFFSET_OPTIONS: [number, number] = [1.5, 2.5];

// Corner role: which panel "leads" vs which panel "seats"
export type CornerRole = 'LEAD' | 'SEAT' | null;

// Extended corner info for interior panels
export interface InteriorCornerInfo {
  // Junction reference
  lJunctionId: string;
  
  // Corner role
  cornerRole: CornerRole;
  
  // Cut info (fixed at 4×TOOTH)
  cornerCutMm: number;
  cornerCutTooth: number;
  cornerCutEnd: 'start' | 'end'; // Which end of the panel is cut
  
  // Phase offset (1.5 or 2.5 TOOTH)
  cornerPhaseOffsetTooth: number;
  cornerPhaseOffsetMm: number;
  
  // Alignment reference (exterior panel used for phase calculation)
  phaseRefPanelId: string | null;
  phaseRefValue: number; // (distance along run) mod TOOTH
  phaseError: number; // Alignment error in mm
  
  // Debug info
  hypothesis1Error: number; // Error if using 1.5/2.5
  hypothesis2Error: number; // Error if using 2.5/1.5
  chosenHypothesis: 1 | 2;
}

// Map panelId -> corner info
export type InteriorCornerMap = Map<string, InteriorCornerInfo>;

/**
 * Find the panel at a specific position along a chain for a given side
 */
function findPanelAtNode(
  panels: ClassifiedPanel[],
  chainId: string,
  side: WallSide,
  atStart: boolean, // true = panel at chain start, false = at chain end
  chainLengthMm: number
): ClassifiedPanel | null {
  const matchingPanels = panels.filter(p => 
    p.chainId === chainId && 
    p.side === side &&
    p.rowIndex === 0 // Only row 0 for corner detection
  );
  
  if (matchingPanels.length === 0) return null;
  
  // Sort by position along chain
  matchingPanels.sort((a, b) => (a.startMm ?? 0) - (b.startMm ?? 0));
  
  if (atStart) {
    // First panel at chain start
    return matchingPanels[0];
  } else {
    // Last panel at chain end
    return matchingPanels[matchingPanels.length - 1];
  }
}

/**
 * Find the parallel exterior panel for phase reference
 */
function findParallelExteriorPanel(
  panels: ClassifiedPanel[],
  interiorPanel: ClassifiedPanel,
  chain: WallChain,
  lJunction: LJunctionInfo
): ClassifiedPanel | null {
  // Get all exterior panels on the same chain
  const exteriorPanels = panels.filter(p =>
    p.chainId === interiorPanel.chainId &&
    p.side === 'exterior' &&
    p.rowIndex === interiorPanel.rowIndex
  );
  
  if (exteriorPanels.length === 0) return null;
  
  // Find the one closest to the same position
  const targetPos = (interiorPanel.startMm ?? 0) + ((interiorPanel.widthMm ?? PANEL_WIDTH) / 2);
  
  let closest: ClassifiedPanel | null = null;
  let closestDist = Infinity;
  
  for (const ext of exteriorPanels) {
    const extPos = (ext.startMm ?? 0) + ((ext.widthMm ?? PANEL_WIDTH) / 2);
    const dist = Math.abs(extPos - targetPos);
    if (dist < closestDist) {
      closestDist = dist;
      closest = ext;
    }
  }
  
  return closest;
}

/**
 * Calculate phase reference value from an exterior panel
 * Phase = (position along run) mod TOOTH
 */
function calculatePhaseRef(panel: ClassifiedPanel): number {
  const centerPos = (panel.startMm ?? 0) + ((panel.widthMm ?? PANEL_WIDTH) / 2);
  // Normalize to [0, TOOTH)
  let phase = centerPos % TOOTH;
  if (phase < 0) phase += TOOTH;
  return phase;
}

/**
 * Calculate alignment error for a given phase offset
 */
function calculateAlignmentError(
  phaseRef: number,
  phaseOffsetTooth: number
): number {
  const offsetMm = phaseOffsetTooth * TOOTH;
  const adjustedPhase = offsetMm % TOOTH;
  
  // Error is the minimum distance between phases (modular arithmetic)
  let error = Math.abs(phaseRef - adjustedPhase);
  if (error > TOOTH / 2) {
    error = TOOTH - error;
  }
  return error;
}

/**
 * Determine which chain end the panel is at
 */
function getPanelEndAtNode(
  panel: ClassifiedPanel,
  chain: WallChain,
  lJunction: LJunctionInfo,
  tolerance: number = 300
): 'start' | 'end' | null {
  const panelStart = panel.startMm ?? 0;
  const panelEnd = (panel.endMm ?? panelStart + (panel.widthMm ?? PANEL_WIDTH));
  
  // Check if junction is at chain start or end
  const distToChainStart = Math.sqrt(
    (chain.startX - lJunction.x) ** 2 + 
    (chain.startY - lJunction.y) ** 2
  );
  const distToChainEnd = Math.sqrt(
    (chain.endX - lJunction.x) ** 2 + 
    (chain.endY - lJunction.y) ** 2
  );
  
  const junctionAtChainStart = distToChainStart < tolerance;
  const junctionAtChainEnd = distToChainEnd < tolerance;
  
  if (junctionAtChainStart) {
    // Junction is at chain start, so panel's "start" end faces the node
    if (panelStart < TOOTH * 2) return 'start';
  } else if (junctionAtChainEnd) {
    // Junction is at chain end, so panel's "end" end faces the node
    if (chain.lengthMm - panelEnd < TOOTH * 2) return 'end';
  }
  
  return null;
}

/**
 * Check if a panel has a manual override
 */
function hasManualOverride(
  panel: ClassifiedPanel,
  overriddenPanelIds: Set<string>
): boolean {
  return overriddenPanelIds.has(panel.panelId ?? '');
}

/**
 * Apply interior L-corner normalization to all interior corner panels
 * 
 * This is a POST-PROCESS function that:
 * 1. Identifies interior-interior L-corner junctions
 * 2. Applies fixed 4×TOOTH corner cuts
 * 3. Calculates optimal phase offset (1.5 or 2.5) based on exterior alignment
 * 4. Returns a map of corner info per panel (does NOT modify panel objects)
 * 
 * @param panels - All classified panels (will NOT be modified)
 * @param chains - Wall chains for geometry reference
 * @param lJunctions - Detected L-junctions
 * @param overriddenPanelIds - Set of panel IDs with manual overrides (skip these)
 * @returns Map of panelId -> InteriorCornerInfo
 */
export function applyInteriorLCornerNormalization(
  panels: ClassifiedPanel[],
  chains: WallChain[],
  lJunctions: LJunctionInfo[],
  overriddenPanelIds: Set<string> = new Set()
): InteriorCornerMap {
  const cornerMap: InteriorCornerMap = new Map();
  
  if (!panels.length || !chains.length || !lJunctions.length) {
    return cornerMap;
  }
  
  console.log(`[L-CORNER NORM] Processing ${lJunctions.length} L-junctions for interior normalization`);
  
  // Create chain lookup
  const chainMap = new Map(chains.map(c => [c.id, c]));
  
  for (const lj of lJunctions) {
    const primaryChain = chainMap.get(lj.primaryChainId);
    const secondaryChain = chainMap.get(lj.secondaryChainId);
    
    if (!primaryChain || !secondaryChain) {
      console.log(`[L-CORNER NORM] Skip L-junction ${lj.nodeId}: missing chains`);
      continue;
    }
    
    // Find interior panels at this L-junction
    // Panel A: on primaryChain, closest to junction
    // Panel B: on secondaryChain, closest to junction
    
    const primaryAtStart = Math.sqrt(
      (primaryChain.startX - lj.x) ** 2 + 
      (primaryChain.startY - lj.y) ** 2
    ) < 300;
    
    const secondaryAtStart = Math.sqrt(
      (secondaryChain.startX - lj.x) ** 2 + 
      (secondaryChain.startY - lj.y) ** 2
    ) < 300;
    
    const intPanelA = findPanelAtNode(
      panels, 
      primaryChain.id, 
      'interior', 
      primaryAtStart, 
      primaryChain.lengthMm
    );
    
    const intPanelB = findPanelAtNode(
      panels, 
      secondaryChain.id, 
      'interior', 
      secondaryAtStart, 
      secondaryChain.lengthMm
    );
    
    // RULE: Only process if BOTH panels are interior
    // If either is exterior or missing, skip this junction
    if (!intPanelA || !intPanelB) {
      console.log(`[L-CORNER NORM] Skip L-junction ${lj.nodeId}: missing interior panels`);
      continue;
    }
    
    if (intPanelA.side !== 'interior' || intPanelB.side !== 'interior') {
      console.log(`[L-CORNER NORM] Skip L-junction ${lj.nodeId}: not both interior`);
      continue;
    }
    
    // Check for manual overrides
    if (hasManualOverride(intPanelA, overriddenPanelIds)) {
      console.log(`[L-CORNER NORM] Skip panel ${intPanelA.panelId}: has manual override`);
      continue;
    }
    if (hasManualOverride(intPanelB, overriddenPanelIds)) {
      console.log(`[L-CORNER NORM] Skip panel ${intPanelB.panelId}: has manual override`);
      continue;
    }
    
    // Find parallel exterior panels for phase reference
    const extRefA = findParallelExteriorPanel(panels, intPanelA, primaryChain, lj);
    const extRefB = findParallelExteriorPanel(panels, intPanelB, secondaryChain, lj);
    
    // Calculate phase reference from exterior (use A as primary reference)
    const phaseRef = extRefA ? calculatePhaseRef(extRefA) : 0;
    
    // Test both hypotheses:
    // H1: panelA = 2.5 TOOTH offset, panelB = 1.5 TOOTH offset
    // H2: panelA = 1.5 TOOTH offset, panelB = 2.5 TOOTH offset
    const h1ErrorA = calculateAlignmentError(phaseRef, 2.5);
    const h1ErrorB = calculateAlignmentError(phaseRef, 1.5);
    const h1TotalError = h1ErrorA + h1ErrorB;
    
    const h2ErrorA = calculateAlignmentError(phaseRef, 1.5);
    const h2ErrorB = calculateAlignmentError(phaseRef, 2.5);
    const h2TotalError = h2ErrorA + h2ErrorB;
    
    // Choose hypothesis with lower total error
    const useH1 = h1TotalError <= h2TotalError;
    const phaseOffsetA = useH1 ? 2.5 : 1.5;
    const phaseOffsetB = useH1 ? 1.5 : 2.5;
    
    // Determine which end of each panel faces the node
    const cutEndA = getPanelEndAtNode(intPanelA, primaryChain, lj);
    const cutEndB = getPanelEndAtNode(intPanelB, secondaryChain, lj);
    
    console.log(`[L-CORNER NORM] L-junction ${lj.nodeId}:`, {
      panelA: intPanelA.panelId,
      panelB: intPanelB.panelId,
      phaseRef: phaseRef.toFixed(1),
      h1Error: h1TotalError.toFixed(1),
      h2Error: h2TotalError.toFixed(1),
      chosen: useH1 ? 'H1(A=2.5,B=1.5)' : 'H2(A=1.5,B=2.5)',
    });
    
    // Create corner info for panel A
    if (intPanelA.panelId && cutEndA) {
      cornerMap.set(intPanelA.panelId, {
        lJunctionId: lj.nodeId,
        cornerRole: 'LEAD',
        cornerCutMm: CORNER_CUT_MM,
        cornerCutTooth: CORNER_CUT_TOOTH,
        cornerCutEnd: cutEndA,
        cornerPhaseOffsetTooth: phaseOffsetA,
        cornerPhaseOffsetMm: phaseOffsetA * TOOTH,
        phaseRefPanelId: extRefA?.panelId ?? null,
        phaseRefValue: phaseRef,
        phaseError: useH1 ? h1ErrorA : h2ErrorA,
        hypothesis1Error: h1TotalError,
        hypothesis2Error: h2TotalError,
        chosenHypothesis: useH1 ? 1 : 2,
      });
    }
    
    // Create corner info for panel B
    if (intPanelB.panelId && cutEndB) {
      cornerMap.set(intPanelB.panelId, {
        lJunctionId: lj.nodeId,
        cornerRole: 'SEAT',
        cornerCutMm: CORNER_CUT_MM,
        cornerCutTooth: CORNER_CUT_TOOTH,
        cornerCutEnd: cutEndB,
        cornerPhaseOffsetTooth: phaseOffsetB,
        cornerPhaseOffsetMm: phaseOffsetB * TOOTH,
        phaseRefPanelId: extRefB?.panelId ?? null,
        phaseRefValue: phaseRef,
        phaseError: useH1 ? h1ErrorB : h2ErrorB,
        hypothesis1Error: h1TotalError,
        hypothesis2Error: h2TotalError,
        chosenHypothesis: useH1 ? 1 : 2,
      });
    }
  }
  
  console.log(`[L-CORNER NORM] Applied normalization to ${cornerMap.size} interior corner panels`);
  
  return cornerMap;
}

/**
 * Get corner info for a specific panel
 */
export function getInteriorCornerInfo(
  panelId: string,
  cornerMap: InteriorCornerMap
): InteriorCornerInfo | null {
  return cornerMap.get(panelId) ?? null;
}

/**
 * Check if a panel is an interior corner panel
 */
export function isInteriorCornerPanel(
  panelId: string,
  cornerMap: InteriorCornerMap
): boolean {
  return cornerMap.has(panelId);
}
