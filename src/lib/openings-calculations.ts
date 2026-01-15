// Openings calculation utilities for BOM and 3D rendering
// Handles panel subtraction for openings and TOPOS calculation

import { PANEL_WIDTH, PANEL_HEIGHT } from '@/types/icf';
import { OpeningData, getAffectedRows } from '@/types/openings';
import { WallChain } from './wall-chains';

export interface ChainInterval {
  start: number;
  end: number;
}

/**
 * Get remaining intervals for a chain after subtracting openings for a specific row
 * 
 * @param chain The wall chain
 * @param openings All openings (will filter to this chain)
 * @param rowIndex The 0-indexed row number
 * @returns Array of [start, end] intervals in mm along the chain
 */
export function getRemainingIntervalsForRow(
  chain: WallChain,
  openings: OpeningData[],
  rowIndex: number
): ChainInterval[] {
  // Filter openings for this chain
  const chainOpenings = openings.filter(o => o.chainId === chain.id);
  
  if (chainOpenings.length === 0) {
    // No openings, full chain available
    return [{ start: 0, end: chain.lengthMm }];
  }

  // Find which openings affect this row
  const affectingOpenings: { start: number; end: number }[] = [];
  
  for (const opening of chainOpenings) {
    const { startRow, endRow } = getAffectedRows(opening.sillMm, opening.heightMm);
    
    // Check if this row is affected
    if (rowIndex >= startRow && rowIndex < endRow) {
      affectingOpenings.push({
        start: opening.offsetMm,
        end: opening.offsetMm + opening.widthMm,
      });
    }
  }

  if (affectingOpenings.length === 0) {
    return [{ start: 0, end: chain.lengthMm }];
  }

  // Sort by start position
  affectingOpenings.sort((a, b) => a.start - b.start);

  // Merge overlapping openings
  const merged: { start: number; end: number }[] = [];
  for (const o of affectingOpenings) {
    const last = merged[merged.length - 1];
    if (last && o.start <= last.end) {
      last.end = Math.max(last.end, o.end);
    } else {
      merged.push({ ...o });
    }
  }

  // Calculate remaining intervals
  const intervals: ChainInterval[] = [];
  let cursor = 0;

  for (const gap of merged) {
    if (gap.start > cursor) {
      intervals.push({ start: cursor, end: gap.start });
    }
    cursor = gap.end;
  }

  // Add final interval if there's remaining length
  if (cursor < chain.lengthMm) {
    intervals.push({ start: cursor, end: chain.lengthMm });
  }

  return intervals;
}

/**
 * Calculate total remaining length for all chains in a row
 */
export function getTotalRemainingLengthForRow(
  chains: WallChain[],
  openings: OpeningData[],
  rowIndex: number
): number {
  let total = 0;
  for (const chain of chains) {
    const intervals = getRemainingIntervalsForRow(chain, openings, rowIndex);
    for (const interval of intervals) {
      total += interval.end - interval.start;
    }
  }
  return total;
}

/**
 * Calculate panels needed for a row with openings using bin packing
 * Returns the number of panels needed for this row
 */
export function calculatePanelsForRowWithOpenings(
  chains: WallChain[],
  openings: OpeningData[],
  rowIndex: number
): {
  panelsNeeded: number;
  fullPanels: number;
  binsUsed: number;
  remainders: number[];
  totalLengthMm: number;
} {
  let sumFullPanels = 0;
  const remainders: number[] = [];
  let totalLengthMm = 0;

  for (const chain of chains) {
    const intervals = getRemainingIntervalsForRow(chain, openings, rowIndex);
    
    for (const interval of intervals) {
      const lengthMm = interval.end - interval.start;
      totalLengthMm += lengthMm;
      
      const fullPanels = Math.floor(lengthMm / PANEL_WIDTH);
      const remainder = lengthMm % PANEL_WIDTH;
      
      sumFullPanels += fullPanels;
      if (remainder > 0) {
        remainders.push(remainder);
      }
    }
  }

  // Bin pack remainders
  const { binsUsed } = binPackRemaindersSimple(remainders);

  return {
    panelsNeeded: sumFullPanels + binsUsed,
    fullPanels: sumFullPanels,
    binsUsed,
    remainders,
    totalLengthMm,
  };
}

/**
 * Simple First-Fit Decreasing bin packing
 */
function binPackRemaindersSimple(remainders: number[], binCapacity: number = PANEL_WIDTH): { binsUsed: number } {
  if (remainders.length === 0) return { binsUsed: 0 };

  const sorted = [...remainders].sort((a, b) => b - a);
  const bins: number[] = []; // remaining capacity per bin

  for (const rem of sorted) {
    if (rem <= 0) continue;

    let placed = false;
    for (let i = 0; i < bins.length; i++) {
      if (bins[i] >= rem) {
        bins[i] -= rem;
        placed = true;
        break;
      }
    }

    if (!placed) {
      bins.push(binCapacity - rem);
    }
  }

  return { binsUsed: bins.length };
}

