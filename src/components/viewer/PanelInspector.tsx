/**
 * Panel Inspector Component
 * 
 * Shows detailed panel information and allows override editing
 */

import { useState } from 'react';
import { X, Lock, Unlock, RefreshCw, AlertTriangle, Check, Trash2 } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from '@/components/ui/select';
import { 
  ExtendedPanelData, 
  PanelOverride, 
  OverrideConflict,
  CoreConcreteMm,
  getTopoType
} from '@/types/panel-selection';
import { PanelType } from '@/lib/panel-layout';
import { TOOTH } from '@/types/icf';
import { PANEL_COLORS } from '@/components/viewer/ICFViewer3D';

interface PanelInspectorProps {
  isOpen: boolean;
  onClose: () => void;
  panelData: ExtendedPanelData | null;
  override: PanelOverride | undefined;
  conflicts: OverrideConflict[];
  coreConcreteMm: CoreConcreteMm;
  onSetOverride: (override: PanelOverride) => void;
  onRemoveOverride: (panelId: string) => void;
  onLockPanel: (panelId: string) => void;
  onUnlockPanel: (panelId: string) => void;
}

const PANEL_TYPE_LABELS: Record<PanelType, string> = {
  FULL: 'Inteiro (Amarelo)',
  CUT_SINGLE: 'Corte Simples (Verde)',
  CUT_DOUBLE: 'Corte Meio (Laranja)',
  CORNER_CUT: 'Arranque Canto (Vermelho)',
  TOPO: 'Topo (Verde Escuro)',
  END_CUT: 'Corte Terminação (Laranja)',
};

