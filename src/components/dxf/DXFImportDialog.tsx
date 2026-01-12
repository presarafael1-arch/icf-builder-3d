import { useState, useRef } from 'react';
import { Upload, Layers, Check, X, FileText, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { parseDXF, filterSegmentsByLayers, DXFSegment } from '@/lib/dxf-parser';

interface DXFImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (segments: DXFSegment[], selectedLayers: string[]) => void;
}

type ImportStep = 'upload' | 'layers' | 'confirm';

export function DXFImportDialog({ open, onOpenChange, onImport }: DXFImportDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<ImportStep>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [layers, setLayers] = useState<string[]>([]);
  const [segments, setSegments] = useState<DXFSegment[]>([]);
  const [selectedLayers, setSelectedLayers] = useState<string[]>([]);
  const [unitFactor, setUnitFactor] = useState<'1' | '1000'>('1');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setStep('upload');
    setFile(null);
    setLayers([]);
    setSegments([]);
    setSelectedLayers([]);
    setUnitFactor('1');
    setError(null);
    setLoading(false);
  };

  const handleClose = () => {
    reset();
    onOpenChange(false);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    if (!selectedFile.name.toLowerCase().endsWith('.dxf')) {
      setError('Por favor selecione um ficheiro DXF válido.');
      return;
    }

    setFile(selectedFile);
    setError(null);
    setLoading(true);

    try {
      const content = await selectedFile.text();
      const factor = unitFactor === '1000' ? 1000 : 1;
      const result = parseDXF(content, factor);

      if (result.error) {
        setError(result.error);
        setLoading(false);
        return;
      }

      setLayers(result.layers);
      setSegments(result.segments);
      setSelectedLayers(result.layers); // Select all by default
      setStep('layers');
    } catch (err) {
      console.error('Error reading file:', err);
      setError('Erro ao ler o ficheiro. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  const handleLayerToggle = (layer: string, checked: boolean) => {
    if (checked) {
      setSelectedLayers([...selectedLayers, layer]);
    } else {
      setSelectedLayers(selectedLayers.filter(l => l !== layer));
    }
  };

  const handleSelectAll = () => {
    setSelectedLayers([...layers]);
  };

  const handleDeselectAll = () => {
    setSelectedLayers([]);
  };

  const handleConfirm = () => {
    const filteredSegments = filterSegmentsByLayers(segments, selectedLayers);
    onImport(filteredSegments, selectedLayers);
    handleClose();
  };

  const filteredCount = filterSegmentsByLayers(segments, selectedLayers).length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-primary" />
            Importar DXF
          </DialogTitle>
          <DialogDescription>
            {step === 'upload' && 'Carregue um ficheiro DXF para importar paredes.'}
            {step === 'layers' && 'Selecione as layers que contêm paredes.'}
            {step === 'confirm' && 'Confirme a importação das paredes.'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {step === 'upload' && (
          <div className="space-y-4">
            {/* Unit selector */}
            <div className="space-y-2">
              <Label>Unidade do DXF</Label>
              <RadioGroup
                value={unitFactor}
                onValueChange={(v) => setUnitFactor(v as '1' | '1000')}
                className="flex gap-4"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="1" id="unit-mm" />
                  <Label htmlFor="unit-mm" className="cursor-pointer">Milímetros (mm)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="1000" id="unit-m" />
                  <Label htmlFor="unit-m" className="cursor-pointer">Metros (m)</Label>
                </div>
              </RadioGroup>
            </div>

            {/* File upload */}
            <div
              className="border-2 border-dashed border-border rounded-lg p-8 text-center hover:border-primary/50 transition-colors cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".dxf"
                onChange={handleFileSelect}
                className="hidden"
              />
              <FileText className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground mb-2">
                Clique para selecionar ou arraste um ficheiro DXF
              </p>
              <p className="text-xs text-muted-foreground">
                Suporta entidades LINE e LWPOLYLINE
              </p>
            </div>

            {loading && (
              <div className="text-center text-sm text-muted-foreground animate-pulse">
                A processar ficheiro...
              </div>
            )}
          </div>
        )}

        {step === 'layers' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {layers.length} layers encontradas
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={handleSelectAll}>
                  Todas
                </Button>
                <Button variant="ghost" size="sm" onClick={handleDeselectAll}>
                  Nenhuma
                </Button>
              </div>
            </div>

            <ScrollArea className="h-[200px] border rounded-md p-3">
              <div className="space-y-2">
                {layers.map((layer) => (
                  <div key={layer} className="flex items-center space-x-2">
                    <Checkbox
                      id={`layer-${layer}`}
                      checked={selectedLayers.includes(layer)}
                      onCheckedChange={(checked) => handleLayerToggle(layer, checked === true)}
                    />
                    <Label
                      htmlFor={`layer-${layer}`}
                      className="flex-1 cursor-pointer text-sm font-mono"
                    >
                      {layer}
                    </Label>
                    <span className="text-xs text-muted-foreground">
                      {segments.filter(s => s.layerName === layer).length} segs
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>

            <div className="flex items-center justify-between p-3 bg-muted/30 rounded-md">
              <span className="text-sm">Segmentos a importar:</span>
              <span className="text-sm font-bold text-primary">{filteredCount}</span>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {step === 'upload' && (
            <Button variant="outline" onClick={handleClose}>
              Cancelar
            </Button>
          )}

          {step === 'layers' && (
            <>
              <Button variant="outline" onClick={() => setStep('upload')}>
                Voltar
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={selectedLayers.length === 0 || filteredCount === 0}
                className="gap-2"
              >
                <Check className="h-4 w-4" />
                Importar {filteredCount} paredes
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
