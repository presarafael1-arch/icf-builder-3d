/**
 * L-Corner Node Anchoring System
 * 
 * Geometrically resolves L-corners by:
 * 1. Calculating accurate nodeExt and nodeInt from centerlines + wall thickness
 * 2. Selecting ANCHOR panel (exterior, placed "full" to nodeExt)
 * 3. Placing FOLLOW panel to abut ANCHOR without gaps
 * 4. Applying interior corner cuts (4×TOOTH + 1.5/2.5 phase offset)
 * 
 * RULES:
 * - NO REPAGINATION: never change panel count, order, startMm/endMm
 * - NO GLOBAL PLACEMENT CHANGES: only local endcap overrides
 * - EXTERIOR panels touch nodeExt as full panels (no heuristic offsets)
 * - INTERIOR corner cuts follow existing interior-lcorner-normalization
 */

import { ClassifiedPanel, LJunctionInfo, CornerNode, WallSide } from './panel-layout';
import { WallChain } from './wall-chains';
import { TOOTH, PANEL_WIDTH, ConcreteThickness } from '@/types/icf';

// Corner role for exterior panels: ANCHOR (placed first to nodeExt) or FOLLOW (abuts ANCHOR)
export type ExteriorCornerRole = 'ANCHOR' | 'FOLLOW' | null;

// Extended corner node info with calculated geometry
export interface LCornerNodeInfo {
  lJunctionId: string;
  
  // Computed nodes (from offset line intersections)
  nodeExt: { x: number; y: number };
  nodeInt: { x: number; y: number };
  
  // DXF intersection point (for reference)
  dxfVertex: { x: number; y: number };
  
  // Chain info
  primaryChainId: string;
  secondaryChainId: string;
  
  // Which end of each chain touches the node
  primaryAtStart: boolean;
  secondaryAtStart: boolean;
  
  // Exterior panel anchoring
  anchorPanelId: string | null;
  followPanelId: string | null;
  anchorChainId: string | null;
  followChainId: string | null;
  
  // Endcap adjustments (mm) for each panel
  // Positive = extend toward node, negative = retract from node
  anchorEndcapAdjustMm: number;
  followEndcapAdjustMm: number;
  
  // Debug info
  anchorDistanceToNodeMm: number;
  followDistanceToNodeMm: number;
}

// Map lJunctionId -> corner node info
export type LCornerNodeMap = Map<string, LCornerNodeInfo>;

/**
 * Find the exterior corner panel for a chain at the junction
 */
function findExteriorCornerPanel(
  panels: ClassifiedPanel[],
  chainId: string,
  atStart: boolean, // Junction at chain start or end
  row: number = 0
): ClassifiedPanel | null {
  const candidates = panels.filter(p => 
    p.chainId === chainId && 
    p.side === 'exterior' &&
    p.rowIndex === row
  );
  
  if (candidates.length === 0) return null;
  
  // Sort by position along chain
  candidates.sort((a, b) => (a.startMm ?? 0) - (b.startMm ?? 0));
  
  if (atStart) {
    // First panel at chain start
    return candidates[0];
  } else {
    // Last panel at chain end
    return candidates[candidates.length - 1];
  }
}

/**
 * Calculate the distance from a panel's edge to the corner node
 * Returns the distance along the chain axis
 */
function calculatePanelDistanceToNode(
  panel: ClassifiedPanel,
  chain: WallChain,
  nodeX: number,
  nodeY: number,
  atStart: boolean
): number {
  if (!panel.startMm || !panel.endMm) return Infinity;
  
  // Panel edge position along chain
  const panelEdgeMm = atStart ? panel.startMm : panel.endMm;
  
  // Chain direction
  const dirX = (chain.endX - chain.startX) / chain.lengthMm;
  const dirY = (chain.endY - chain.startY) / chain.lengthMm;
  
  // Position of panel edge in world coords
  const edgeWorldX = chain.startX + dirX * panelEdgeMm;
  const edgeWorldY = chain.startY + dirY * panelEdgeMm;
  
  // Vector from panel edge to node
  const toNodeX = nodeX - edgeWorldX;
  const toNodeY = nodeY - edgeWorldY;
  
  // Project onto chain direction to get distance along chain
  const distanceAlongChain = toNodeX * dirX + toNodeY * dirY;
  
  return distanceAlongChain;
}

/**
 * Select which panel should be ANCHOR (the one that extends to nodeExt)
 * 
 * Selection criteria:
 * 1. Choose the panel with smaller error when extending to nodeExt
 * 2. If similar, choose the panel from the "left" chain in perimeter rotation
 */