export function PanelInspector({
  isOpen,
  onClose,
  panelData,
  override,
  conflicts,
  coreConcreteMm,
  onSetOverride,
  onRemoveOverride,
  onLockPanel,
  onUnlockPanel,
}: PanelInspectorProps) {
  const [editType, setEditType] = useState<PanelType | 'auto'>('auto');
  const [editCut, setEditCut] = useState<string>('');
  const [editAnchor, setEditAnchor] = useState<string>('auto');
  
  // Reset form when panel changes
  const resetForm = () => {
    setEditType('auto');
    setEditCut('');
    setEditAnchor('auto');
  };
  
  const handleApplyOverride = () => {
    if (!panelData) return;
    
    const newOverride: PanelOverride = {
      panelId: panelData.panelId,
      isLocked: override?.isLocked ?? false,
      createdAt: override?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    if (editType !== 'auto') {
      newOverride.overrideType = editType;
    }
    
    if (editCut && !isNaN(parseFloat(editCut))) {
      newOverride.cutMm = parseFloat(editCut);
    }
    
    if (editAnchor !== 'auto') {
      newOverride.anchorOverride = editAnchor as PanelOverride['anchorOverride'];
    }
    
    onSetOverride(newOverride);
  };
  
  const handleRemoveOverride = () => {
    if (!panelData) return;
    onRemoveOverride(panelData.panelId);
    resetForm();
  };
  
  const handleToggleLock = () => {
    if (!panelData) return;
    if (override?.isLocked) {
      onUnlockPanel(panelData.panelId);
    } else {
      onLockPanel(panelData.panelId);
    }
  };
  
  const panelConflicts = conflicts.filter(c => c.panelId === panelData?.panelId);
  
  if (!panelData) {
    return (
      <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <SheetContent className="w-[400px] sm:w-[540px]">
          <SheetHeader>
            <SheetTitle>Inspetor de Painel</SheetTitle>
          </SheetHeader>
          <div className="flex items-center justify-center h-48 text-muted-foreground">
            Clique num painel para inspecionar
          </div>
        </SheetContent>
      </Sheet>
    );
  }
  
  const typeColor = PANEL_COLORS[panelData.type] || '#666';
  
  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-[400px] sm:w-[540px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <div 
              className="w-4 h-4 rounded-sm border" 
              style={{ backgroundColor: typeColor }}
            />
            Inspetor de Painel
            {override?.isLocked && (
              <Badge variant="secondary" className="ml-auto">
                <Lock className="h-3 w-3 mr-1" />
                Bloqueado
              </Badge>
            )}
          </SheetTitle>
        </SheetHeader>
        
        <div className="space-y-4 mt-4">
          {/* Panel ID */}
          <div>
            <Label className="text-xs text-muted-foreground">ID do Painel</Label>
            <code className="block text-xs bg-muted p-2 rounded-md font-mono break-all">
              {panelData.panelId}
            </code>
          </div>
          
          {/* Conflicts */}
          {panelConflicts.length > 0 && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {panelConflicts.map((c, i) => (
                  <div key={i}>{c.message}</div>
                ))}
              </AlertDescription>
            </Alert>
          )}
          
          <Separator />
          
          {/* Current State */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <Label className="text-xs text-muted-foreground">Tipo Atual</Label>
              <div className="flex items-center gap-2">
                <div 
                  className="w-3 h-3 rounded-sm" 
                  style={{ backgroundColor: typeColor }}
                />
                <span className="font-medium">{PANEL_TYPE_LABELS[panelData.type]}</span>
              </div>
            </div>
            
            <div>
              <Label className="text-xs text-muted-foreground">Largura</Label>
              <span className="font-mono">{panelData.widthMm.toFixed(1)} mm</span>
            </div>
            
            <div>
              <Label className="text-xs text-muted-foreground">Posição (início)</Label>
              <span className="font-mono">{panelData.startMm.toFixed(1)} mm</span>
            </div>
            
            <div>
              <Label className="text-xs text-muted-foreground">Posição (fim)</Label>
              <span className="font-mono">{panelData.endMm.toFixed(1)} mm</span>
            </div>
            
            <div>
              <Label className="text-xs text-muted-foreground">Fiada</Label>
              <span className="font-mono">{panelData.rowIndex + 1} (índice {panelData.rowIndex})</span>
            </div>
            
            <div>
              <Label className="text-xs text-muted-foreground">Paridade</Label>
              <Badge variant="outline">Fiada {panelData.rowParity}</Badge>
            </div>
            
            <div>
              <Label className="text-xs text-muted-foreground">Corte Esq.</Label>
              <span className="font-mono">{panelData.cutLeftMm.toFixed(1)} mm</span>
            </div>
            
            <div>
              <Label className="text-xs text-muted-foreground">Corte Dir.</Label>
              <span className="font-mono">{panelData.cutRightMm.toFixed(1)} mm</span>
            </div>
          </div>
          
          <Separator />
          
          {/* Context */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Contexto</Label>
            
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <Label className="text-xs text-muted-foreground">Chain ID</Label>
                <code className="text-xs font-mono">{panelData.chainId.slice(0, 8)}...</code>
              </div>
              
              <div>
                <Label className="text-xs text-muted-foreground">Seed Origin</Label>
                <Badge variant="secondary">{panelData.seedOrigin}</Badge>
              </div>
              
              <div>
                <Label className="text-xs text-muted-foreground">Nó Mais Próximo</Label>
                <span>{panelData.nearestNodeType || 'Nenhum'}</span>
              </div>
              
              <div>
                <Label className="text-xs text-muted-foreground">Distância ao Nó</Label>
                <span className="font-mono">{panelData.distanceToNodeMm.toFixed(0)} mm</span>
              </div>
              
              <div>
                <Label className="text-xs text-muted-foreground">Posição no Run</Label>
                <Badge variant="outline">{panelData.position}</Badge>
              </div>
              
              <div>
                <Label className="text-xs text-muted-foreground">Lado</Label>
                <span>{panelData.side}</span>
              </div>
            </div>
            
            <div>
              <Label className="text-xs text-muted-foreground">Regra Aplicada</Label>
              <p className="text-sm text-muted-foreground italic">{panelData.ruleApplied}</p>
            </div>
          </div>
          
          <Separator />
          
          {/* Thickness */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <Label className="text-xs text-muted-foreground">Betão (core)</Label>
              <span className="font-mono font-bold">{panelData.coreConcreteMm} mm</span>
            </div>
            
            <div>
              <Label className="text-xs text-muted-foreground">Parede (exterior)</Label>
              <span className="font-mono">{panelData.wallOuterThicknessMm} mm</span>
            </div>
            
            {panelData.topoType && (
              <div className="col-span-2">
                <Label className="text-xs text-muted-foreground">Tipo de Topo</Label>
                <Badge variant="default" className="bg-green-700">
                  {panelData.topoType}
                </Badge>
              </div>
            )}
          </div>
          
          <Separator />
          
          {/* Override Controls */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">Overrides</Label>
            
            {override && (
              <Alert>
                <Check className="h-4 w-4" />
                <AlertDescription>
                  Este painel tem override ativo
                  {override.overrideType && ` (tipo: ${PANEL_TYPE_LABELS[override.overrideType]})`}
                </AlertDescription>
              </Alert>
            )}
            
            {/* Type override */}
            <div>
              <Label>Tipo</Label>
              <Select 
                value={editType} 
                onValueChange={(v) => setEditType(v as PanelType | 'auto')}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Automático" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Automático</SelectItem>
                  <SelectItem value="FULL">Inteiro (Amarelo)</SelectItem>
                  <SelectItem value="CORNER_CUT">Arranque Canto (Vermelho)</SelectItem>
                  <SelectItem value="CUT_DOUBLE">Corte Meio (Laranja)</SelectItem>
                  <SelectItem value="TOPO">Topo ({getTopoType(coreConcreteMm)})</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            {/* Cut override */}
            <div>
              <Label>Corte (mm)</Label>
              <div className="flex gap-2">
                <Input 
                  type="number"
                  step={TOOTH}
                  placeholder={`Múltiplo de ${TOOTH.toFixed(1)}`}
                  value={editCut}
                  onChange={(e) => setEditCut(e.target.value)}
                />
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => setEditCut(TOOTH.toFixed(2))}
                >
                  1×TOOTH
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                TOOTH = {TOOTH.toFixed(2)} mm
              </p>
            </div>
            
            {/* Anchor override */}
            <div>
              <Label>Ancoragem</Label>
              <Select 
                value={editAnchor} 
                onValueChange={setEditAnchor}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Automático" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Automático</SelectItem>
                  <SelectItem value="center_on_node">Centrar no Eixo do Nó</SelectItem>
                  <SelectItem value="first_after_node">Primeiro Após Nó</SelectItem>
                  <SelectItem value="last_before_node">Último Antes do Nó</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            {/* Action buttons */}
            <div className="flex gap-2 pt-2">
              <Button onClick={handleApplyOverride} className="flex-1">
                <Check className="h-4 w-4 mr-2" />
                Aplicar Override
              </Button>
              
              <Button 
                variant="outline" 
                onClick={handleToggleLock}
              >
                {override?.isLocked ? (
                  <><Unlock className="h-4 w-4 mr-2" />Desbloquear</>
                ) : (
                  <><Lock className="h-4 w-4 mr-2" />Bloquear</>
                )}
              </Button>
            </div>
            
            {override && (
              <Button 
                variant="destructive" 
                className="w-full"
                onClick={handleRemoveOverride}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Remover Override
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