/**
 * Calculate complete BOM with openings support
 * This is the main function that handles panel subtraction and TOPOS calculation
 */
export function calculateBOMWithOpenings(
  chains: WallChain[],
  openings: OpeningData[],
  numFiadas: number,
  rebarSpacingCm: 10 | 15 | 20,
  concreteThicknessMm: number,
  cornerMode: 'overlap_cut' | 'topo',
  gridSettings: { base: boolean; mid: boolean; top: boolean },
  junctionCounts: { L: number; T: number; X: number; end: number }
): {
  panelsCount: number;
  panelsPerFiada: number[];
  avgPanelsPerFiada: number;
  
  toposOpenings: number;
  toposOpeningsMeters: number;
  cutsOpenings: number;
  
  // Other BOM items (pass through from base calculation)
  tarugosBase: number;
  tarugosAdjustments: number;
  tarugosTotal: number;
  tarugosInjection: number;
  websTotal: number;
  websPerPanel: number;
  gridsTotal: number;
  gridsPerFiada: number;
  gridRows: number[];
  
  // Topos (combined)
  toposUnits: number;
  toposMeters: number;
  toposByReason: {
    tJunction: number;
    xJunction: number;
    openings: number;
    corners: number;
  };
  
  // Diagnostics
  wastePct: number;
  expectedPanelsApprox: number;
  totalWallLength: number;
  cutsCount: number;
} {
  const totalLengthMm = chains.reduce((sum, c) => sum + c.lengthMm, 0);
  
  // Calculate panels per fiada (varies by row due to openings)
  const panelsPerFiada: number[] = [];
  let totalPanels = 0;
  let totalCutsOpenings = 0;
  
  for (let row = 0; row < numFiadas; row++) {
    const { panelsNeeded, remainders } = calculatePanelsForRowWithOpenings(chains, openings, row);
    panelsPerFiada.push(panelsNeeded);
    totalPanels += panelsNeeded;
    
    // Each opening creates 2 cuts per affected row (one on each side)
    const openingsAffectingRow = openings.filter(o => {
      const { startRow, endRow } = getAffectedRows(o.sillMm, o.heightMm);
      return row >= startRow && row < endRow;
    });
    totalCutsOpenings += openingsAffectingRow.length * 2;
  }
  
  const avgPanelsPerFiada = numFiadas > 0 ? totalPanels / numFiadas : 0;
  
  // Calculate TOPOS for openings
  // 2 topos per affected row per opening (one on each side)
  let toposOpenings = 0;
  for (const opening of openings) {
    const { rowsAffected } = getAffectedRows(opening.sillMm, opening.heightMm);
    toposOpenings += 2 * rowsAffected;
  }
  const toposOpeningsMeters = toposOpenings * 0.4; // Each topo is 400mm

  // ============ TARUGOS ============
  const tarugosBase = totalPanels * 2;
  const adjustmentPerFiada = (junctionCounts.L * -1) + (junctionCounts.T * 1) + (junctionCounts.X * 2);
  const tarugosAdjustments = adjustmentPerFiada * numFiadas;
  const tarugosTotal = Math.max(0, tarugosBase + tarugosAdjustments);
  const tarugosInjection = totalPanels;

  // ============ WEBS ============
  const websPerPanel = rebarSpacingCm === 10 ? 4 : rebarSpacingCm === 15 ? 3 : 2;
  const websTotal = totalPanels * websPerPanel;

  // ============ GRIDS (3m units) ============
  const totalLengthM = totalLengthMm / 1000;
  const gridsPerFiada = Math.ceil(totalLengthM / 3);
  
  const gridRows: number[] = [];
  if (gridSettings.base) gridRows.push(0);
  if (gridSettings.mid && numFiadas > 2) gridRows.push(Math.floor(numFiadas / 2));
  if (gridSettings.top && numFiadas > 1) gridRows.push(numFiadas - 1);
  
  const uniqueGridRows = Array.from(new Set(gridRows)).sort((a, b) => a - b);
  const gridsTotal = gridsPerFiada * uniqueGridRows.length;

  // ============ TOPOS (T/X/corners) ============
  const numTipo2Fiadas = Math.floor(numFiadas / 2);
  const tTopo = junctionCounts.T * numTipo2Fiadas;
  const xTopo = junctionCounts.X * numTipo2Fiadas;
  const cornerTopo = cornerMode === 'topo' ? junctionCounts.L * numTipo2Fiadas : 0;
  
  const toposUnits = tTopo + xTopo + cornerTopo + toposOpenings;
  const toposMeters = (tTopo + xTopo + cornerTopo) * 0.4 + toposOpeningsMeters;

  // ============ WASTE ============
  // Calculate waste based on actual vs theoretical panels
  const minPanelsPerFiada = Math.ceil(totalLengthMm / PANEL_WIDTH);
  const expectedPanelsApprox = minPanelsPerFiada * numFiadas;
  
  // For waste calculation, we need to consider opening subtractions
  // Waste = (supplied - needed) / supplied
  const totalRemainingLength = panelsPerFiada.reduce((sum, _, row) => {
    return sum + getTotalRemainingLengthForRow(chains, openings, row);
  }, 0);
  
  const suppliedMm = totalPanels * PANEL_WIDTH;
  const wastePct = suppliedMm > 0 ? (suppliedMm - totalRemainingLength) / suppliedMm : 0;

  // Base cuts (from chain remainders without openings) + opening cuts
  const baseCutsPerFiada = chains.filter(c => c.lengthMm % PANEL_WIDTH > 0).length;
  const cutsCount = baseCutsPerFiada * numFiadas + totalCutsOpenings;

  return {
    panelsCount: totalPanels,
    panelsPerFiada,
    avgPanelsPerFiada,
    
    toposOpenings,
    toposOpeningsMeters,
    cutsOpenings: totalCutsOpenings,
    
    tarugosBase,
    tarugosAdjustments,
    tarugosTotal,
    tarugosInjection,
    websTotal,
    websPerPanel,
    gridsTotal,
    gridsPerFiada,
    gridRows: uniqueGridRows,
    
    toposUnits,
    toposMeters,
    toposByReason: {
      tJunction: tTopo,
      xJunction: xTopo,
      openings: toposOpenings,
      corners: cornerTopo,
    },
    
    wastePct,
    expectedPanelsApprox,
    totalWallLength: totalLengthMm,
    cutsCount,
  };
}

