import { Layers, Maximize2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { ViewerSettings, ConcreteThickness } from '@/types/icf';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

interface ViewerControlsProps {
  settings: ViewerSettings;
  onSettingsChange: (settings: ViewerSettings) => void;
  onReset?: () => void;
  onFitView?: () => void;
}

const THICKNESS_OPTIONS: { value: ConcreteThickness; label: string }[] = [
  { value: '150', label: '150mm' },
  { value: '220', label: '220mm' },
];

export function ViewerControls({ settings, onSettingsChange, onReset, onFitView }: ViewerControlsProps) {
  const handleThicknessChange = (value: string) => {
    if (value) {
      onSettingsChange({
        ...settings,
        concreteThickness: value as ConcreteThickness
      });
    }
  };
  
  return (
    <div className="toolbar absolute bottom-4 left-4 right-4 flex flex-wrap justify-between gap-2">
      {/* Left side - Thickness selector */}
      <div className="flex items-center gap-3">
        <Label className="text-xs text-muted-foreground">Espessura (tc):</Label>
        <ToggleGroup 
          type="single" 
          value={settings.concreteThickness} 
          onValueChange={handleThicknessChange}
          className="bg-muted/50 rounded-md p-0.5"
        >
          {THICKNESS_OPTIONS.map(opt => (
            <ToggleGroupItem 
              key={opt.value} 
              value={opt.value} 
              className="text-xs px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
            >
              {opt.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      
      {/* Center - Row slider */}
      <div className="flex items-center gap-4 flex-1 max-w-md mx-4">
        <Layers className="h-4 w-4 text-muted-foreground" />
        <div className="flex-1">
          <Slider
            value={[settings.currentRow]}
            min={1}
            max={settings.maxRows}
            step={1}
            onValueChange={([value]) => onSettingsChange({ ...settings, currentRow: value })}
            className="cursor-pointer"
          />
        </div>
        <span className="text-sm font-mono text-muted-foreground min-w-[4rem] text-right">
          {settings.currentRow}/{settings.maxRows} fiadas
        </span>
      </div>
      
      {/* Right side - Actions */}
      <div className="flex items-center gap-2">
        {onReset && (
          <Button variant="ghost" size="icon" onClick={onReset} title="Reset">
            <RotateCcw className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          title="Enquadrar / Fit View"
          onClick={onFitView}
          disabled={!onFitView}
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
