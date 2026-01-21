/**
 * L-Corner Normalization Module
 * 
 * Automatically normalizes L-corner panels with:
 * - 4×TOOTH cuts on both panels at the corner
 * - 1.5T/2.5T offsets chosen by alignment to reference parallel panel's tooth phase
 * 
 * This module ONLY adjusts corner cuts and offsets locally.
 * It does NOT change global pagination, startMm/endMm, or side classification.
 */

import { WallChain } from './wall-chains';
import { LJunctionInfo, ClassifiedPanel } from './panel-layout';
import { TOOTH, PANEL_WIDTH } from '@/types/icf';

// Corner cut amount: always 4 TOOTH
export const CORNER_CUT_TOOTH = 4;
export const CORNER_CUT_MM = CORNER_CUT_TOOTH * TOOTH;

// Possible offsets: 1.5T and 2.5T
export const OFFSET_SMALL_TOOTH = 1.5;
export const OFFSET_LARGE_TOOTH = 2.5;
export const OFFSET_SMALL_MM = OFFSET_SMALL_TOOTH * TOOTH;
export const OFFSET_LARGE_MM = OFFSET_LARGE_TOOTH * TOOTH;

// Corner role: which panel advances (LEAD) vs rests (SEAT)
export type CornerRole = 'LEAD' | 'SEAT';

// Scenario for offset assignment
export type CornerScenario = 'A_LEAD_2.5_B_1.5' | 'A_LEAD_1.5_B_2.5';

// Corner panel info (computed per L-junction)
export interface CornerPanelInfo {
  panelId: string;
  chainId: string;
  role: CornerRole;
  cornerCutMm: number;           // Always 4×TOOTH
  cornerOffsetMm: number;        // 1.5T or 2.5T
  scenario: CornerScenario;
  atNodeEnd: 'start' | 'end';    // Which end of the chain touches the node
  
  // Debug info
  crossZ: number;                // Cross product Z for role determination
  referenceParallelPanelId: string | null;
  referencePhase: number | null;
  phaseError: number | null;
  noRefReason: string | null;
}

// L-corner result (pair of panels)
export interface LCornerResult {
  junctionId: string;
  junctionX: number;
  junctionY: number;
  panelA: CornerPanelInfo;
  panelB: CornerPanelInfo;
  chosenScenario: CornerScenario;
  scenarioError: number;         // Phase error for chosen scenario
  alternativeError: number;      // Phase error for alternative scenario
}

// Map of corner adjustments by panelId
export interface CornerAdjustmentsMap {
  [panelId: string]: {
    cornerCutMm: number;
    cornerOffsetMm: number;
    role: CornerRole;
    junctionId: string;
    scenario: CornerScenario;
    debugInfo: {
      referenceParallelPanelId: string | null;
      referencePhase: number | null;
      phaseError: number | null;
      noRefReason: string | null;
      crossZ: number;
    };
  };
}

/**
 * Calculate tooth phase: fractional part of (mm / TOOTH)
 * Returns value in [0, 1)
 */
function toothPhase(mm: number): number {
  const phase = (mm / TOOTH) % 1;
  return phase < 0 ? phase + 1 : phase;
}

/**
 * Calculate phase distance (circular distance on [0,1))
 * Returns value in [0, 0.5]
 */
function phaseDistance(p: number, q: number): number {
  const diff = Math.abs(p - q);
  return Math.min(diff, 1 - diff);
}

/**
 * Get direction vector for a chain at a specific endpoint
 * Returns unit vector pointing AWAY from the junction point
 */
function getChainDirAtNode(
  chain: WallChain,
  nodeX: number,
  nodeY: number,
  tolerance: number = 300
): { x: number; y: number; atStart: boolean } {
  const atStart = Math.abs(chain.startX - nodeX) < tolerance && Math.abs(chain.startY - nodeY) < tolerance;
  
  const dx = chain.endX - chain.startX;
  const dy = chain.endY - chain.startY;
  const len = chain.lengthMm;
  
  if (atStart) {
    // At chain start: direction points away from junction (toward end)
    return { x: dx / len, y: dy / len, atStart: true };
  } else {
    // At chain end: direction points away from junction (toward start)
    return { x: -dx / len, y: -dy / len, atStart: false };
  }
}

/**
 * Find the corner panel (last panel before node or first panel from node)
 * for a chain at a given L-junction
 */
