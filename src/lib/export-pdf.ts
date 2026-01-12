// PDF Export utilities for OMNI ICF WALLS 3D PLANNER
import jsPDF from 'jspdf';
import { BOMResult, ConcreteThickness } from '@/types/icf';

interface ProjectParams {
  name: string;
  concreteThickness: ConcreteThickness;
  wallHeightMm: number;
  rebarSpacingCm: number;
  cornerMode: string;
  numberOfRows: number;
}

/**
 * Capture screenshot from Three.js canvas
 */
export async function captureCanvasScreenshot(): Promise<string | null> {
  try {
    const canvas = document.querySelector('canvas');
    if (!canvas) return null;
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch (error) {
    console.error('Error capturing canvas:', error);
    return null;
  }
}

/**
 * Get rebar spacing label
 */
function getRebarLabel(spacing: number): string {
  if (spacing === 20) return '20 cm (Standard)';
  if (spacing === 15) return '15 cm (+1 web extra)';
  if (spacing === 10) return '10 cm (+2 webs extra)';
  return `${spacing} cm`;
}

/**
 * Generate PDF from BOM and project data
 */
export async function generateBOMPDF(
  bom: BOMResult,
  project: ProjectParams,
  canvasScreenshot: string | null
): Promise<void> {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });
  
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  const contentWidth = pageWidth - 2 * margin;
  let y = margin;
  
  // Colors
  const primaryColor: [number, number, number] = [0, 122, 140]; // Teal
  const textColor: [number, number, number] = [30, 30, 30];
  const mutedColor: [number, number, number] = [100, 100, 100];
  
  // Title
  doc.setFillColor(...primaryColor);
  doc.rect(0, 0, pageWidth, 40, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(24);
  doc.setFont('helvetica', 'bold');
  doc.text('OMNI ICF', margin, 25);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.text('WALLS 3D PLANNER', margin + 55, 25);
  
  y = 55;
  
  // Project Name
  doc.setTextColor(...textColor);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text(`Projeto: ${project.name}`, margin, y);
  y += 8;
  
  // Date
  doc.setTextColor(...mutedColor);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  const date = new Date().toLocaleDateString('pt-PT', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  doc.text(`Gerado em: ${date}`, margin, y);
  y += 15;
  
  // Parameters Section
  doc.setTextColor(...primaryColor);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('Parâmetros do Projeto', margin, y);
  y += 8;
  
  doc.setTextColor(...textColor);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  
  const params = [
    ['Núcleo de Betão (tc):', `${project.concreteThickness} mm`],
    ['Altura Total:', `${(project.wallHeightMm / 1000).toFixed(1)} m`],
    ['Número de Fiadas:', `${project.numberOfRows}`],
    ['Espaçamento Ferros:', getRebarLabel(project.rebarSpacingCm)],
    ['Modo Cantos:', project.cornerMode === 'overlap_cut' ? 'Overlap + Corte' : 'Topo'],
    ['Comprimento Total:', `${(bom.totalWallLength / 1000).toFixed(2)} m`]
  ];
  
  params.forEach(([label, value]) => {
    doc.setFont('helvetica', 'bold');
    doc.text(label, margin, y);
    doc.setFont('helvetica', 'normal');
    doc.text(value, margin + 45, y);
    y += 6;
  });
  
  y += 5;
  
  // 3D Screenshot
  if (canvasScreenshot) {
    doc.setTextColor(...primaryColor);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Visualização 3D', margin, y);
    y += 5;
    
    const imgWidth = contentWidth;
    const imgHeight = imgWidth * 0.6;
    
    try {
      doc.addImage(canvasScreenshot, 'JPEG', margin, y, imgWidth, imgHeight);
      y += imgHeight + 10;
    } catch (e) {
      console.error('Error adding image to PDF:', e);
      y += 5;
    }
  }
  
  // Check if we need a new page
  if (y > 200) {
    doc.addPage();
    y = margin;
  }
  
  // BOM Table
  doc.setTextColor(...primaryColor);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('Lista de Materiais (BOM)', margin, y);
  y += 8;
  
  // Table header
  const colWidths = [contentWidth * 0.5, contentWidth * 0.2, contentWidth * 0.3];
  doc.setFillColor(240, 240, 240);
  doc.rect(margin, y - 4, contentWidth, 8, 'F');
  
  doc.setTextColor(...textColor);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text('Item', margin + 2, y);
  doc.text('Qtd', margin + colWidths[0] + 2, y);
  doc.text('Observações', margin + colWidths[0] + colWidths[1] + 2, y);
  y += 8;
  
  // Table rows
  doc.setFont('helvetica', 'normal');
  
  const bomRows = [
    ['Painel Standard 1200x400mm', `${bom.panelsCount} un`, ''],
    ['Webs Distanciadoras', `${bom.websTotal} un`, `${bom.websPerRow} webs/nível`],
    ['Tarugos (Total)', `${bom.tarugosTotal} un`, `Base: ${bom.tarugosBase}, Ajustes: ${bom.tarugosAdjustments}`],
    ['Tarugos de Injeção', `${bom.tarugosInjection} un`, ''],
    [`Topo (${project.concreteThickness}mm)`, `${bom.toposUnits} un`, `${bom.toposMeters.toFixed(2)} m lineares`],
    [`GRID ${project.concreteThickness}mm`, `${bom.gridsTotal} un`, `${bom.gridsPerRow} por fiada × ${bom.gridRows.length} fiadas`],
    ['Cortes', `${bom.cutsCount}`, `${(bom.cutsLengthMm / 1000).toFixed(2)} m total`]
  ];
  
  bomRows.forEach((row, index) => {
    if (index % 2 === 0) {
      doc.setFillColor(248, 248, 248);
      doc.rect(margin, y - 4, contentWidth, 7, 'F');
    }
    
    doc.setTextColor(...textColor);
    doc.text(row[0], margin + 2, y);
    doc.setFont('helvetica', 'bold');
    doc.text(row[1], margin + colWidths[0] + 2, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...mutedColor);
    doc.text(row[2], margin + colWidths[0] + colWidths[1] + 2, y);
    y += 7;
  });
  
  // Footer
  const pageCount = doc.internal.pages.length - 1;
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(...mutedColor);
    doc.text(
      `OMNI ICF WALLS 3D PLANNER | Página ${i} de ${pageCount}`,
      pageWidth / 2,
      doc.internal.pageSize.getHeight() - 10,
      { align: 'center' }
    );
  }
  
  // Save PDF
  const safeName = project.name.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
  const dateStr = new Date().toISOString().split('T')[0];
  doc.save(`omni-icf-${safeName}-${dateStr}.pdf`);
}
