/**
 * ExternalEnginePanel - UI panel for external engine mode
 * 
 * Shows:
 * - Engine mode toggle (External/Internal)
 * - Counters (walls, nodes, courses)
 * - Selected wall details
 * - Engine configuration
 */

import { Server, Home, Layers, GitBranch, Box, Settings, AlertCircle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { EngineMode, ExternalEngineAnalysis, EngineConfig, GraphWall } from '@/types/external-engine';

interface ExternalEnginePanelProps {
  engineMode: EngineMode;
  onEngineModeChange: (mode: EngineMode) => void;
  analysis: ExternalEngineAnalysis | null;
  isLoading: boolean;
  error: string | null;
  selectedWallId: string | null;
  config: EngineConfig;
  onConfigChange: (config: Partial<EngineConfig>) => void;
}

export function ExternalEnginePanel({
  engineMode,
  onEngineModeChange,
  analysis,
  isLoading,
  error,
  selectedWallId,
  config,
  onConfigChange,
}: ExternalEnginePanelProps) {
  const isExternal = engineMode === 'external';

  // Get selected wall details
  const selectedWall: GraphWall | undefined = analysis?.graph.walls.find(
    (w) => w.id === selectedWallId
  );

  return (
    <Card className="w-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Server className="h-4 w-4" />
          Motor de Cálculo
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Engine Mode Toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isExternal ? (
              <Server className="h-4 w-4 text-primary" />
            ) : (
              <Home className="h-4 w-4 text-muted-foreground" />
            )}
            <Label htmlFor="engine-mode" className="text-sm">
              {isExternal ? 'External (FastAPI)' : 'Internal (Lovable)'}
            </Label>
          </div>
          <Switch
            id="engine-mode"
            checked={isExternal}
            onCheckedChange={(checked) => onEngineModeChange(checked ? 'external' : 'internal')}
          />
        </div>

        {/* Loading indicator */}
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            A processar no motor externo...
          </div>
        )}

        {/* Error display */}
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        )}

        {/* External mode content */}
        {isExternal && (
          <>
            <Separator />

            {/* Counters */}
            {analysis && (
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="p-2 bg-muted/50 rounded">
                  <div className="text-lg font-bold text-primary">
                    {analysis.graph.walls.length}
                  </div>
                  <div className="text-xs text-muted-foreground">Paredes</div>
                </div>
                <div className="p-2 bg-muted/50 rounded">
                  <div className="text-lg font-bold text-primary">
                    {analysis.graph.nodes.length}
                  </div>
                  <div className="text-xs text-muted-foreground">Nós</div>
                </div>
                <div className="p-2 bg-muted/50 rounded">
                  <div className="text-lg font-bold text-primary">
                    {analysis.courses.count}
                  </div>
                  <div className="text-xs text-muted-foreground">Fiadas</div>
                </div>
              </div>
            )}

            {/* Selected Wall Details */}
            {selectedWall && (
              <>
                <Separator />
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Box className="h-4 w-4 text-primary" />
                    Parede Selecionada
                  </div>
                  <ScrollArea className="h-[120px] rounded border p-2 text-xs font-mono">
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">ID:</span>
                        <span>{selectedWall.id}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Comprimento:</span>
                        <span>{selectedWall.length.toFixed(0)} mm</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Nó início:</span>
                        <span>{selectedWall.start_node}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Nó fim:</span>
                        <span>{selectedWall.end_node}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Offsets:</span>
                        <Badge variant={selectedWall.offsets ? 'default' : 'secondary'}>
                          {selectedWall.offsets ? 'Sim' : 'Fallback'}
                        </Badge>
                      </div>
                    </div>
                  </ScrollArea>
                </div>
              </>
            )}

            {/* Engine Configuration */}
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
                <Settings className="h-4 w-4" />
                Configuração do Motor
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3 space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="base-url" className="text-xs">
                    URL Base (HTTP ou HTTPS)
                  </Label>
                  <Input
                    id="base-url"
                    value={config.baseUrl}
                    onChange={(e) => onConfigChange({ baseUrl: e.target.value })}
                    placeholder="https://xxxxx.ngrok-free.app"
                    className="h-8 text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Ex: http://127.0.0.1:8001 ou https://xxxxx.ngrok-free.app
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="thickness" className="text-xs">
                      Espessura (mm)
                    </Label>
                    <Input
                      id="thickness"
                      type="number"
                      value={config.thickness}
                      onChange={(e) => onConfigChange({ thickness: Number(e.target.value) })}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="wall-height" className="text-xs">
                      Altura (mm)
                    </Label>
                    <Input
                      id="wall-height"
                      type="number"
                      value={config.wallHeight}
                      onChange={(e) => onConfigChange({ wallHeight: Number(e.target.value) })}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="course-height" className="text-xs">
                      Fiada (mm)
                    </Label>
                    <Input
                      id="course-height"
                      type="number"
                      value={config.courseHeight}
                      onChange={(e) => onConfigChange({ courseHeight: Number(e.target.value) })}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="offset-odd" className="text-xs">
                      Offset Ímpar (mm)
                    </Label>
                    <Input
                      id="offset-odd"
                      type="number"
                      value={config.offsetOdd}
                      onChange={(e) => onConfigChange({ offsetOdd: Number(e.target.value) })}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* No analysis yet message */}
            {!analysis && !isLoading && !error && (
              <div className="text-center text-sm text-muted-foreground py-4">
                <Layers className="h-8 w-8 mx-auto mb-2 opacity-50" />
                Importe um DXF para analisar com o motor externo
              </div>
            )}
          </>
        )}

        {/* Internal mode message */}
        {!isExternal && (
          <div className="text-xs text-muted-foreground">
            A usar cálculos internos do Lovable (fallback).
          </div>
        )}
      </CardContent>
    </Card>
  );
}
