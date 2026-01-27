
# Plano: Corrigir Deteção Geométrica do Lado Exterior

## Entendimento do Problema

O utilizador confirmou com o diagrama:
- Cada painel (skin ~70mm) deve ter **faixas em AMBAS as faces** (sandwich)
- A renderização das faixas em ambos os lados JÁ está implementada (linhas 589-612 e 633-656)
- O problema é a **identificação incorreta** de qual polyline (`leftPts` vs `rightPts`) é o lado exterior

### Código Atual (linha 289-292)

```typescript
if (isExteriorWall && footprintHull.length >= 3) {
  const dot = outN.x * n2.x + outN.y * n2.y;
  exteriorSide = dot > 0 ? 'left' : 'right';
}
```

Este código assume que `n2` aponta para `left`, mas isso não é garantido pelo backend. Para algumas paredes, `leftPts` pode estar no lado interior.

## Solução

Verificar **geometricamente** qual polyline está no lado exterior usando os midpoints reais:

```text
                    outN (aponta para FORA)
                      ↑
       ┌──────────────┼──────────────┐
       │              │              │
   leftPts ─────── CENTER ─────── rightPts

Se (CENTER → leftMid) · outN > 0:
  → leftPts está no lado EXTERIOR
  
Se (CENTER → leftMid) · outN < 0:
  → rightPts está no lado EXTERIOR
```

## Alterações Necessárias

### Ficheiro: `src/components/viewer/ExternalEngineRenderer.tsx`

### Linhas 289-296: Substituir lógica de `exteriorSide`

**ANTES:**
```typescript
if (isExteriorWall && footprintHull.length >= 3) {
  // outN points OUTSIDE - compare with n2 to determine which side
  const dot = outN.x * n2.x + outN.y * n2.y;
  exteriorSide = dot > 0 ? 'left' : 'right';
}

// Debug logging
console.log(`[Wall ${wall.id}] isExterior: ${isExteriorWall}, side: ${exteriorSide}, outN: (${outN.x.toFixed(3)}, ${outN.y.toFixed(3)})`);
```

**DEPOIS:**
```typescript
if (isExteriorWall && footprintHull.length >= 3) {
  // Determine which polyline (left or right) is on the exterior side
  // by testing which midpoint is further in the outN direction
  
  // Calculate midpoints of each polyline
  const leftMid = {
    x: (leftPts[0].x + leftPts[leftPts.length - 1].x) / 2,
    y: (leftPts[0].y + leftPts[leftPts.length - 1].y) / 2,
  };
  const rightMid = {
    x: (rightPts[0].x + rightPts[rightPts.length - 1].x) / 2,
    y: (rightPts[0].y + rightPts[rightPts.length - 1].y) / 2,
  };
  
  // Vector from wall center to left polyline midpoint
  const toLeft = { 
    x: leftMid.x - wallCenterMid.x, 
    y: leftMid.y - wallCenterMid.y 
  };
  
  // Dot product with outN - positive means left is on exterior side
  const dotLeft = toLeft.x * outN.x + toLeft.y * outN.y;
  
  exteriorSide = dotLeft > 0 ? 'left' : 'right';
  
  // Enhanced debug logging
  console.log(`[Wall ${wall.id}] isExterior: true, exteriorPolyline: ${exteriorSide}, dotLeft: ${dotLeft.toFixed(3)}`);
} else {
  console.log(`[Wall ${wall.id}] isExterior: ${isExteriorWall} (partition)`);
}
```

## Estrutura Visual Corrigida

```text
PAREDE PERIMETRAL (corte transversal):
← FORA DO EDIFÍCIO

┌───────────────────────────────────┐
│ ████  Faixa AZUL  ████████████████│  ← Face exterior do painel externo
│ ▓▓▓▓  Amarelo/Vermelho  ▓▓▓▓▓▓▓▓▓│  ← Painel FULL ou CUT
│ ████  Faixa AZUL  ████████████████│  ← Face interior do painel externo
├───────────────────────────────────┤
│         BETÃO (núcleo)            │
├───────────────────────────────────┤
│ ████  Faixa BRANCA  ██████████████│  ← Face exterior do painel interno
│ ▓▓▓▓  Amarelo/Vermelho  ▓▓▓▓▓▓▓▓▓│  ← Painel FULL ou CUT
│ ████  Faixa BRANCA  ██████████████│  ← Face interior do painel interno
└───────────────────────────────────┘

→ DENTRO DO EDIFÍCIO
```

## Resumo

| Local | Alteração |
|-------|-----------|
| Linhas 289-296 | Substituir `dot(outN, n2)` por teste geométrico usando midpoints dos polylines |

## Resultado Esperado

Todas as paredes perimetrais terão:
- **Painel externo**: Amarelo/Vermelho com faixas AZUIS em ambas as faces
- **Painel interno**: Amarelo/Vermelho com faixas BRANCAS em ambas as faces

Paredes interiores (partições):
- Ambos os painéis com faixas BRANCAS em ambas as faces
