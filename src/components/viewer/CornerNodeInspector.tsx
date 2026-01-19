/**
 * Corner Node Inspector Component
 * 
 * Shows controls for the currently selected corner node (NÓ EXT or NÓ INT)
 * Allows adjusting X/Y offset in ½ TOOTH steps
 */

import { RefreshCw, Crosshair, ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { TOOTH, CornerNodeOffset } from '@/types/icf';

interface CornerNodeInspectorProps {
  isOpen: boolean;
  onClose: () => void;
  selectedNodeId: string | null;
  nodeOffsets: Map<string, CornerNodeOffset>;
  onUpdateOffset: (nodeId: string, offsetX: number, offsetY: number) => void;
  onResetOffset: (nodeId: string) => void;
}

export function CornerNodeInspector({
  isOpen,
  onClose,
  selectedNodeId,
  nodeOffsets,
  onUpdateOffset,
  onResetOffset,
}: CornerNodeInspectorProps) {
  
  // Parse node ID to get type (ext/int) and junction info
  const parseNodeId = (nodeId: string) => {
    // Format: "node-{junctionId}-ext" or "node-{junctionId}-int"
    const parts = nodeId.split('-');
    const type = parts[parts.length - 1] as 'ext' | 'int';
    const junctionId = parts.slice(1, -1).join('-');
    return { type, junctionId };
  };
  
  // Get current offset for selected node
  const currentOffset = selectedNodeId ? nodeOffsets.get(selectedNodeId) : undefined;
  const offsetX = currentOffset?.offsetX ?? 0;
  const offsetY = currentOffset?.offsetY ?? 0;
  
  // Parse selected node
  const parsedNode = selectedNodeId ? parseNodeId(selectedNodeId) : null;
  const isExterior = parsedNode?.type === 'ext';
  const nodeLabel = isExterior ? 'NÓ EXT' : 'NÓ INT';
  const nodeColor = isExterior ? 'text-red-400' : 'text-yellow-400';
  const nodeBgColor = isExterior ? 'bg-red-500/10 border-red-500/30' : 'bg-yellow-500/10 border-yellow-500/30';
  
  // Half TOOTH step
  const HALF_TOOTH = 0.5;
  
  // Adjust offset
  const adjustOffset = (axis: 'x' | 'y', delta: number) => {
    if (!selectedNodeId) return;
    const newX = axis === 'x' ? Math.round((offsetX + delta) * 10) / 10 : offsetX;
    const newY = axis === 'y' ? Math.round((offsetY + delta) * 10) / 10 : offsetY;
    onUpdateOffset(selectedNodeId, newX, newY);
  };
  
  // Set offset directly
  const setOffset = (axis: 'x' | 'y', value: number) => {
    if (!selectedNodeId) return;
    const newX = axis === 'x' ? value : offsetX;
    const newY = axis === 'y' ? value : offsetY;
    onUpdateOffset(selectedNodeId, newX, newY);
  };
  
  if (!selectedNodeId) {
    return (
      <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <SheetContent className="w-[400px] sm:w-[540px]">
          <SheetHeader>
            <SheetTitle>Inspetor de Nó de Canto</SheetTitle>
          </SheetHeader>
          <div className="flex items-center justify-center h-48 text-muted-foreground">
            <div className="text-center">
              <Crosshair className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">Clique num nó de canto para inspecionar</p>
              <p className="text-xs text-muted-foreground mt-1">
                NÓ EXT (vermelho) ou NÓ INT (amarelo)
              </p>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    );
  }
  
  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-[400px] sm:w-[540px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <div 
              className={`w-4 h-4 rounded-full border-2 ${isExterior ? 'bg-red-500 border-red-300' : 'bg-yellow-500 border-yellow-300'}`}
            />
            Inspetor de Nó
            <Badge variant="secondary" className={`ml-auto ${nodeColor}`}>
              {nodeLabel}
            </Badge>
          </SheetTitle>
        </SheetHeader>
        
        <div className="space-y-4 mt-4">
          {/* Node ID */}
          <div>
            <Label className="text-xs text-muted-foreground">ID do Nó</Label>
            <code className="block text-xs bg-muted p-2 rounded-md font-mono break-all">
              {selectedNodeId}
            </code>
          </div>
          
          <Separator />
          
          {/* === OFFSET CONTROLS === */}
          <div className={`space-y-4 p-4 rounded-lg border ${nodeBgColor}`}>
            <div className="flex items-center gap-2">
              <Crosshair className={`h-4 w-4 ${nodeColor}`} />
              <Label className={`text-sm font-medium ${nodeColor}`}>Posição do Nó</Label>
              <span className="text-xs text-muted-foreground ml-auto">½T = {(TOOTH / 2).toFixed(1)}mm</span>
            </div>
            
            <p className="text-xs text-muted-foreground">
              Ajusta a posição em passos de ½ TOOTH. O "fio" e etiqueta movem-se em conjunto.
            </p>
            
            {/* X Offset */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className={`text-sm font-medium ${nodeColor}`}>Offset X</Label>
                <span className="text-sm font-mono font-bold">
                  {offsetX >= 0 ? '+' : ''}{offsetX.toFixed(1)}T
                  <span className="text-xs text-muted-foreground ml-1">
                    ({(offsetX * TOOTH).toFixed(1)}mm)
                  </span>
                </span>
              </div>
              
              {/* Step buttons */}
              <div className="flex items-center gap-2">
                <Button 
                  variant="outline" 
                  size="sm"
                  className="flex-1 h-9"
                  onClick={() => adjustOffset('x', -HALF_TOOTH)}
                  title="Mover -½ TOOTH"
                >
                  <ChevronLeft className="h-4 w-4" />
                  ½T
                </Button>
                <Button 
                  variant="outline" 
                  size="sm"
                  className="flex-1 h-9"
                  onClick={() => adjustOffset('x', HALF_TOOTH)}
                  title="Mover +½ TOOTH"
                >
                  ½T
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
              
              {/* Slider */}
              <Slider
                value={[offsetX]}
                min={-10}
                max={10}
                step={0.5}
                onValueChange={([v]) => setOffset('x', v)}
                className="mt-2"
              />
            </div>
            
            <Separator className="my-3" />
            
            {/* Y Offset */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className={`text-sm font-medium ${nodeColor}`}>Offset Y</Label>
                <span className="text-sm font-mono font-bold">
                  {offsetY >= 0 ? '+' : ''}{offsetY.toFixed(1)}T
                  <span className="text-xs text-muted-foreground ml-1">
                    ({(offsetY * TOOTH).toFixed(1)}mm)
                  </span>
                </span>
              </div>
              
              {/* Step buttons */}
              <div className="flex items-center gap-2">
                <Button 
                  variant="outline" 
                  size="sm"
                  className="flex-1 h-9"
                  onClick={() => adjustOffset('y', -HALF_TOOTH)}
                  title="Mover -½ TOOTH"
                >
                  <ChevronDown className="h-4 w-4" />
                  ½T
                </Button>
                <Button 
                  variant="outline" 
                  size="sm"
                  className="flex-1 h-9"
                  onClick={() => adjustOffset('y', HALF_TOOTH)}
                  title="Mover +½ TOOTH"
                >
                  ½T
                  <ChevronUp className="h-4 w-4" />
                </Button>
              </div>
              
              {/* Slider */}
              <Slider
                value={[offsetY]}
                min={-10}
                max={10}
                step={0.5}
                onValueChange={([v]) => setOffset('y', v)}
                className="mt-2"
              />
            </div>
            
            {/* Reset button */}
            {(offsetX !== 0 || offsetY !== 0) && (
              <Button 
                variant="ghost" 
                size="sm"
                className="w-full mt-3 text-xs"
                onClick={() => onResetOffset(selectedNodeId)}
              >
                <RefreshCw className="h-3 w-3 mr-2" />
                Reset offset deste nó
              </Button>
            )}
          </div>
          
          <Separator />
          
          {/* Node Info */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <Label className="text-xs text-muted-foreground">Tipo</Label>
              <span className={`font-medium ${nodeColor}`}>
                {isExterior ? 'Exterior' : 'Interior'}
              </span>
            </div>
            
            <div>
              <Label className="text-xs text-muted-foreground">Junction</Label>
              <code className="text-xs font-mono">{parsedNode?.junctionId.slice(0, 8)}...</code>
            </div>
          </div>
          
          <div className="text-xs text-muted-foreground p-3 rounded bg-muted/30">
            <p className="font-medium mb-1">💡 Dica:</p>
            <p>
              O nó {isExterior ? 'exterior (EXT)' : 'interior (INT)'} marca o ponto de interseção 
              das linhas de offset dos painéis {isExterior ? 'exteriores' : 'interiores'}. 
              Use estes controlos para calibrar a posição exacta.
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
