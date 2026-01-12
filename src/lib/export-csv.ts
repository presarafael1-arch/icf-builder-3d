// CSV Export utilities for OMNI ICF WALLS 3D PLANNER
import { BOMResult, ConcreteThickness } from '@/types/icf';

export interface CSVRow {
  itemCode: string;
  itemName: string;
  unit: string;
  qty: number | string;
  notes: string;
}

/**
 * Generate CSV content from BOM
 */
export function generateBOMCSV(
  bom: BOMResult,
  projectName: string,
  concreteThickness: ConcreteThickness,
  rebarSpacingCm: number
): string {
  const rows: CSVRow[] = [
    {
      itemCode: 'ICF-001',
      itemName: 'Painel Standard 1200x400mm',
      unit: 'un',
      qty: bom.panelsCount,
      notes: `${bom.numberOfRows} fiadas`
    },
    {
      itemCode: 'ICF-002',
      itemName: 'Webs Distanciadoras',
      unit: 'un',
      qty: bom.websTotal,
      notes: getRebarNote(rebarSpacingCm)
    },
    {
      itemCode: 'ICF-003',
      itemName: 'Tarugos (Base)',
      unit: 'un',
      qty: bom.tarugosBase,
      notes: '2 por painel'
    },
    {
      itemCode: 'ICF-004',
      itemName: 'Tarugos (Ajustes L/T/X)',
      unit: 'un',
      qty: bom.tarugosAdjustments,
      notes: `L:${bom.junctionCounts.L} T:${bom.junctionCounts.T} X:${bom.junctionCounts.X}`
    },
    {
      itemCode: 'ICF-005',
      itemName: 'Tarugos (Total)',
      unit: 'un',
      qty: bom.tarugosTotal,
      notes: ''
    },
    {
      itemCode: 'ICF-006',
      itemName: 'Tarugos de Injeção',
      unit: 'un',
      qty: bom.tarugosInjection,
      notes: 'Controlo de betonagem'
    },
    {
      itemCode: 'ICF-007',
      itemName: `Topo (${concreteThickness}mm) - T/X`,
      unit: 'un',
      qty: bom.toposByReason.tJunction + bom.toposByReason.xJunction,
      notes: 'Junções T e X'
    },
    {
      itemCode: 'ICF-008',
      itemName: `Topo (${concreteThickness}mm) - Aberturas`,
      unit: 'un',
      qty: bom.toposByReason.openings,
      notes: 'Portas e Janelas'
    },
    {
      itemCode: 'ICF-009',
      itemName: `Topo (${concreteThickness}mm) - Cantos`,
      unit: 'un',
      qty: bom.toposByReason.corners,
      notes: 'Modo Topo em cantos'
    },
    {
      itemCode: 'ICF-010',
      itemName: `Topo (${concreteThickness}mm) - Total`,
      unit: 'un',
      qty: bom.toposUnits,
      notes: `${bom.toposMeters.toFixed(2)} metros lineares`
    },
    {
      itemCode: 'ICF-011',
      itemName: `GRID Estabilização ${concreteThickness}mm`,
      unit: 'un (3m)',
      qty: bom.gridsTotal,
      notes: `${bom.gridRows.length} fiadas: ${bom.gridRows.map(r => r + 1).join(', ')}`
    },
    {
      itemCode: 'ICF-012',
      itemName: 'Cortes',
      unit: 'cortes',
      qty: bom.cutsCount,
      notes: `${(bom.cutsLengthMm / 1000).toFixed(2)}m total`
    }
  ];
  
  // Generate CSV string
  const header = ['Código', 'Item', 'Unidade', 'Quantidade', 'Observações'];
  const csvRows = [
    header.join(';'),
    ...rows.map(row => [
      row.itemCode,
      `"${row.itemName}"`,
      row.unit,
      row.qty,
      `"${row.notes}"`
    ].join(';'))
  ];
  
  return csvRows.join('\n');
}

/**
 * Get human-readable note for rebar spacing
 */
function getRebarNote(rebarSpacingCm: number): string {
  if (rebarSpacingCm === 20) return '20cm = standard (2 webs/nível)';
  if (rebarSpacingCm === 15) return '15cm = +1 web extra (3 webs/nível)';
  if (rebarSpacingCm === 10) return '10cm = +2 webs extra (4 webs/nível)';
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
