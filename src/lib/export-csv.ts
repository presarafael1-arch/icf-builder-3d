// CSV Export utilities for OMNI ICF WALLS 3D PLANNER
import { BOMResult, ConcreteThickness } from '@/types/icf';

export interface CSVRow {
  itemCode: string;
  itemName: string;
  unit: string;
  qty: number | string;
  notes: string;
}

export interface ExportParams {
  projectName: string;
  concreteThickness: ConcreteThickness;
  wallHeightMm: number;
  rebarSpacingCm: number;
  cornerMode: string;
  numberOfRows: number;
}

/**
 * Generate CSV content from BOM with all diagnostics
 */
export function generateBOMCSV(
  bom: BOMResult,
  params: ExportParams
): string {
  const { projectName, concreteThickness, wallHeightMm, rebarSpacingCm, cornerMode, numberOfRows } = params;
  
  const lines: string[] = [];
  
  // Header section
  lines.push('OMNI ICF WALLS 3D PLANNER - BOM Export');
  lines.push(`Data de exportação;${new Date().toLocaleDateString('pt-PT')}`);
  lines.push('');
  
  // Project parameters
  lines.push('=== PARÂMETROS DO PROJETO ===');
  lines.push(`Projeto;${projectName}`);
  lines.push(`Núcleo de betão (tc);${concreteThickness} mm`);
  lines.push(`Altura total;${(wallHeightMm / 1000).toFixed(1)} m`);
  lines.push(`Número de fiadas;${numberOfRows}`);
  lines.push(`Espaçamento ferros;${getRebarNote(rebarSpacingCm)}`);
  lines.push(`Modo cantos;${cornerMode === 'overlap_cut' ? 'Overlap + Corte' : 'Topo'}`);
  lines.push('');
  
  // Chain/merge stats
  lines.push('=== ESTATÍSTICAS DE IMPORTAÇÃO ===');
  lines.push(`Comprimento total;${(bom.totalWallLength / 1000).toFixed(2)} m`);
  lines.push(`Número de cadeias;${bom.chainsCount ?? 'N/A'}`);
  lines.push(`Painéis esperados (aprox);${bom.expectedPanelsApprox ?? 'N/A'}`);
  lines.push(`Painéis calculados;${bom.panelsCount}`);
  lines.push(`Desperdício (wastePct);${bom.wastePct ? (bom.wastePct * 100).toFixed(1) + '%' : 'N/A'}`);
  lines.push(`Calculado por;${(bom.chainsCount ?? 0) > 0 ? 'CADEIAS (CHAINS)' : 'SEGMENTOS (fallback)'}`);
  lines.push('');
  
  // Junction counts
  lines.push('=== TOPOLOGIA ===');
  lines.push(`Cantos L;${bom.junctionCounts.L}`);
  lines.push(`Nós T;${bom.junctionCounts.T}`);
  lines.push(`Nós X;${bom.junctionCounts.X}`);
  lines.push(`Fins;${bom.junctionCounts.end}`);
  lines.push('');
  
  // BOM table
  lines.push('=== LISTA DE MATERIAIS (BOM) ===');
  lines.push('Código;Item;Quantidade;Unidade;Observações');
  
  const rows: CSVRow[] = [
    {
      itemCode: 'ICF-001',
      itemName: 'Painel Standard 1200x400mm',
      unit: 'un',
      qty: bom.panelsCount,
      notes: `${numberOfRows} fiadas × ${bom.panelsPerFiada || '-'} painéis/fiada`
    },
    {
      itemCode: 'ICF-002',
      itemName: 'Tarugos (base)',
      unit: 'un',
      qty: bom.tarugosBase,
      notes: '2 por painel'
    },
    {
      itemCode: 'ICF-003',
      itemName: 'Tarugos (ajustes L/T/X)',
      unit: 'un',
      qty: bom.tarugosAdjustments,
      notes: `L:${bom.junctionCounts.L}×(-1) T:${bom.junctionCounts.T}×(+1) X:${bom.junctionCounts.X}×(+2)`
    },
    {
      itemCode: 'ICF-004',
      itemName: 'Tarugos (total)',
      unit: 'un',
      qty: bom.tarugosTotal,
      notes: ''
    },
    {
      itemCode: 'ICF-005',
      itemName: 'Tarugos de Injeção',
      unit: 'un',
      qty: bom.tarugosInjection,
      notes: 'Controlo de betonagem'
    },
    {
      itemCode: 'ICF-006',
      itemName: `Topo (${concreteThickness}mm) - T/X`,
      unit: 'un',
      qty: bom.toposByReason.tJunction + bom.toposByReason.xJunction,
      notes: 'Junções T e X'
    },
    {
      itemCode: 'ICF-007',
      itemName: `Topo (${concreteThickness}mm) - Aberturas`,
      unit: 'un',
      qty: bom.toposByReason.openings,
      notes: 'Portas e Janelas'
    },
    {
      itemCode: 'ICF-008',
      itemName: `Topo (${concreteThickness}mm) - Cantos`,
      unit: 'un',
      qty: bom.toposByReason.corners,
      notes: 'Modo Topo em cantos'
    },
    {
      itemCode: 'ICF-009',
      itemName: `Topo (${concreteThickness}mm) - Total`,
      unit: 'un',
      qty: bom.toposUnits,
      notes: `${bom.toposMeters.toFixed(2)} metros lineares`
    },
    {
      itemCode: 'ICF-010',
      itemName: 'Webs Distanciadoras',
      unit: 'un',
      qty: bom.websTotal,
      notes: getRebarNote(rebarSpacingCm)
    },
    {
      itemCode: 'ICF-011',
      itemName: `GRID Estabilização ${concreteThickness}mm`,
      unit: 'un (3m)',
      qty: bom.gridsTotal,
      notes: `${bom.gridsPerRow} por fiada × ${bom.gridRows.length} fiadas: ${bom.gridRows.map(r => r + 1).join(', ')}`
    },
    {
      itemCode: 'ICF-012',
      itemName: 'Cortes',
      unit: 'cortes',
      qty: bom.cutsCount,
      notes: `${(bom.cutsLengthMm / 1000).toFixed(2)}m total`
    }
  ];
  
  rows.forEach(row => {
    lines.push(`${row.itemCode};"${row.itemName}";${row.qty};${row.unit};"${row.notes}"`);
  });
  
  return lines.join('\n');
}

/**
 * Get human-readable note for rebar spacing
 */
function getRebarNote(rebarSpacingCm: number): string {
  if (rebarSpacingCm === 20) return '20cm = standard (2 webs/painel)';
  if (rebarSpacingCm === 15) return '15cm = +1 web extra (3 webs/painel)';
  if (rebarSpacingCm === 10) return '10cm = +2 webs extra (4 webs/painel)';
  return `${rebarSpacingCm}cm`;
}

/**
 * Download CSV file
 */
export function downloadCSV(csvContent: string, filename: string): void {
  const BOM = '\uFEFF'; // UTF-8 BOM for Excel compatibility
  const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Generate filename with date
 */
export function generateFilename(projectName: string, extension: string): string {
  const date = new Date().toISOString().split('T')[0];
  const safeName = projectName.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
  return `omni-icf-bom-${safeName}-${date}.${extension}`;
}