function findCornerPanelForChain(
  chainId: string,
  panels: ClassifiedPanel[],
  nodeX: number,
  nodeY: number,
  chain: WallChain
): ClassifiedPanel | null {
  // Get chain panels sorted by position
  const chainPanels = panels
    .filter(p => p.chainId === chainId && p.rowIndex === 0) // Only row 0 for now
    .sort((a, b) => (a.startMm ?? 0) - (b.startMm ?? 0));
  
  if (chainPanels.length === 0) return null;
  
  // Determine which end of the chain is at the node
  const tolerance = 300;
  const atStart = Math.abs(chain.startX - nodeX) < tolerance && Math.abs(chain.startY - nodeY) < tolerance;
  
  if (atStart) {
    // Node is at chain start: first panel is the corner panel
    return chainPanels[0];
  } else {
    // Node is at chain end: last panel is the corner panel
    return chainPanels[chainPanels.length - 1];
  }
}

/**
 * Find a reference parallel panel for phase alignment
 * 
 * The reference panel should be:
 * - PARALLEL to the cut plane (perpendicular to the corner panel's chain)
 * - NOT one of the corner panels
 * - As close to the junction as possible
 */
function findReferenceParallelPanel(
  cornerPanelChainId: string,
  cornerPanelDir: { x: number; y: number },
  junctionX: number,
  junctionY: number,
  allPanels: ClassifiedPanel[],
  chains: WallChain[]
): { panel: ClassifiedPanel; projectedS: number } | null {
  // The cut plane is perpendicular to the corner panel's direction
  // So we want panels that are PARALLEL to the cut plane
  // i.e., panels whose chain direction is PERPENDICULAR to cornerPanelDir
  
  const candidates: Array<{ panel: ClassifiedPanel; chain: WallChain; distance: number; projectedS: number }> = [];
  
  for (const panel of allPanels) {
    // Skip panels from the same chain
    if (panel.chainId === cornerPanelChainId) continue;
    
    const chain = chains.find(c => c.id === panel.chainId);
    if (!chain) continue;
    
    // Get chain direction
    const dx = (chain.endX - chain.startX) / chain.lengthMm;
    const dy = (chain.endY - chain.startY) / chain.lengthMm;
    
    // Check if perpendicular to cornerPanelDir (i.e., parallel to cut plane)
    // Dot product should be ~0 for perpendicular
    const dot = Math.abs(cornerPanelDir.x * dx + cornerPanelDir.y * dy);
    
    if (dot > 0.3) continue; // Not perpendicular enough (allow ~17° tolerance)
    
    // Calculate distance from junction to panel center
    const panelCenterMm = (panel.startMm ?? 0) + (panel.widthMm / 2);
    const panelCenterX = chain.startX + dx * panelCenterMm;
    const panelCenterY = chain.startY + dy * panelCenterMm;
    
    const distance = Math.sqrt(
      Math.pow(panelCenterX - junctionX, 2) +
      Math.pow(panelCenterY - junctionY, 2)
    );
    
    // Project junction onto this chain to get S coordinate
    // Vector from chain start to junction
    const toJuncX = junctionX - chain.startX;
    const toJuncY = junctionY - chain.startY;
    
    // Project onto chain direction
    const projectedS = toJuncX * dx + toJuncY * dy;
    
    candidates.push({ panel, chain, distance, projectedS });
  }
  
  if (candidates.length === 0) return null;
  
  // Sort by distance and pick closest
  candidates.sort((a, b) => a.distance - b.distance);
  
  const best = candidates[0];
  return { panel: best.panel, projectedS: best.projectedS };
}

/**
 * Compute LEAD/SEAT roles and optimal offsets for an L-junction
 */