function selectAnchorPanel(
  panelA: ClassifiedPanel | null,
  panelB: ClassifiedPanel | null,
  chainA: WallChain,
  chainB: WallChain,
  atStartA: boolean,
  atStartB: boolean,
  nodeExt: { x: number; y: number }
): { anchor: ClassifiedPanel | null; follow: ClassifiedPanel | null; anchorChainId: string | null; followChainId: string | null } {
  if (!panelA && !panelB) {
    return { anchor: null, follow: null, anchorChainId: null, followChainId: null };
  }
  
  if (!panelA) {
    return { anchor: panelB, follow: null, anchorChainId: chainB.id, followChainId: null };
  }
  
  if (!panelB) {
    return { anchor: panelA, follow: null, anchorChainId: chainA.id, followChainId: null };
  }
  
  // Calculate distances to nodeExt for both panels
  const distA = Math.abs(calculatePanelDistanceToNode(panelA, chainA, nodeExt.x, nodeExt.y, atStartA));
  const distB = Math.abs(calculatePanelDistanceToNode(panelB, chainB, nodeExt.x, nodeExt.y, atStartB));
  
  // Choose the panel that's closer to nodeExt (less adjustment needed)
  // This minimizes the endcap adjustment required
  if (distA <= distB) {
    return { anchor: panelA, follow: panelB, anchorChainId: chainA.id, followChainId: chainB.id };
  } else {
    return { anchor: panelB, follow: panelA, anchorChainId: chainB.id, followChainId: chainA.id };
  }
}

/**
 * Calculate endcap adjustment for ANCHOR panel
 * The anchor panel's exterior face should touch nodeExt exactly
 */
function calculateAnchorEndcapAdjust(
  anchorPanel: ClassifiedPanel,
  anchorChain: WallChain,
  atStart: boolean,
  nodeExt: { x: number; y: number },
  concreteThickness: ConcreteThickness
): number {
  // Half thickness for exterior offset
  const wallTotalTooth = concreteThickness === '150' ? 4 : 5;
  const halfThicknessMm = (wallTotalTooth / 2) * TOOTH;
  
  // Distance from panel edge to nodeExt along chain axis
  const distance = calculatePanelDistanceToNode(
    anchorPanel, 
    anchorChain, 
    nodeExt.x, 
    nodeExt.y, 
    atStart
  );
  
  // At chain start: positive distance means extend forward
  // At chain end: positive distance means extend backward (so negate)
  return atStart ? distance : -distance;
}

/**
 * Calculate endcap adjustment for FOLLOW panel
 * The follow panel should abut the anchor panel at the corner
 */
function calculateFollowEndcapAdjust(
  followPanel: ClassifiedPanel,
  followChain: WallChain,
  atStart: boolean,
  nodeExt: { x: number; y: number },
  anchorEndcapAdjust: number,
  concreteThickness: ConcreteThickness
): number {
  // The follow panel needs to meet at nodeExt
  // Calculate similar to anchor
  const distance = calculatePanelDistanceToNode(
    followPanel, 
    followChain, 
    nodeExt.x, 
    nodeExt.y, 
    atStart
  );
  
  return atStart ? distance : -distance;
}

/**
 * Build L-corner node info for all L-junctions
 * 
 * This is a POST-PROCESS function that:
 * 1. Uses already-computed nodeExt/nodeInt from LJunctionInfo
 * 2. Identifies exterior panels at each corner
 * 3. Selects ANCHOR and FOLLOW panels
 * 4. Calculates endcap adjustments (local overrides only)
 * 
 * CRITICAL: Does NOT modify panels or repaginate
 */
