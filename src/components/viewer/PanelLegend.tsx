// Legend component for 3D viewer panel types
// PERMANENT colors - always visible, not hover-dependent
import { Eye, EyeOff, ToggleLeft, ToggleRight } from 'lucide-react';
import { useState } from 'react';

export type PanelType = 'FULL' | 'CUT_SINGLE' | 'CUT_DOUBLE' | 'CORNER_CUT' | 'TOPO' | 'OPENING_VOID';

interface LegendItem {
  type: PanelType;
  label: string;
  color: string;
  description: string;
  count?: number;
}

const LEGEND_ITEMS: LegendItem[] = [
  { type: 'FULL', label: 'Inteiro', color: '#d4a83a', description: 'Painel 1200mm (amarelo)' },
  { type: 'CUT_SINGLE', label: 'Meio-corte', color: '#7cb342', description: 'Corte 1 lado (verde claro)' },
  { type: 'CUT_DOUBLE', label: 'Corte', color: '#d97734', description: 'Corte 2 lados (laranja)' },
  { type: 'CORNER_CUT', label: 'Canto/Ajuste', color: '#c62828', description: 'Canto desfasado (vermelho)' },
  { type: 'TOPO', label: 'Topos', color: '#2d5a27', description: 'Jambas/lintel/sill (verde escuro)' },
  { type: 'OPENING_VOID', label: 'Vão', color: '#ff6b6b', description: 'Abertura (vermelho translúcido)' },
];

interface PanelLegendProps {
  visible?: boolean;
  onToggle?: () => void;
  showOpenings?: boolean;
  showTopos?: boolean;
  counts?: {
    FULL?: number;
    CUT_SINGLE?: number;
    CUT_DOUBLE?: number;
    CORNER_CUT?: number;
    TOPO?: number;
    OPENING_VOID?: number;
  };
  onVisibilityChange?: (type: PanelType, visible: boolean) => void;
}

export function PanelLegend({ 
  visible = true, 
  onToggle,
  showOpenings = true,
  showTopos = true,
  counts = {},
  onVisibilityChange,
}: PanelLegendProps) {
  const [hiddenTypes, setHiddenTypes] = useState<Set<PanelType>>(new Set());

  const toggleType = (type: PanelType) => {
    const newHidden = new Set(hiddenTypes);
    if (newHidden.has(type)) {
      newHidden.delete(type);
    } else {
      newHidden.add(type);
    }
    setHiddenTypes(newHidden);
    onVisibilityChange?.(type, !newHidden.has(type));
  };

  if (!visible) {
    return (
      <button 
        onClick={onToggle}
        className="absolute top-4 right-4 z-10 flex items-center gap-1 rounded-md bg-background/80 backdrop-blur px-2 py-1 text-xs text-muted-foreground hover:text-foreground border border-border transition-colors"
      >
        <Eye className="h-3 w-3" />
        Legenda
      </button>
    );
  }

  // Filter items based on visibility settings
  const filteredItems = LEGEND_ITEMS.filter(item => {
    if (item.type === 'OPENING_VOID' && !showOpenings) return false;
    if (item.type === 'TOPO' && !showTopos) return false;
    return true;
  });

  // Calculate total panels
  const totalPanels = (counts.FULL || 0) + (counts.CUT_SINGLE || 0) + (counts.CUT_DOUBLE || 0) + (counts.CORNER_CUT || 0);

  return (
    <div className="absolute top-4 right-4 z-10 rounded-md bg-background/95 backdrop-blur border border-border px-3 py-2 text-xs shadow-lg min-w-[200px]">
      <div className="flex items-center justify-between mb-2 pb-1 border-b border-border/50">
        <span className="font-semibold text-foreground">Legenda de Cores</span>
        {onToggle && (
          <button 
            onClick={onToggle}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <EyeOff className="h-3 w-3" />
          </button>
        )}
      </div>
      
      <div className="space-y-1.5">
        {filteredItems.map((item) => {
          const count = counts[item.type];
          const isHidden = hiddenTypes.has(item.type);
          
          return (
            <div 
              key={item.type} 
              className={`flex items-center gap-2 ${isHidden ? 'opacity-40' : ''}`}
            >
              <div 
                className="w-5 h-4 rounded-sm border border-border/50 flex-shrink-0" 
                style={{ 
                  backgroundColor: item.color,
                  opacity: item.type === 'OPENING_VOID' ? 0.5 : 1,
                }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <span className="text-foreground font-medium">{item.label}</span>
                  {count !== undefined && count > 0 && (
                    <span className="text-muted-foreground">({count})</span>
                  )}
                </div>
                <span className="text-muted-foreground text-[10px] block truncate">
                  {item.description}
                </span>
              </div>
              {/* Toggle visibility (optional feature) */}
              {onVisibilityChange && (
                <button
                  onClick={() => toggleType(item.type)}
                  className="flex-shrink-0 text-muted-foreground hover:text-foreground"
                >
                  {isHidden ? (
                    <ToggleLeft className="h-4 w-4" />
                  ) : (
                    <ToggleRight className="h-4 w-4" />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Summary */}
      {totalPanels > 0 && (
        <div className="mt-2 pt-1.5 border-t border-border/50 text-muted-foreground">
          <div className="flex justify-between">
            <span>Total painéis:</span>
            <span className="font-medium text-foreground">{totalPanels}</span>
          </div>
        </div>
      )}
    </div>
  );
}
