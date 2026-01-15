import { Package, Box, CircleDot, Layers, Scissors, ArrowDownToLine, Grid3X3, AlertTriangle, Link, CheckCircle2, TrendingDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { BOMResult } from '@/types/icf';

interface BOMTableProps {
  bom: BOMResult;
  concreteThickness: string;
}

export function BOMTable({ bom, concreteThickness }: BOMTableProps) {
  // Minimum theoretical panels (if no fragmentation)
  const minPanelsTotal = bom.expectedPanelsApprox ?? Math.ceil((bom.totalWallLength / 1200)) * bom.numberOfRows;
  
  // Recommended purchase (with bin packing)
  const recommendedPanels = bom.panelsCount;
  
  const isChainsUsed = (bom.chainsCount ?? 0) > 0;
  
  // Waste percentage from bin packing
  const wastePct = bom.wastePct ?? 0;
  const isWasteGood = wastePct <= 0.10;
  const isWasteOk = wastePct <= 0.15;
  
  // Over-purchase ratio
  const overPurchaseRatio = minPanelsTotal > 0 ? (recommendedPanels / minPanelsTotal) : 1;
  const overPurchasePct = ((overPurchaseRatio - 1) * 100);

  return (
    <div className="space-y-6">
      {/* BOM Source + Diagnostics Header */}
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="pt-4 space-y-3">
          {/* Source line */}
          <div className="flex items-center gap-3">
            <Link className="h-5 w-5 text-primary" />
            <div className="flex-1">
              <div className="font-medium text-sm">
                Calculado por: {isChainsUsed ? 'CADEIAS (CHAINS) + BIN PACKING' : 'SEGMENTOS (fallback)'}
              </div>
              <div className="text-xs text-muted-foreground">
                {bom.chainsCount ?? 0} cadeias | {(bom.totalWallLength / 1000).toFixed(2)}m total | {bom.numberOfRows} fiadas
              </div>
            </div>
            {isChainsUsed && (
              <Badge variant="default" className="bg-green-600">Bin Packing ✓</Badge>
            )}
          </div>

          {/* Key metrics line */}
          <div className="grid grid-cols-3 gap-4 pt-2 border-t border-border/50">
            <div className="text-center">
              <div className="text-xs text-muted-foreground">Mínimo Teórico</div>
              <div className="font-mono text-lg font-bold">{minPanelsTotal}</div>
              <div className="text-xs text-muted-foreground">painéis</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted-foreground">Compra Recomendada</div>
              <div className="font-mono text-lg font-bold text-primary">{recommendedPanels}</div>
              <div className="text-xs text-muted-foreground">painéis</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted-foreground">Waste</div>
              <div className={`font-mono text-lg font-bold ${isWasteGood ? 'text-green-600' : isWasteOk ? 'text-yellow-600' : 'text-destructive'}`}>
                {(wastePct * 100).toFixed(1)}%
              </div>
              <div className="text-xs text-muted-foreground">
                (+{overPurchasePct.toFixed(1)}% vs mín.)
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Status Alert */}
      {isWasteGood ? (
        <Alert variant="default" className="border-green-500/30 bg-green-500/5">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          <AlertTitle className="text-green-700">BOM optimizado com bin packing</AlertTitle>
          <AlertDescription>
            Waste {(wastePct * 100).toFixed(1)}% está dentro do limite aceitável (≤10%).
            Compra {recommendedPanels} painéis para {minPanelsTotal} m.l. teóricos.
          </AlertDescription>
        </Alert>
      ) : isWasteOk ? (
        <Alert variant="default" className="border-yellow-500/30 bg-yellow-500/5">
          <TrendingDown className="h-4 w-4 text-yellow-600" />
          <AlertTitle className="text-yellow-700">Waste moderado</AlertTitle>
          <AlertDescription>
            Waste {(wastePct * 100).toFixed(1)}% está aceitável mas pode melhorar com melhor merge de cadeias.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Waste alto - verificar geometria</AlertTitle>
          <AlertDescription>
            Waste {(wastePct * 100).toFixed(1)}% é elevado. 
            {isChainsUsed ? ' Tente preset mais agressivo no import ou verifique geometria DXF.' : ' Cálculo em fallback (sem cadeias).'}
          </AlertDescription>
        </Alert>
      )}
      
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="card-highlight">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <Package className="h-8 w-8 text-primary" />
              <div>
                <span className="data-label">Painéis</span>
                <p className="data-value">{bom.panelsCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="card-technical">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <CircleDot className="h-8 w-8 text-tarugo" />
              <div>
                <span className="data-label">Tarugos</span>
                <p className="data-value">{bom.tarugosTotal}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="card-technical">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <Box className="h-8 w-8 text-success" />
              <div>
                <span className="data-label">Topos</span>
                <p className="data-value">{bom.toposUnits}<span className="data-unit">un</span></p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="card-technical">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <Layers className="h-8 w-8 text-web" />
              <div>
                <span className="data-label">Webs</span>
                <p className="data-value">{bom.websTotal}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="card-technical">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <Grid3X3 className="h-8 w-8 text-grid" />
              <div>
                <span className="data-label">Grids</span>
                <p className="data-value">{bom.gridsTotal}<span className="data-unit">×3m</span></p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      
      {/* Detailed Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5 text-primary" />
            Bill of Materials (BOM)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead className="text-right">Quantidade</TableHead>
                <TableHead className="text-right">Unidade</TableHead>
                <TableHead>Notas</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Panels */}
              <TableRow className="bom-row-highlight">
                <TableCell className="font-medium">1</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Package className="h-4 w-4 text-primary" />
                    Painel Standard (1200×400 mm)
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono">{bom.panelsCount}</TableCell>
                <TableCell className="text-right">un</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {bom.numberOfRows} fiadas × {bom.panelsPerFiada || Math.round(bom.totalWallLength / 1200)} painéis/fiada
                  {bom.chainsCount && <span className="ml-2 text-xs">({bom.chainsCount} cadeias)</span>}
                </TableCell>
              </TableRow>
              
              {/* Tarugos - Base */}
              <TableRow className="bom-row">
                <TableCell className="font-medium">2a</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <CircleDot className="h-4 w-4 text-tarugo" />
                    Tarugos (base)
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono">{bom.tarugosBase}</TableCell>
                <TableCell className="text-right">un</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  2 por painel
                </TableCell>
              </TableRow>
              
              {/* Tarugos - Adjustments */}
              <TableRow className="bom-row">
                <TableCell className="font-medium">2b</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <CircleDot className="h-4 w-4 text-tarugo" />
                    Ajustes (L/T/X)
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono">
                  {bom.tarugosAdjustments > 0 ? '+' : ''}{bom.tarugosAdjustments}
                </TableCell>
                <TableCell className="text-right">un</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  L: {bom.junctionCounts.L}×(-1) | T: {bom.junctionCounts.T}×(+1) | X: {bom.junctionCounts.X}×(+2)
                </TableCell>
              </TableRow>
              
              {/* Tarugos - Total */}
              <TableRow className="bom-row-highlight">
                <TableCell className="font-medium">2</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <CircleDot className="h-4 w-4 text-tarugo" />
                    <strong>Tarugos (total)</strong>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono font-bold">{bom.tarugosTotal}</TableCell>
                <TableCell className="text-right">un</TableCell>
                <TableCell></TableCell>
              </TableRow>
              
              {/* Injection Tarugos */}
              <TableRow className="bom-row">
                <TableCell className="font-medium">3</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <ArrowDownToLine className="h-4 w-4 text-warning" />
                    Tarugos de Injeção
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono">{bom.tarugosInjection}</TableCell>
                <TableCell className="text-right">un</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  Controlo de betonagem
                </TableCell>
              </TableRow>
              
              {/* Topos */}
              <TableRow className="bom-row-highlight">
                <TableCell className="font-medium">4</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Box className="h-4 w-4 text-success" />
                    Topo (largura {concreteThickness}mm)
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono">{bom.toposUnits}</TableCell>
                <TableCell className="text-right">un</TableCell>
                <TableCell>
                  <div className="flex gap-1 flex-wrap">
                    {bom.toposByReason.tJunction > 0 && (
                      <Badge variant="secondary">T: {bom.toposByReason.tJunction}</Badge>
                    )}
                    {bom.toposByReason.xJunction > 0 && (
                      <Badge variant="secondary">X: {bom.toposByReason.xJunction}</Badge>
                    )}
                    {bom.toposByReason.openings > 0 && (
                      <Badge variant="secondary">Aberturas: {bom.toposByReason.openings}</Badge>
                    )}
                    {bom.toposByReason.corners > 0 && (
                      <Badge variant="secondary">Cantos: {bom.toposByReason.corners}</Badge>
                    )}
                  </div>
                </TableCell>
              </TableRow>
              
              {/* Topos in meters */}
              <TableRow className="bom-row">
                <TableCell className="font-medium">4b</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Box className="h-4 w-4 text-success" />
                    Topo (metros lineares)
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono">{bom.toposMeters.toFixed(2)}</TableCell>
                <TableCell className="text-right">m</TableCell>
                <TableCell></TableCell>
              </TableRow>
              
              {/* Webs */}
              <TableRow className="bom-row-highlight">
                <TableCell className="font-medium">5</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Layers className="h-4 w-4 text-web" />
                    Webs Distanciadoras
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono">{bom.websTotal}</TableCell>
                <TableCell className="text-right">un</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {bom.websPerPanel || bom.websPerRow} webs/painel
                </TableCell>
              </TableRow>
              
              {/* Grids */}
              <TableRow className="bom-row-highlight">
                <TableCell className="font-medium">6</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Grid3X3 className="h-4 w-4 text-grid" />
                    Grid Estabilização ({bom.gridType}mm)
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono">{bom.gridsTotal}</TableCell>
                <TableCell className="text-right">un (3m)</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {bom.gridsPerRow} por fiada × {bom.gridRows.length} fiadas
                  <Badge variant="outline" className="ml-2">
                    Fiadas: {bom.gridRows.map(r => r + 1).join(', ')}
                  </Badge>
                </TableCell>
              </TableRow>
              
              {/* Cuts */}
              <TableRow className="bom-row">
                <TableCell className="font-medium">—</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Scissors className="h-4 w-4 text-destructive" />
                    Cortes
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono">{bom.cutsCount}</TableCell>
                <TableCell className="text-right">cortes</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {(bom.cutsLengthMm / 1000).toFixed(2)} m total
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      
      {/* Project Summary */}
      <Card className="card-technical">
        <CardHeader>
          <CardTitle className="text-sm text-muted-foreground">Resumo do Projeto</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="data-label">Comprimento Total</span>
              <p className="font-mono text-foreground">{(bom.totalWallLength / 1000).toFixed(2)} m</p>
            </div>
            <div>
              <span className="data-label">Nº de Fiadas</span>
              <p className="font-mono text-foreground">{bom.numberOfRows}</p>
            </div>
            <div>
              <span className="data-label">Cantos L</span>
              <p className="font-mono text-foreground">{bom.junctionCounts.L}</p>
            </div>
            <div>
              <span className="data-label">Nós T / X</span>
              <p className="font-mono text-foreground">{bom.junctionCounts.T} / {bom.junctionCounts.X}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
