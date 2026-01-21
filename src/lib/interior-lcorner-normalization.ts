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
 * 
 * OFFSET SELECTION (1.5 vs 2.5):
 * - For each L-corner, test both hypotheses:
 *   H1: panelA=2.5, panelB=1.5
 *   H2: panelA=1.5, panelB=2.5
 * - Score each hypothesis by geometric alignment with parallel exterior panel
 * - Select the hypothesis with minimum total error (gap + overlap + step penalties)
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
  
  // Debug info - scoring details
  hypothesis1Error: number; // Total error if using H1 (A=2.5, B=1.5)
  hypothesis2Error: number; // Total error if using H2 (A=1.5, B=2.5)
  chosenHypothesis: 1 | 2;
  
  // New debug fields for scoring breakdown
  gapError: number;        // E1: gap to exterior
  overlapPenalty: number;  // E2: overlap penalty
  stepPenalty: number;     // E3: step/misalignment penalty
  exteriorRefDir: { x: number; y: number } | null; // Direction of the reference exterior
  parallelismScore: number; // How parallel the interior cut is to exterior (0-1)
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
 * Find the parallel exterior panel from the OTHER arm of the L-corner
 * This is the "reference" panel that the interior cut should align with
 */
function findParallelExteriorRef(
  panels: ClassifiedPanel[],
  interiorPanel: ClassifiedPanel,
  interiorChain: WallChain,
  otherChain: WallChain, // The other arm of the L-corner
  lJunction: LJunctionInfo,
  chains: WallChain[]
): { panel: ClassifiedPanel | null; tanDir: { x: number; y: number } } {
  // Get the direction vectors of both chains
  const intDirX = (interiorChain.endX - interiorChain.startX) / interiorChain.lengthMm;
  const intDirY = (interiorChain.endY - interiorChain.startY) / interiorChain.lengthMm;
  
  const otherDirX = (otherChain.endX - otherChain.startX) / otherChain.lengthMm;
  const otherDirY = (otherChain.endY - otherChain.startY) / otherChain.lengthMm;
  
  // The "parallel" exterior is on the OTHER chain (perpendicular arm)
  // Because the interior cut plane is perpendicular to the interior panel's run
  // and we want it to align with the face of the OTHER arm's exterior panel
  
  // Get exterior panels on the other chain
  const otherAtStart = Math.sqrt(
    (otherChain.startX - lJunction.x) ** 2 + 
    (otherChain.startY - lJunction.y) ** 2
  ) < 300;
  
  const exteriorPanels = panels.filter(p =>
    p.chainId === otherChain.id &&
    p.side === 'exterior' &&
    p.rowIndex === 0
  );
  
  if (exteriorPanels.length === 0) {
    return { panel: null, tanDir: { x: otherDirX, y: otherDirY } };
  }
  
  // Sort by position
  exteriorPanels.sort((a, b) => (a.startMm ?? 0) - (b.startMm ?? 0));
  
  // Get the one at the junction end
  const refPanel = otherAtStart ? exteriorPanels[0] : exteriorPanels[exteriorPanels.length - 1];
  
  return { panel: refPanel, tanDir: { x: otherDirX, y: otherDirY } };
}

/**
 * Calculate the geometric score for a given offset hypothesis
 * 
 * IMPROVED ALGORITHM:
 * - Measures how well the interior panel's cut aligns with the exterior reference
 * - The 2.5T offset should go to the panel whose cut needs more clearance from the exterior
 * - The 1.5T offset should go to the panel whose cut is naturally closer to its meeting point
 * 
 * Score = E1 (gap) + 100*E2 (overlap) + 10*E3 (step)
 * Lower is better
 */
