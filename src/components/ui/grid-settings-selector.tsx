import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { Grid3X3 } from 'lucide-react';

export interface GridSettings {
  base: boolean;
  mid: boolean;
  top: boolean;
}

interface GridSettingsSelectorProps {
  value: GridSettings;
  onChange: (value: GridSettings) => void;
  numberOfRows?: number;
  className?: string;
}

export function GridSettingsSelector({ value, onChange, numberOfRows = 7, className }: GridSettingsSelectorProps) {
  const handleChange = (key: keyof GridSettings, checked: boolean) => {
    onChange({ ...value, [key]: checked });
  };

  const getLevelRow = (level: keyof GridSettings): number => {
    if (level === 'base') return 1;
    if (level === 'top') return numberOfRows;
    return Math.ceil(numberOfRows / 2);
  };

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center gap-2">
        <Grid3X3 className="h-4 w-4 text-grid" />
        <Label className="text-sm font-medium">Grelhas de Estabilização</Label>
      </div>
      
      <div className="text-xs text-muted-foreground mb-2">
        Vendidas em unidades de 3m. Selecione os níveis onde aplicar.
      </div>

      <div className="space-y-2">
        {/* Base level - always required */}
        <div className="flex items-center justify-between p-2 rounded-md bg-muted/30">
          <div className="flex items-center gap-2">
            <Switch
              checked={value.base}
              onCheckedChange={(checked) => handleChange('base', checked)}
              disabled={true} // Base is always required
            />
            <span className="text-sm font-medium">Baixo (Base)</span>
          </div>
          <span className="text-xs text-muted-foreground">Fiada {getLevelRow('base')}</span>
        </div>

        {/* Mid level */}
        {numberOfRows > 2 && (
          <div className="flex items-center justify-between p-2 rounded-md bg-muted/30">
            <div className="flex items-center gap-2">
              <Switch
                checked={value.mid}
                onCheckedChange={(checked) => handleChange('mid', checked)}
              />
              <span className="text-sm">Meio</span>
            </div>
            <span className="text-xs text-muted-foreground">Fiada {getLevelRow('mid')}</span>
          </div>
        )}

        {/* Top level */}
        {numberOfRows > 1 && (
          <div className="flex items-center justify-between p-2 rounded-md bg-muted/30">
            <div className="flex items-center gap-2">
              <Switch
                checked={value.top}
                onCheckedChange={(checked) => handleChange('top', checked)}
              />
              <span className="text-sm">Topo</span>
            </div>
            <span className="text-xs text-muted-foreground">Fiada {getLevelRow('top')}</span>
          </div>
        )}
      </div>

      <div className="text-xs text-muted-foreground mt-2">
        Níveis selecionados: {[
          value.base && 'Base',
          value.mid && 'Meio',
          value.top && 'Topo'
        ].filter(Boolean).join(', ') || 'Nenhum'}
      </div>
    </div>
  );
}