import { Box, Eye, Grid3X3, Layers, Maximize2, RotateCcw, PanelTop, Minus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ViewerSettings, ViewMode, RebarSpacing } from '@/types/icf';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

interface ViewerControlsProps {
  settings: ViewerSettings;
  onSettingsChange: (settings: ViewerSettings) => void;
  onReset?: () => void;
  onFitView?: () => void;
}

const VIEW_MODE_OPTIONS: { value: ViewMode; label: string; icon: React.ReactNode }[] = [
  { value: 'lines', label: 'Linhas', icon: <Minus className="h-3 w-3" /> },
  { value: 'panels', label: 'Painéis', icon: <PanelTop className="h-3 w-3" /> },
  { value: 'both', label: 'Ambos', icon: <Layers className="h-3 w-3" /> },
];

const REBAR_SPACING_OPTIONS: { value: RebarSpacing; label: string; description: string }[] = [
  { value: 20, label: '20 cm', description: 'Standard' },
  { value: 15, label: '15 cm', description: '+1 web' },
  { value: 10, label: '10 cm', description: '+2 webs' },
];

export function ViewerControls({ settings, onSettingsChange, onReset, onFitView }: ViewerControlsProps) {
  const toggleSetting = (key: keyof ViewerSettings) => {
    if (typeof settings[key] === 'boolean') {
      onSettingsChange({
        ...settings,
        [key]: !settings[key]
      });
    }
  };
  
  const handleViewModeChange = (value: string) => {
    if (value) {
      const viewMode = value as ViewMode;
      // Update derived settings based on view mode
      const showPanels = viewMode === 'panels' || viewMode === 'both';
      const showChains = viewMode === 'lines' || viewMode === 'both';
      const showDXFLines = viewMode === 'lines';
      
      onSettingsChange({
        ...settings,
        viewMode,
        showPanels,
        showChains,
        showDXFLines
      });
    }
  };
  
  const handleRebarSpacingChange = (value: string) => {
    if (value) {
      onSettingsChange({
        ...settings,
        rebarSpacing: parseInt(value) as RebarSpacing
      });
    }
  };
  
  return (
    <div className="toolbar absolute bottom-4 left-4 right-4 flex flex-wrap justify-between gap-2">
      {/* Left side - View Mode + toggles */}
      <div className="flex items-center gap-2">
        {/* View Mode Toggle */}
        <ToggleGroup 
          type="single" 
          value={settings.viewMode} 
          onValueChange={handleViewModeChange}
          className="bg-muted/50 rounded-md p-0.5"
        >
          {VIEW_MODE_OPTIONS.map(opt => (
            <ToggleGroupItem 
              key={opt.value} 
              value={opt.value} 
              className="gap-1 text-xs px-2 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
              title={opt.label}
            >
              {opt.icon}
              <span className="hidden sm:inline">{opt.label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="secondary" size="sm" className="gap-2">
              <Eye className="h-4 w-4" />
              <span className="hidden sm:inline">Visibilidade</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72" align="start">
            <div className="space-y-4">
              <h4 className="text-sm font-medium">Camadas Visíveis</h4>
              
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="show-chains" className="text-sm font-medium text-cyan-400">Cadeias (chains)</Label>
                  <Switch
                    id="show-chains"
                    checked={settings.showChains}
                    onCheckedChange={() => toggleSetting('showChains')}
                  />
                </div>
                
                <div className="flex items-center justify-between">
                  <Label htmlFor="show-dxf-lines" className="text-sm text-muted-foreground">Segmentos (debug)</Label>
                  <Switch
                    id="show-dxf-lines"
                    checked={settings.showDXFLines}
                    onCheckedChange={() => toggleSetting('showDXFLines')}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <Label htmlFor="show-helpers" className="text-sm text-muted-foreground">Helpers (eixos/bbox)</Label>
                  <Switch
                    id="show-helpers"
                    checked={settings.showHelpers}
                    onCheckedChange={() => toggleSetting('showHelpers')}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <Label htmlFor="show-panels" className="text-sm">Painéis</Label>
                  <Switch
                    id="show-panels"
                    checked={settings.showPanels}
                    onCheckedChange={() => toggleSetting('showPanels')}
                  />
                </div>
                
                <div className="flex items-center justify-between">
                  <Label htmlFor="show-topos" className="text-sm">Topos</Label>
                  <Switch
                    id="show-topos"
                    checked={settings.showTopos}
                    onCheckedChange={() => toggleSetting('showTopos')}
                  />
                </div>
                
                <div className="flex items-center justify-between">
                  <Label htmlFor="show-openings" className="text-sm text-orange-400">Aberturas</Label>
                  <Switch
                    id="show-openings"
                    checked={settings.showOpenings}
                    onCheckedChange={() => toggleSetting('showOpenings')}
                  />
                </div>
                
                <div className="flex items-center justify-between">
                  <Label htmlFor="show-webs" className="text-sm">Webs</Label>
                  <Switch
                    id="show-webs"
                    checked={settings.showWebs}
                    onCheckedChange={() => toggleSetting('showWebs')}
                  />
                </div>
                
                <div className="flex items-center justify-between">
                  <Label htmlFor="show-grids" className="text-sm text-red-400">Grids (Estabilização)</Label>
                  <Switch
                    id="show-grids"
                    checked={settings.showGrids}
                    onCheckedChange={() => toggleSetting('showGrids')}
                  />
                </div>
                
                <div className="flex items-center justify-between">
                  <Label htmlFor="show-junctions" className="text-sm">Nós</Label>
                  <Switch
                    id="show-junctions"
                    checked={settings.showJunctions}
                    onCheckedChange={() => toggleSetting('showJunctions')}
                  />
                </div>
                
                <div className="flex items-center justify-between">
                  <Label htmlFor="show-grid" className="text-sm">Grelha Base</Label>
                  <Switch
                    id="show-grid"
                    checked={settings.showGrid}
                    onCheckedChange={() => toggleSetting('showGrid')}
                  />
                </div>
                
                <div className="flex items-center justify-between">
                  <Label htmlFor="wireframe" className="text-sm">Wireframe</Label>
                  <Switch
                    id="wireframe"
                    checked={settings.wireframe}
                    onCheckedChange={() => toggleSetting('wireframe')}
                  />
                </div>
              </div>
              
              {/* Rebar Spacing Selector */}
              <div className="pt-3 border-t border-border">
                <Label className="text-sm font-medium mb-2 block">Espaçamento Webs</Label>
                <ToggleGroup 
                  type="single" 
                  value={String(settings.rebarSpacing)} 
                  onValueChange={handleRebarSpacingChange}
                  className="grid grid-cols-3 gap-1"
                >
                  {REBAR_SPACING_OPTIONS.map(opt => (
                    <ToggleGroupItem 
                      key={opt.value} 
                      value={String(opt.value)} 
                      className="flex-col h-auto py-2 text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                    >
                      <span className="font-medium">{opt.label}</span>
                      <span className="text-[10px] opacity-70">{opt.description}</span>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            </div>
          </PopoverContent>
        </Popover>
        
        <Button 
          variant="ghost" 
          size="icon"
          onClick={() => toggleSetting('showGrid')}
          className={settings.showGrid ? 'bg-primary/20 text-primary' : ''}
          title="Grelha Base"
        >
          <Grid3X3 className="h-4 w-4" />
        </Button>
        
        <Button 
          variant="ghost" 
          size="icon"
          onClick={() => toggleSetting('wireframe')}
          className={settings.wireframe ? 'bg-primary/20 text-primary' : ''}
          title="Wireframe"
        >
          <Box className="h-4 w-4" />
        </Button>
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
