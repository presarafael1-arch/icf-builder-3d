// Legend component for 3D viewer panel types
import { Eye, EyeOff } from 'lucide-react';

interface LegendItem {
  label: string;
  color: string;
  description?: string;
}

const LEGEND_ITEMS: LegendItem[] = [
  { label: 'Painel Normal', color: '#d4a83a', description: 'Fiadas pares' },
  { label: 'Painel Stagger', color: '#c9a846', description: 'Fiadas ímpares (offset 600mm)' },
  { label: 'Painel Cortado', color: '#d97734', description: 'Corte no fim/início' },
  { label: 'Abertura', color: '#ff6b6b', description: 'Porta/Janela' },
  { label: 'Topo', color: '#2d5a27', description: 'Lateral de abertura' },
];

interface PanelLegendProps {
  visible?: boolean;
  onToggle?: () => void;
  showOpenings?: boolean;
  showTopos?: boolean;
}

export function PanelLegend({ 
  visible = true, 
  onToggle,
  showOpenings = true,
  showTopos = true,
}: PanelLegendProps) {
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
    if (item.label === 'Abertura' && !showOpenings) return false;
    if (item.label === 'Topo' && !showTopos) return false;
    return true;
  });

  return (
    <div className="absolute top-4 right-4 z-10 rounded-md bg-background/95 backdrop-blur border border-border px-3 py-2 text-xs shadow-lg min-w-[180px]">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-foreground">Legenda</span>
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
        {filteredItems.map((item) => (
          <div key={item.label} className="flex items-center gap-2">
            <div 
              className="w-4 h-3 rounded-sm border border-border/50" 
              style={{ backgroundColor: item.color }}
            />
            <div className="flex-1">
              <span className="text-foreground">{item.label}</span>
              {item.description && (
                <span className="text-muted-foreground ml-1">- {item.description}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