export function computeLCornerNormalization(
  lj: LJunctionInfo,
  chains: WallChain[],
  allPanels: ClassifiedPanel[]
): LCornerResult | null {
  const chainA = chains.find(c => c.id === lj.primaryChainId);
  const chainB = chains.find(c => c.id === lj.secondaryChainId);
  
  if (!chainA || !chainB) {
    console.log(`[L-CORNER] Missing chain for junction ${lj.nodeId}`);
    return null;
  }
  
  // Get direction vectors at the node
  const dirA = getChainDirAtNode(chainA, lj.x, lj.y);
  const dirB = getChainDirAtNode(chainB, lj.x, lj.y);
  
  // 2D cross product to determine LEAD/SEAT
  // cross = tanA × tanB = tanA.x * tanB.y - tanA.y * tanB.x
  const crossZ = dirA.x * dirB.y - dirA.y * dirB.x;
  
  // Determine roles based on cross product sign
  let roleA: CornerRole;
  let roleB: CornerRole;
  
  if (crossZ > 0) {
    roleA = 'LEAD';
    roleB = 'SEAT';
  } else {
    roleA = 'SEAT';
    roleB = 'LEAD';
  }
  
  // Find corner panels for each chain
  const cornerPanelA = findCornerPanelForChain(chainA.id, allPanels, lj.x, lj.y, chainA);
  const cornerPanelB = findCornerPanelForChain(chainB.id, allPanels, lj.x, lj.y, chainB);
  
  if (!cornerPanelA || !cornerPanelB) {
    console.log(`[L-CORNER] Missing corner panel for junction ${lj.nodeId}:`, {
      chainA: chainA.id.slice(0, 8),
      chainB: chainB.id.slice(0, 8),
      hasA: !!cornerPanelA,
      hasB: !!cornerPanelB,
    });
    return null;
  }
  
  // Find reference parallel panel (use chainA's direction to find parallel chain)
  const refResultA = findReferenceParallelPanel(
    chainA.id,
    { x: dirA.x, y: dirA.y },
    lj.x,
    lj.y,
    allPanels,
    chains
  );
  
  const refResultB = findReferenceParallelPanel(
    chainB.id,
    { x: dirB.x, y: dirB.y },
    lj.x,
    lj.y,
    allPanels,
    chains
  );
  
  // Use the reference that is closest to the junction
  let refResult = refResultA;
  let refFromChain = 'A';
  
  if (!refResultA && refResultB) {
    refResult = refResultB;
    refFromChain = 'B';
  } else if (refResultA && refResultB) {
    // Both available, pick based on which is more reliably positioned
    // Prefer the one with the panel closer to the junction
    const distA = refResultA.panel.distanceToNodeMm ?? Infinity;
    const distB = refResultB.panel.distanceToNodeMm ?? Infinity;
    if (distB < distA) {
      refResult = refResultB;
      refFromChain = 'B';
    }
  }
  
  // Calculate reference phase if available
  let referencePhase: number | null = null;
  let noRefReason: string | null = null;
  
  if (refResult) {
    // Reference phase is the tooth phase at the projected junction position on the reference chain
    referencePhase = toothPhase(refResult.projectedS);
  } else {
    noRefReason = 'NO_PARALLEL_PANEL';
  }
  
  // Calculate base corner positions (where the cut would be without offset)
  // For panel at node start: cut is at position 0 (chain start)
  // For panel at node end: cut is at position chain.lengthMm
  const baseCornerS_A = dirA.atStart ? 0 : chainA.lengthMm;
  const baseCornerS_B = dirB.atStart ? 0 : chainB.lengthMm;
  
  // Try both scenarios and pick the one with better phase alignment
  const scenarios: Array<{
    name: CornerScenario;
    offsetA: number;
    offsetB: number;
  }> = [
    { name: 'A_LEAD_2.5_B_1.5', offsetA: OFFSET_LARGE_MM, offsetB: OFFSET_SMALL_MM },
    { name: 'A_LEAD_1.5_B_2.5', offsetA: OFFSET_SMALL_MM, offsetB: OFFSET_LARGE_MM },
  ];
  
  let bestScenario = scenarios[0];
  let bestError = Infinity;
  let alternativeError = Infinity;
  
  if (referencePhase !== null) {
    for (const scenario of scenarios) {
      // Calculate cut positions with offsets
      // Offset direction depends on whether panel is at start or end of chain
      const cutS_A = dirA.atStart
        ? baseCornerS_A + scenario.offsetA
        : baseCornerS_A - scenario.offsetA;
      
      const cutS_B = dirB.atStart
        ? baseCornerS_B + scenario.offsetB
        : baseCornerS_B - scenario.offsetB;
      
      // Calculate phases
      const phaseA = toothPhase(cutS_A);
      const phaseB = toothPhase(cutS_B);
      
      // Total error
      const error = phaseDistance(phaseA, referencePhase) + phaseDistance(phaseB, referencePhase);
      
      if (error < bestError) {
        alternativeError = bestError;
        bestError = error;
        bestScenario = scenario;
      } else if (error < alternativeError) {
        alternativeError = error;
      }
    }
  } else {
    // No reference: default to LEAD gets 2.5T (larger offset)
    if (roleA === 'LEAD') {
      bestScenario = scenarios[0]; // A_LEAD_2.5_B_1.5
    } else {
      bestScenario = scenarios[1]; // A_LEAD_1.5_B_2.5
    }
    bestError = 0;
    alternativeError = 0;
    noRefReason = noRefReason || 'DEFAULT_LEAD_2.5';
  }
  
  // Build result
  const panelAInfo: CornerPanelInfo = {
    panelId: cornerPanelA.panelId || '',
    chainId: chainA.id,
    role: roleA,
    cornerCutMm: CORNER_CUT_MM,
    cornerOffsetMm: bestScenario.offsetA,
    scenario: bestScenario.name,
    atNodeEnd: dirA.atStart ? 'start' : 'end',
    crossZ,
    referenceParallelPanelId: refResult?.panel.panelId || null,
    referencePhase,
    phaseError: referencePhase !== null ? phaseDistance(
      toothPhase(dirA.atStart ? bestScenario.offsetA : chainA.lengthMm - bestScenario.offsetA),
      referencePhase
    ) : null,
    noRefReason,
  };
  
  const panelBInfo: CornerPanelInfo = {
    panelId: cornerPanelB.panelId || '',
    chainId: chainB.id,
    role: roleB,
    cornerCutMm: CORNER_CUT_MM,
    cornerOffsetMm: bestScenario.offsetB,
    scenario: bestScenario.name,
    atNodeEnd: dirB.atStart ? 'start' : 'end',
    crossZ: -crossZ, // Opposite sign for B
    referenceParallelPanelId: refResult?.panel.panelId || null,
    referencePhase,
    phaseError: referencePhase !== null ? phaseDistance(
      toothPhase(dirB.atStart ? bestScenario.offsetB : chainB.lengthMm - bestScenario.offsetB),
      referencePhase
    ) : null,
    noRefReason,
  };
  
  console.log(`[L-CORNER NORM] ${lj.nodeId}:`, {
    chainA: chainA.id.slice(0, 8),
    chainB: chainB.id.slice(0, 8),
    crossZ: crossZ.toFixed(3),
    roles: `A=${roleA}, B=${roleB}`,
    scenario: bestScenario.name,
    offsets: `A=${(bestScenario.offsetA / TOOTH).toFixed(1)}T, B=${(bestScenario.offsetB / TOOTH).toFixed(1)}T`,
    refPanel: refResult?.panel.panelId?.slice(0, 12) || 'NONE',
    refPhase: referencePhase?.toFixed(3) || 'N/A',
    error: bestError.toFixed(4),
  });
  
  return {
    junctionId: lj.nodeId,
    junctionX: lj.x,
    junctionY: lj.y,
    panelA: panelAInfo,
    panelB: panelBInfo,
    chosenScenario: bestScenario.name,
    scenarioError: bestError,
    alternativeError,
  };
}

