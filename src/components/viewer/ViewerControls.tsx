import { Layers, Maximize2, RotateCcw, Eye, Grid3X3, Square, GitBranch, Palette, FileText, Hexagon, BarChart, Box, Columns } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { ViewerSettings, ConcreteThickness } from '@/types/icf';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Switch } from '@/components/ui/switch';
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

  const toggleSetting = (key: keyof ViewerSettings) => {
    onSettingsChange({
      ...settings,
      [key]: !settings[key]
    });
  };

  // Toggle all corner node related settings together
  const toggleCornerNodes = () => {
    const newValue = !settings.showCornerNodes;
    onSettingsChange({
      ...settings,
      showCornerNodes: newValue,
      showCornerNodeLabels: newValue,
      showCornerNodeWires: newValue,
    });
  };
  
  return (
    <div className="toolbar absolute bottom-4 left-4 right-4 flex flex-wrap justify-between gap-2">
      {/* Left side - Thickness selector + Visibility */}
      <div className="flex items-center gap-3">
        {/* Visibility Popover */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2">
              <Eye className="h-4 w-4" />
              <span className="text-xs">Visibilidade</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent 
            className="w-72 bg-background border border-border shadow-lg z-50" 
            align="start"
            sideOffset={8}
          >
            <div className="space-y-3">
              <h4 className="font-medium text-sm text-foreground border-b border-border pb-2">
                Visibilidade
              </h4>
              
              {/* Grid toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Grid3X3 className="h-4 w-4 text-muted-foreground" />
                  <Label htmlFor="show-grid" className="text-sm cursor-pointer">
                    Grelha base
                  </Label>
                </div>
                <Switch
                  id="show-grid"
                  checked={settings.showGrid}
                  onCheckedChange={() => toggleSetting('showGrid')}
                />
              </div>

              {/* Outlines toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Square className="h-4 w-4 text-muted-foreground" />
                  <Label htmlFor="show-outlines" className="text-sm cursor-pointer">
                    Contornos painéis
                  </Label>
                </div>
                <Switch
                  id="show-outlines"
                  checked={settings.showOutlines}
                  onCheckedChange={() => toggleSetting('showOutlines')}
                />
              </div>

              {/* Corner nodes + labels + wires toggle (combined) */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <GitBranch className="h-4 w-4 text-muted-foreground" />
                  <Label htmlFor="show-nodes" className="text-sm cursor-pointer">
                    Nós + Labels + Fios
                  </Label>
                </div>
                <Switch
                  id="show-nodes"
                  checked={settings.showCornerNodes}
                  onCheckedChange={toggleCornerNodes}
                />
              </div>

              {/* EXT/INT stripes toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Palette className="h-4 w-4 text-muted-foreground" />
                  <Label htmlFor="show-stripes" className="text-sm cursor-pointer">
                    Faixa EXT/INT
                  </Label>
                </div>
                <Switch
                  id="show-stripes"
                  checked={settings.showSideStripes}
                  onCheckedChange={() => toggleSetting('showSideStripes')}
                />
              </div>

              {/* DXF Lines toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <Label htmlFor="show-dxf" className="text-sm cursor-pointer">
                    Linhas DXF
                  </Label>
                </div>
                <Switch
                  id="show-dxf"
                  checked={settings.showDXFLines}
                  onCheckedChange={() => toggleSetting('showDXFLines')}
                />
              </div>

              {/* Panel Side Visibility Section */}
              <div className="border-t border-border my-1 pt-2">
                <h5 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                  <Box className="h-3 w-3" />
                  Painéis por Tipo
                </h5>
              </div>

              {/* Exterior panels toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Columns className="h-4 w-4 text-blue-400" />
                  <Label htmlFor="show-exterior" className="text-sm cursor-pointer">
                    Exteriores (azul)
                  </Label>
                </div>
                <Switch
                  id="show-exterior"
                  checked={settings.showExteriorPanels}
                  onCheckedChange={() => toggleSetting('showExteriorPanels')}
                />
              </div>

              {/* Interior panels toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Columns className="h-4 w-4 text-white" />
                  <Label htmlFor="show-interior" className="text-sm cursor-pointer">
                    Interiores (branco)
                  </Label>
                </div>
                <Switch
                  id="show-interior"
                  checked={settings.showInteriorPanels}
                  onCheckedChange={() => toggleSetting('showInteriorPanels')}
                />
              </div>

              {/* Partition panels toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Columns className="h-4 w-4 text-purple-400" />
                  <Label htmlFor="show-partition" className="text-sm cursor-pointer">
                    Partições (internos)
                  </Label>
                </div>
                <Switch
                  id="show-partition"
                  checked={settings.showPartitionPanels}
                  onCheckedChange={() => toggleSetting('showPartitionPanels')}
                />
              </div>

              {/* Unknown/Unresolved panels toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Columns className="h-4 w-4 text-orange-400" />
                  <Label htmlFor="show-unknown" className="text-sm cursor-pointer">
                    Não resolvidos
                  </Label>
                </div>
                <Switch
                  id="show-unknown"
                  checked={settings.showUnknownPanels}
                  onCheckedChange={() => toggleSetting('showUnknownPanels')}
                />
              </div>

              {/* Debug Footprint Section */}
              <div className="border-t border-border my-1 pt-2">
                <h5 className="text-xs font-medium text-muted-foreground mb-2">Debug Footprint</h5>
              </div>

              {/* Footprint toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Hexagon className="h-4 w-4 text-muted-foreground" />
                  <Label htmlFor="show-footprint" className="text-sm cursor-pointer">
                    Mostrar Footprint
                  </Label>
                </div>
                <Switch
                  id="show-footprint"
                  checked={settings.showFootprint}
                  onCheckedChange={() => toggleSetting('showFootprint')}
                />
              </div>

              {/* Stats toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <BarChart className="h-4 w-4 text-muted-foreground" />
                  <Label htmlFor="show-stats" className="text-sm cursor-pointer">
                    Stats Classificação
                  </Label>
                </div>
                <Switch
                  id="show-stats"
                  checked={settings.showFootprintStats}
                  onCheckedChange={() => toggleSetting('showFootprintStats')}
                />
              </div>

              {/* Highlight unresolved toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Columns className="h-4 w-4 text-orange-400" />
                  <Label htmlFor="highlight-unresolved" className="text-sm cursor-pointer">
                    Destacar Não Resolvidas
                  </Label>
                </div>
                <Switch
                  id="highlight-unresolved"
                  checked={settings.highlightUnresolved}
                  onCheckedChange={() => toggleSetting('highlightUnresolved')}
                />
              </div>

              {/* Outside footprint toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Columns className="h-4 w-4 text-yellow-400" />
                  <Label htmlFor="show-outside-footprint" className="text-sm cursor-pointer">
                    Fora do footprint
                  </Label>
                </div>
                <Switch
                  id="show-outside-footprint"
                  checked={settings.showOutsideFootprint}
                  onCheckedChange={() => toggleSetting('showOutsideFootprint')}
                />
              </div>
            </div>
          </PopoverContent>
        </Popover>

        {/* Thickness selector */}
        <Label className="text-xs text-muted-foreground">tc:</Label>
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
