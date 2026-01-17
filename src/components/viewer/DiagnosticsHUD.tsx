import { useMemo } from 'react';
import { AlertTriangle, CheckCircle, Info, Scan } from 'lucide-react';
import { WallSegment, ViewerSettings, PANEL_WIDTH, PANEL_HEIGHT } from '@/types/icf';
import { OpeningData, OpeningCandidate, calculateOpeningTopos } from '@/types/openings';
import { buildWallChains } from '@/lib/wall-chains';

interface DiagnosticsHUDProps {
  walls: WallSegment[];
  settings: ViewerSettings;
  openings?: OpeningData[];
  candidates?: OpeningCandidate[];
  panelInstancesCount: number;
}

export function DiagnosticsHUD({ walls, settings, openings = [], candidates = [], panelInstancesCount }: DiagnosticsHUDProps) {
  const chainsResult = useMemo(() => buildWallChains(walls, { detectCandidates: true }), [walls]);
  const { chains, stats, candidates: detectedCandidates } = chainsResult;
  
  const viewModeLabel = {
    lines: 'Linhas',
    panels: 'Painéis',
    both: 'Ambos'
  };
  
  const currentViewMode = settings.viewMode || 'panels';
  
  // Calculate expected panels for current visible rows
  const expectedPanelsForVisibleRows = useMemo(() => {
    if (chains.length === 0) return 0;
    let totalPanels = 0;
    for (let row = 0; row < settings.currentRow; row++) {
      chains.forEach(chain => {
        totalPanels += Math.ceil(chain.lengthMm / PANEL_WIDTH);
      });
    }
    return totalPanels;
  }, [chains, settings.currentRow]);
  
  // Calculate total topos from openings
  const totalOpeningTopos = useMemo(() => {
    return openings.reduce((sum, o) => sum + calculateOpeningTopos(o).units, 0);
  }, [openings]);
  
  const showPanelsActive = currentViewMode === 'panels' || currentViewMode === 'both';
  const hasError = showPanelsActive && panelInstancesCount === 0 && chains.length > 0;
  const isOk = showPanelsActive && panelInstancesCount > 0;
  
  // Combined candidates count (passed + detected)
  const totalCandidates = candidates.length || detectedCandidates.length;
  const hasCandidatesWarning = chains.length > 0 && totalCandidates === 0;
  
  return (
    <div className="absolute bottom-20 right-4 z-10 rounded-md bg-background/95 backdrop-blur border border-border px-3 py-2 text-xs font-mono space-y-1 min-w-[220px] shadow-lg">
      <div className="text-muted-foreground font-sans font-medium mb-2 flex items-center gap-2">
        <Info className="h-3 w-3" />
        Diagnóstico
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">viewMode:</span>
        <span className="text-primary font-medium">{viewModeLabel[currentViewMode as keyof typeof viewModeLabel] || currentViewMode}</span>
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">visibleRows:</span>
        <span>{settings.currentRow}/{settings.maxRows}</span>
      </div>
      
      <div className="border-t border-border my-1 pt-1" />
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">chains:</span>
        <span className="text-cyan-400">{chains.length}</span>
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">totalLen:</span>
        <span>{(stats.totalLengthMm / 1000).toFixed(2)}m</span>
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">panelInstances:</span>
        <span className={panelInstancesCount > 0 ? 'text-green-400' : (showPanelsActive ? 'text-red-400' : 'text-muted-foreground')}>
          {panelInstancesCount}
        </span>
      </div>
      
      {showPanelsActive && (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">expected:</span>
          <span className="text-muted-foreground">~{expectedPanelsForVisibleRows}</span>
        </div>
      )}
      
      <div className="border-t border-border my-1 pt-1" />
      
      {/* CANDIDATES section */}
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground flex items-center gap-1">
          <Scan className="h-3 w-3" />
          candidates:
        </span>
        <span className={totalCandidates > 0 ? 'text-orange-400' : 'text-muted-foreground'}>
          {totalCandidates}
        </span>
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">openings:</span>
        <span className={openings.length > 0 ? 'text-orange-400' : 'text-muted-foreground'}>{openings.length}</span>
      </div>
      
      {openings.length > 0 && (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">topos (aberturas):</span>
          <span className="text-green-600">{totalOpeningTopos}</span>
        </div>
      )}
      
      <div className="border-t border-border my-1 pt-1" />
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">scale:</span>
        <span>0.001 (mm→m)</span>
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">panelSize:</span>
        <span>{PANEL_WIDTH}×{PANEL_HEIGHT}mm</span>
      </div>
      
      {/* Status indicators */}
      {hasError && (
        <div className="flex items-center gap-1 text-red-400 mt-2 pt-2 border-t border-border">
          <AlertTriangle className="h-3 w-3" />
          <span className="text-[10px]">Painéis não gerados - verificar chains</span>
        </div>
      )}
      
      {isOk && (
        <div className="flex items-center gap-1 text-green-400 mt-2 pt-2 border-t border-border">
          <CheckCircle className="h-3 w-3" />
          <span className="text-[10px]">Painéis renderizados OK</span>
        </div>
      )}
      
      {hasCandidatesWarning && (
        <div className="flex items-center gap-1 text-yellow-500 mt-1">
          <AlertTriangle className="h-3 w-3" />
          <span className="text-[10px]">Sem candidatos - ajustar thresholds</span>
        </div>
      )}
    </div>
  );
}