/**
 * Compute all L-corner normalizations for a set of panels
 * Returns a map of panel adjustments by panelId
 */
export function computeAllLCornerAdjustments(
  lJunctions: LJunctionInfo[],
  chains: WallChain[],
  allPanels: ClassifiedPanel[]
): CornerAdjustmentsMap {
  const adjustments: CornerAdjustmentsMap = {};
  
  for (const lj of lJunctions) {
    const result = computeLCornerNormalization(lj, chains, allPanels);
    
    if (!result) continue;
    
    // Store adjustments for both panels
    if (result.panelA.panelId) {
      adjustments[result.panelA.panelId] = {
        cornerCutMm: result.panelA.cornerCutMm,
        cornerOffsetMm: result.panelA.cornerOffsetMm,
        role: result.panelA.role,
        junctionId: result.junctionId,
        scenario: result.panelA.scenario,
        debugInfo: {
          referenceParallelPanelId: result.panelA.referenceParallelPanelId,
          referencePhase: result.panelA.referencePhase,
          phaseError: result.panelA.phaseError,
          noRefReason: result.panelA.noRefReason,
          crossZ: result.panelA.crossZ,
        },
      };
    }
    
    if (result.panelB.panelId) {
      adjustments[result.panelB.panelId] = {
        cornerCutMm: result.panelB.cornerCutMm,
        cornerOffsetMm: result.panelB.cornerOffsetMm,
        role: result.panelB.role,
        junctionId: result.junctionId,
        scenario: result.panelB.scenario,
        debugInfo: {
          referenceParallelPanelId: result.panelB.referenceParallelPanelId,
          referencePhase: result.panelB.referencePhase,
          phaseError: result.panelB.phaseError,
          noRefReason: result.panelB.noRefReason,
          crossZ: result.panelB.crossZ,
        },
      };
    }
  }
  
  console.log(`[L-CORNER] Computed ${Object.keys(adjustments).length} panel adjustments from ${lJunctions.length} L-junctions`);
  
  return adjustments;
}

/**
 * Apply corner adjustments to panel widths
 * This modifies the panel's widthMm based on the corner cut
 * 
 * NOTE: This returns a NEW panel with adjusted width, does not mutate the original
 */
export function applyCornerCutToPanel(
  panel: ClassifiedPanel,
  adjustment: CornerAdjustmentsMap[string]
): ClassifiedPanel {
  // Calculate new width after corner cut
  const newWidth = PANEL_WIDTH - adjustment.cornerCutMm;
  
  return {
    ...panel,
    widthMm: newWidth,
    type: 'CORNER_CUT',
    isCornerPiece: true,
    cutLeftMm: adjustment.cornerCutMm, // Record the cut amount
    lCornerOffsetMm: adjustment.cornerOffsetMm,
    ruleApplied: `L-corner ${adjustment.role} ${(adjustment.cornerOffsetMm / TOOTH).toFixed(1)}T offset`,
  };
}