/**
 * Get panel placements for 3D rendering, respecting openings
 */
export function getPanelPlacementsForRow(
  chains: WallChain[],
  openings: OpeningData[],
  rowIndex: number
): {
  chainId: string;
  x: number;
  y: number;
  angle: number;
  scaleX: number; // For cut panels
  intervalStart: number;
  intervalEnd: number;
}[] {
  const placements: {
    chainId: string;
    x: number;
    y: number;
    angle: number;
    scaleX: number;
    intervalStart: number;
    intervalEnd: number;
  }[] = [];

  for (const chain of chains) {
    const intervals = getRemainingIntervalsForRow(chain, openings, rowIndex);
    
    for (const interval of intervals) {
      const lengthMm = interval.end - interval.start;
      const numPanels = Math.ceil(lengthMm / PANEL_WIDTH);
      
      for (let i = 0; i < numPanels; i++) {
        const panelStart = interval.start + i * PANEL_WIDTH;
        const panelEnd = Math.min(panelStart + PANEL_WIDTH, interval.end);
        const panelLength = panelEnd - panelStart;
        const scaleX = panelLength / PANEL_WIDTH;
        
        // Position along chain
        const progress = (panelStart + panelLength / 2) / chain.lengthMm;
        const x = chain.startX + (chain.endX - chain.startX) * progress;
        const y = chain.startY + (chain.endY - chain.startY) * progress;
        
        placements.push({
          chainId: chain.id,
          x,
          y,
          angle: chain.angle,
          scaleX,
          intervalStart: interval.start,
          intervalEnd: interval.end,
        });
      }
    }
  }

  return placements;
}

/**
 * Get topo placements for 3D rendering (at opening edges)
 */
export function getTopoPlacementsForOpenings(
  chains: WallChain[],
  openings: OpeningData[],
  concreteThicknessMm: number
): {
  chainId: string;
  openingId: string;
  side: 'left' | 'right';
  row: number;
  x: number;
  y: number;
  angle: number;
}[] {
  const placements: {
    chainId: string;
    openingId: string;
    side: 'left' | 'right';
    row: number;
    x: number;
    y: number;
    angle: number;
  }[] = [];

  for (const opening of openings) {
    const chain = chains.find(c => c.id === opening.chainId);
    if (!chain) continue;

    const { startRow, endRow } = getAffectedRows(opening.sillMm, opening.heightMm);

    for (let row = startRow; row < endRow; row++) {
      // Left side topo
      const leftProgress = opening.offsetMm / chain.lengthMm;
      const leftX = chain.startX + (chain.endX - chain.startX) * leftProgress;
      const leftY = chain.startY + (chain.endY - chain.startY) * leftProgress;

      placements.push({
        chainId: chain.id,
        openingId: opening.id,
        side: 'left',
        row,
        x: leftX,
        y: leftY,
        angle: chain.angle,
      });

      // Right side topo
      const rightProgress = (opening.offsetMm + opening.widthMm) / chain.lengthMm;
      const rightX = chain.startX + (chain.endX - chain.startX) * rightProgress;
      const rightY = chain.startY + (chain.endY - chain.startY) * rightProgress;

      placements.push({
        chainId: chain.id,
        openingId: opening.id,
        side: 'right',
        row,
        x: rightX,
        y: rightY,
        angle: chain.angle,
      });
    }
  }

  return placements;
}
