import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { WallSegment, ViewerSettings, ViewMode } from '@/types/icf';
import { OpeningData } from '@/types/openings';
import { buildWallChains } from '@/lib/wall-chains';

interface DiagnosticsHUDProps {
  walls: WallSegment[];
  settings: ViewerSettings;
  openings?: OpeningData[];
  panelInstancesCount: number;
}

export function DiagnosticsHUD({ walls, settings, openings = [], panelInstancesCount }: DiagnosticsHUDProps) {
  const chainsResult = useMemo(() => buildWallChains(walls), [walls]);
  const { chains, stats } = chainsResult;
  
  const viewModeLabel: Record<ViewMode, string> = {
    lines: 'Linhas',
    panels: 'Painéis',
    both: 'Ambos'
  };
  
  const hasError = (settings.viewMode === 'panels' || settings.viewMode === 'both') && panelInstancesCount === 0 && chains.length > 0;
  
  return (
    <div className="absolute bottom-20 right-4 z-10 rounded-md bg-background/90 backdrop-blur border border-border px-3 py-2 text-xs font-mono space-y-1 min-w-[180px]">
      <div className="text-muted-foreground font-sans font-medium mb-1">Diagnóstico</div>
      
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
        <span className={panelInstancesCount > 0 ? 'text-green-400' : 'text-red-400'}>{panelInstancesCount}</span>
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">visibleRows:</span>
        <span>{settings.currentRow}/{settings.maxRows}</span>
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">viewMode:</span>
        <span>{viewModeLabel[settings.viewMode]}</span>
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">openings:</span>
        <span className={openings.length > 0 ? 'text-orange-400' : ''}>{openings.length}</span>
      </div>
      
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">scale:</span>
        <span>0.001 (mm→m)</span>
      </div>
      
      {hasError && (
        <div className="flex items-center gap-1 text-red-400 mt-2 pt-2 border-t border-border">
          <AlertTriangle className="h-3 w-3" />
          <span className="text-[10px]">Painéis não gerados</span>
        </div>
      )}
    </div>
  );
}