function calculateHypothesisScore(
  interiorPanel: ClassifiedPanel,
  interiorChain: WallChain,
  exteriorRef: ClassifiedPanel | null,
  exteriorRefDir: { x: number; y: number },
  offsetTooth: number,
  atStart: boolean,
  lJunction: LJunctionInfo
): { gapError: number; overlapPenalty: number; stepPenalty: number; totalScore: number; parallelism: number } {
  const offsetMm = offsetTooth * TOOTH;
  
  // Calculate the position of the interior panel's cut edge
  const panelStartMm = interiorPanel.startMm ?? 0;
  const panelEndMm = interiorPanel.endMm ?? (panelStartMm + (interiorPanel.widthMm ?? PANEL_WIDTH));
  
  // The cut position in chain-local coords
  // If at start: cut is at the start edge + offset (moving away from junction)
  // If at end: cut is at the end edge - offset (moving away from junction)
  let cutPositionMm: number;
  if (atStart) {
    cutPositionMm = panelStartMm + CORNER_CUT_MM + offsetMm;
  } else {
    cutPositionMm = panelEndMm - CORNER_CUT_MM - offsetMm;
  }
  
  // Get interior panel direction
  const intDirX = (interiorChain.endX - interiorChain.startX) / interiorChain.lengthMm;
  const intDirY = (interiorChain.endY - interiorChain.startY) / interiorChain.lengthMm;
  
  // Perpendicular to interior panel (this is the cut plane direction)
  const intPerpX = intDirY;
  const intPerpY = -intDirX;
  
  // Calculate parallelism: how parallel is the cut (intPerp) to the exterior ref direction
  // dot(intPerp, extRefDir) should be close to ±1 for good alignment
  const parallelism = Math.abs(intPerpX * exteriorRefDir.x + intPerpY * exteriorRefDir.y);
  
  // E1: Gap error - distance from cut edge to ideal meeting point with exterior
  // For a properly aligned corner, the cut should meet the exterior panel face
  let gapError = 0;
  
  if (exteriorRef) {
    // The junction node is where interior faces should meet
    const nodeInt = lJunction.interiorNode;
    if (nodeInt) {
      // Calculate world position of the cut
      const cutWorldX = interiorChain.startX + intDirX * cutPositionMm;
      const cutWorldY = interiorChain.startY + intDirY * cutPositionMm;
      
      const toNodeX = nodeInt.x - cutWorldX;
      const toNodeY = nodeInt.y - cutWorldY;
      
      // Project onto perpendicular direction (how far off the cut is from node)
      gapError = Math.abs(toNodeX * intPerpX + toNodeY * intPerpY);
      
      // IMPROVED: Also consider the distance along the chain direction
      // If the cut is too close to the junction, it may overlap with the exterior
      const distAlongChain = Math.abs(toNodeX * intDirX + toNodeY * intDirY);
      
      // If this panel's cut would be closer to the node than expected, penalize smaller offsets
      // (i.e., 1.5T should only be used when the cut doesn't need much clearance)
      if (distAlongChain < CORNER_CUT_MM && offsetTooth === 1.5) {
        gapError += TOOTH; // Add penalty for being too close with small offset
      }
    }
  }
  
  // E2: Overlap penalty - if the offset causes penetration into exterior
  // This is penalized heavily
  let overlapPenalty = 0;
  
  // For L-corners, if offset is too small (1.5T when 2.5T is needed), 
  // the cut may not clear the exterior panel
  // We detect this by checking if the gap error is large with small offset
  if (gapError > TOOTH * 1.5 && offsetTooth === 1.5) {
    // Potential overlap - the 1.5T offset might not be enough
    overlapPenalty = 50;
  }
  
  // Bonus: If 2.5T is used and gapError is small, this is a good fit
  if (offsetTooth === 2.5 && gapError < TOOTH) {
    gapError = Math.max(0, gapError - TOOTH * 0.5); // Reduce error as reward
  }
  
  // E3: Step penalty - measures how well the two interior panels align at the corner
  // This is calculated at the junction level, so we return 0 here
  // The junction-level scoring will combine both panels
  const stepPenalty = 0;
  
  // Total score (lower is better)
  const totalScore = gapError + 100 * overlapPenalty + 10 * stepPenalty;
  
  return { gapError, overlapPenalty, stepPenalty, totalScore, parallelism };
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
 * 3. Calculates optimal phase offset (1.5 or 2.5) based on geometric alignment
 * 4. Returns a map of corner info per panel (does NOT modify panel objects)
 * 
 * OFFSET SELECTION ALGORITHM:
 * - For each L-corner with panels A and B:
 *   - Find the parallel exterior panel for each interior panel (on the OTHER arm)
 *   - Test H1: A=2.5T, B=1.5T
 *   - Test H2: A=1.5T, B=2.5T
 *   - Score each by geometric alignment (gap + overlap + step penalties)
 *   - Choose hypothesis with minimum total score
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
    
    // Find parallel exterior panels for each interior panel
    // Interior A is on primaryChain, so its parallel exterior is on secondaryChain
    const extRefA = findParallelExteriorRef(panels, intPanelA, primaryChain, secondaryChain, lj, chains);
    // Interior B is on secondaryChain, so its parallel exterior is on primaryChain
    const extRefB = findParallelExteriorRef(panels, intPanelB, secondaryChain, primaryChain, lj, chains);
    
    // Determine which end of each panel faces the node
    const cutEndA = getPanelEndAtNode(intPanelA, primaryChain, lj);
    const cutEndB = getPanelEndAtNode(intPanelB, secondaryChain, lj);
    
    // ============ HYPOTHESIS SCORING ============
    // H1: panelA = 2.5T, panelB = 1.5T
    // H2: panelA = 1.5T, panelB = 2.5T
    
    const h1ScoreA = calculateHypothesisScore(
      intPanelA, primaryChain, extRefA.panel, extRefA.tanDir, 2.5, 
      cutEndA === 'start', lj
    );
    const h1ScoreB = calculateHypothesisScore(
      intPanelB, secondaryChain, extRefB.panel, extRefB.tanDir, 1.5,
      cutEndB === 'start', lj
    );
    
    const h2ScoreA = calculateHypothesisScore(
      intPanelA, primaryChain, extRefA.panel, extRefA.tanDir, 1.5,
      cutEndA === 'start', lj
    );
    const h2ScoreB = calculateHypothesisScore(
      intPanelB, secondaryChain, extRefB.panel, extRefB.tanDir, 2.5,
      cutEndB === 'start', lj
    );
    
    // Calculate step penalty for each hypothesis
    // Step = difference in how far each panel extends past the corner
    const h1StepPenalty = Math.abs(h1ScoreA.gapError - h1ScoreB.gapError);
    const h2StepPenalty = Math.abs(h2ScoreA.gapError - h2ScoreB.gapError);
    
    // Total scores with step penalty
    const h1TotalError = h1ScoreA.totalScore + h1ScoreB.totalScore + 10 * h1StepPenalty;
    const h2TotalError = h2ScoreA.totalScore + h2ScoreB.totalScore + 10 * h2StepPenalty;
    
    // ============ IMPROVED SELECTION LOGIC ============
    // 1. Primary: choose hypothesis with lower total error
    // 2. Tiebreaker: if errors are close, prefer giving 2.5T to the panel with higher overlap penalty
    // 3. Secondary tiebreaker: use parallelism score
    
    let useH1 = h1TotalError <= h2TotalError;
    
    // If scores are very close, use multiple tiebreakers
    if (Math.abs(h1TotalError - h2TotalError) < 15) {
      // Tiebreaker 1: Check overlap penalties
      // The panel that would have overlap with 1.5T should get 2.5T instead
      const h1OverlapRisk = h1ScoreB.overlapPenalty; // B has 1.5T in H1
      const h2OverlapRisk = h2ScoreA.overlapPenalty; // A has 1.5T in H2
      
      if (h1OverlapRisk !== h2OverlapRisk) {
        // If H1 has overlap risk on B, prefer H2 (give B the 2.5T)
        // If H2 has overlap risk on A, prefer H1 (give A the 2.5T)
        useH1 = h2OverlapRisk > h1OverlapRisk;
      } else {
        // Tiebreaker 2: Use gap error - panel with larger gap needs 2.5T
        const aGapWith15 = h2ScoreA.gapError; // A with 1.5T in H2
        const bGapWith15 = h1ScoreB.gapError; // B with 1.5T in H1
        
        if (Math.abs(aGapWith15 - bGapWith15) > TOOTH * 0.3) {
          // Give 2.5T to the one with larger gap when using 1.5T
          useH1 = aGapWith15 > bGapWith15; // If A has larger gap with 1.5T, use H1 (A gets 2.5T)
        } else {
          // Tiebreaker 3: Use parallelism
          // Give 2.5T to the panel that is MORE perpendicular to its exterior ref
          // (higher parallelism = more aligned cut = better with 2.5T clearance)
          useH1 = h1ScoreA.parallelism >= h2ScoreB.parallelism;
        }
      }
    }
    
    const phaseOffsetA = useH1 ? 2.5 : 1.5;
    const phaseOffsetB = useH1 ? 1.5 : 2.5;
    
    console.log(`[L-CORNER NORM] L-junction ${lj.nodeId}:`, {
      panelA: intPanelA.panelId?.slice(0, 20),
      panelB: intPanelB.panelId?.slice(0, 20),
      h1Error: h1TotalError.toFixed(1),
      h2Error: h2TotalError.toFixed(1),
      h1Step: h1StepPenalty.toFixed(1),
      h2Step: h2StepPenalty.toFixed(1),
      chosen: useH1 ? 'H1(A=2.5,B=1.5)' : 'H2(A=1.5,B=2.5)',
      parallelA: h1ScoreA.parallelism.toFixed(2),
      parallelB: h1ScoreB.parallelism.toFixed(2),
    });
    
    // Create corner info for panel A
    if (intPanelA.panelId && cutEndA) {
      const scoreA = useH1 ? h1ScoreA : h2ScoreA;
      cornerMap.set(intPanelA.panelId, {
        lJunctionId: lj.nodeId,
        cornerRole: 'LEAD',
        cornerCutMm: CORNER_CUT_MM,
        cornerCutTooth: CORNER_CUT_TOOTH,
        cornerCutEnd: cutEndA,
        cornerPhaseOffsetTooth: phaseOffsetA,
        cornerPhaseOffsetMm: phaseOffsetA * TOOTH,
        phaseRefPanelId: extRefA.panel?.panelId ?? null,
        phaseRefValue: 0, // Not using phase-based anymore
        phaseError: scoreA.gapError,
        hypothesis1Error: h1TotalError,
        hypothesis2Error: h2TotalError,
        chosenHypothesis: useH1 ? 1 : 2,
        gapError: scoreA.gapError,
        overlapPenalty: scoreA.overlapPenalty,
        stepPenalty: h1StepPenalty, // Junction-level
        exteriorRefDir: extRefA.tanDir,
        parallelismScore: scoreA.parallelism,
      });
    }
    
    // Create corner info for panel B
    if (intPanelB.panelId && cutEndB) {
      const scoreB = useH1 ? h1ScoreB : h2ScoreB;
      cornerMap.set(intPanelB.panelId, {
        lJunctionId: lj.nodeId,
        cornerRole: 'SEAT',
        cornerCutMm: CORNER_CUT_MM,
        cornerCutTooth: CORNER_CUT_TOOTH,
        cornerCutEnd: cutEndB,
        cornerPhaseOffsetTooth: phaseOffsetB,
        cornerPhaseOffsetMm: phaseOffsetB * TOOTH,
        phaseRefPanelId: extRefB.panel?.panelId ?? null,
        phaseRefValue: 0,
        phaseError: scoreB.gapError,
        hypothesis1Error: h1TotalError,
        hypothesis2Error: h2TotalError,
        chosenHypothesis: useH1 ? 1 : 2,
        gapError: scoreB.gapError,
        overlapPenalty: scoreB.overlapPenalty,
        stepPenalty: h2StepPenalty, // Junction-level
        exteriorRefDir: extRefB.tanDir,
        parallelismScore: scoreB.parallelism,
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