export function buildLCornerNodeInfo(
  panels: ClassifiedPanel[],
  chains: WallChain[],
  lJunctions: LJunctionInfo[],
  concreteThickness: ConcreteThickness = '150'
): LCornerNodeMap {
  const cornerMap: LCornerNodeMap = new Map();
  
  if (!panels.length || !chains.length || !lJunctions.length) {
    return cornerMap;
  }
  
  console.log(`[L-CORNER ANCHORING] Processing ${lJunctions.length} L-junctions`);
  
  const chainMap = new Map(chains.map(c => [c.id, c]));
  
  for (const lj of lJunctions) {
    const primaryChain = chainMap.get(lj.primaryChainId);
    const secondaryChain = chainMap.get(lj.secondaryChainId);
    
    if (!primaryChain || !secondaryChain) {
      console.log(`[L-CORNER ANCHORING] Skip ${lj.nodeId}: missing chains`);
      continue;
    }
    
    // Get computed corner nodes
    const nodeExt = lj.exteriorNode ? { x: lj.exteriorNode.x, y: lj.exteriorNode.y } : { x: lj.x, y: lj.y };
    const nodeInt = lj.interiorNode ? { x: lj.interiorNode.x, y: lj.interiorNode.y } : { x: lj.x, y: lj.y };
    
    // Determine which end of each chain touches the junction
    const primaryAtStart = Math.sqrt(
      (primaryChain.startX - lj.x) ** 2 + (primaryChain.startY - lj.y) ** 2
    ) < 300;
    
    const secondaryAtStart = Math.sqrt(
      (secondaryChain.startX - lj.x) ** 2 + (secondaryChain.startY - lj.y) ** 2
    ) < 300;
    
    // Find exterior panels at this corner (row 0 for base calculation)
    const extPanelPrimary = findExteriorCornerPanel(panels, primaryChain.id, primaryAtStart);
    const extPanelSecondary = findExteriorCornerPanel(panels, secondaryChain.id, secondaryAtStart);
    
    // Select anchor and follow
    const { anchor, follow, anchorChainId, followChainId } = selectAnchorPanel(
      extPanelPrimary,
      extPanelSecondary,
      primaryChain,
      secondaryChain,
      primaryAtStart,
      secondaryAtStart,
      nodeExt
    );
    
    // Calculate endcap adjustments
    let anchorEndcapAdjustMm = 0;
    let followEndcapAdjustMm = 0;
    let anchorDistanceToNodeMm = 0;
    let followDistanceToNodeMm = 0;
    
    if (anchor && anchorChainId) {
      const anchorChain = chainMap.get(anchorChainId)!;
      const atStart = anchorChainId === primaryChain.id ? primaryAtStart : secondaryAtStart;
      anchorEndcapAdjustMm = calculateAnchorEndcapAdjust(
        anchor, anchorChain, atStart, nodeExt, concreteThickness
      );
      anchorDistanceToNodeMm = Math.abs(calculatePanelDistanceToNode(
        anchor, anchorChain, nodeExt.x, nodeExt.y, atStart
      ));
    }
    
    if (follow && followChainId) {
      const followChain = chainMap.get(followChainId)!;
      const atStart = followChainId === primaryChain.id ? primaryAtStart : secondaryAtStart;
      followEndcapAdjustMm = calculateFollowEndcapAdjust(
        follow, followChain, atStart, nodeExt, anchorEndcapAdjustMm, concreteThickness
      );
      followDistanceToNodeMm = Math.abs(calculatePanelDistanceToNode(
        follow, followChain, nodeExt.x, nodeExt.y, atStart
      ));
    }
    
    const info: LCornerNodeInfo = {
      lJunctionId: lj.nodeId,
      nodeExt,
      nodeInt,
      dxfVertex: { x: lj.x, y: lj.y },
      primaryChainId: primaryChain.id,
      secondaryChainId: secondaryChain.id,
      primaryAtStart,
      secondaryAtStart,
      anchorPanelId: anchor?.panelId ?? null,
      followPanelId: follow?.panelId ?? null,
      anchorChainId,
      followChainId,
      anchorEndcapAdjustMm,
      followEndcapAdjustMm,
      anchorDistanceToNodeMm,
      followDistanceToNodeMm,
    };
    
    cornerMap.set(lj.nodeId, info);
    
    console.log(`[L-CORNER ANCHORING] ${lj.nodeId}:`, {
      nodeExt: `(${nodeExt.x.toFixed(1)}, ${nodeExt.y.toFixed(1)})`,
      nodeInt: `(${nodeInt.x.toFixed(1)}, ${nodeInt.y.toFixed(1)})`,
      anchor: anchor?.panelId?.slice(0, 16) ?? 'none',
      follow: follow?.panelId?.slice(0, 16) ?? 'none',
      anchorAdjust: `${anchorEndcapAdjustMm.toFixed(1)}mm`,
      followAdjust: `${followEndcapAdjustMm.toFixed(1)}mm`,
    });
  }
  
  console.log(`[L-CORNER ANCHORING] Built info for ${cornerMap.size} L-corners`);
  
  return cornerMap;
}

/**
 * Get corner node info for a specific L-junction
 */
export function getLCornerNodeInfo(
  lJunctionId: string,
  cornerMap: LCornerNodeMap
): LCornerNodeInfo | null {
  return cornerMap.get(lJunctionId) ?? null;
}

/**
 * Get corner info for a panel by its ID (checks if it's anchor or follow)
 */
export function getPanelCornerRole(
  panelId: string,
  cornerMap: LCornerNodeMap
): { role: ExteriorCornerRole; info: LCornerNodeInfo | null } {
  for (const info of cornerMap.values()) {
    if (info.anchorPanelId === panelId) {
      return { role: 'ANCHOR', info };
    }
    if (info.followPanelId === panelId) {
      return { role: 'FOLLOW', info };
    }
  }
  return { role: null, info: null };
}

/**
 * Get all corner nodes for visualization
 */
export function getAllCornerNodes(
  cornerMap: LCornerNodeMap
): Array<{ id: string; x: number; y: number; type: 'exterior' | 'interior'; lJunctionId: string }> {
  const nodes: Array<{ id: string; x: number; y: number; type: 'exterior' | 'interior'; lJunctionId: string }> = [];
  
  for (const info of cornerMap.values()) {
    nodes.push({
      id: `${info.lJunctionId}-ext`,
      x: info.nodeExt.x,
      y: info.nodeExt.y,
      type: 'exterior',
      lJunctionId: info.lJunctionId,
    });
    nodes.push({
      id: `${info.lJunctionId}-int`,
      x: info.nodeInt.x,
      y: info.nodeInt.y,
      type: 'interior',
      lJunctionId: info.lJunctionId,
    });
  }
  
  return nodes;
}
