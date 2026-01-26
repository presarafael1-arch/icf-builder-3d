

## Plano: Unificar Lógica de Faixas EXT/INT no Motor Externo

### Resumo

O objetivo é alinhar o rendering do **Motor Externo** com a lógica já implementada no **Motor Interno**, onde:
- **Painéis Exteriores** → Faixa **AZUL** em ambas as faces
- **Painéis Interiores** → Faixa **BRANCA** em ambas as faces
- **Cor base**: FULL = amarelo, CUT = vermelho (em ambos os lados)

Atualmente, o Motor Externo aplica a cor FULL/CUT apenas na "skin exterior" e usa linhas azuis como overlay apenas no lado exterior. A nova implementação seguirá o padrão do `SideStripeOverlays.tsx`.

---

### Mudanças a Implementar

#### 1. Modificar `DualSkinPanel` para Cor Base Consistente

**Ficheiro:** `src/components/viewer/ExternalEngineRenderer.tsx`

Atualmente:
- Skin exterior: usa `panelColor` (amarelo/vermelho) se `isExteriorWall`
- Skin interior: sempre `COLORS.INTERIOR` (branco/cinza)

Nova lógica:
- **Ambas as skins** usam a cor base do painel (`panelColor`):
  - `FULL` → amarelo (`#ffc107`)
  - `CUT` → vermelho (`#f44336`)

```text
Antes:
┌─────────────────┐
│ EXT: amarelo/red│  ← só exterior tem cor do tipo
│ INT: branco     │
└─────────────────┘

Depois:
┌─────────────────┐
│ EXT: amarelo/red│  ← ambos têm cor do tipo
│ INT: amarelo/red│
└─────────────────┘
```

#### 2. Adicionar Faixas (Stripes) em Vez de Overlay de Linhas

**Substituir `ExteriorOverlay`** (linhas diagonais/horizontais azuis) por **faixas sólidas** no centro do painel, tal como no `SideStripeOverlays.tsx`.

Nova lógica de faixas:
- **Paredes exteriores**: faixa AZUL em **ambas** as faces (front e back)
- **Paredes interiores**: faixa BRANCA em **ambas** as faces (front e back)

Parâmetros da faixa (do motor interno):
- Largura: 100mm (10cm)
- Altura: 85% da altura do painel (course height)
- Opacidade: 80%
- Offset: 1-2mm da superfície para evitar z-fighting

#### 3. Criar Componente `PanelStripe` para Motor Externo

Novo sub-componente que desenha uma faixa retangular (PlaneGeometry) centrada no painel:

```typescript
interface PanelStripeProps {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  startPt: { x: number; y: number };
  u2: { x: number; y: number };
  n2: { x: number; y: number };
  color: string;
  offset: number; // +/- para front/back
}
```

A faixa será posicionada:
- Centro horizontal do painel: `(x0 + x1) / 2`
- Centro vertical do painel: `(z0 + z1) / 2`
- Offset perpendicular à face (usando `n2`)

#### 4. Atualizar `DualSkinPanel` para Incluir Faixas

```text
Para cada painel:
├── Skin Exterior
│   ├── Mesh (cor = panelColor)
│   ├── Outline (EdgesGeometry)
│   ├── Faixa Front (azul se EXT wall, branca se INT wall)
│   └── Faixa Back (mesma cor da front)
│
└── Skin Interior
    ├── Mesh (cor = panelColor)
    ├── Outline (EdgesGeometry)
    ├── Faixa Front (azul se EXT wall, branca se INT wall)
    └── Faixa Back (mesma cor da front)
```

#### 5. Remover `ExteriorOverlay` Antigo

O componente `ExteriorOverlay` que desenha linhas diagonais e horizontais será removido, pois a nova lógica usa faixas sólidas.

---

### Estrutura do Código Final

```text
ExternalEngineRenderer.tsx
├── COLORS (atualizado)
│   ├── STRIPE_EXTERIOR: '#3B82F6' (azul)
│   └── STRIPE_INTERIOR: '#FFFFFF' (branco)
│
├── PanelStripe (NOVO)
│   └── PlaneGeometry com MeshBasicMaterial
│
├── DualSkinPanel (MODIFICADO)
│   ├── Exterior Skin
│   │   ├── PanelSkin (panelColor)
│   │   ├── PanelOutline
│   │   ├── PanelStripe (front, cor da faixa)
│   │   └── PanelStripe (back, cor da faixa)
│   │
│   └── Interior Skin
│       ├── PanelSkin (panelColor)
│       ├── PanelOutline
│       ├── PanelStripe (front, cor da faixa)
│       └── PanelStripe (back, cor da faixa)
│
└── WallFallback (MODIFICADO)
    └── Lógica de faixas aplicada também
```

---

### Detalhes Técnicos

#### Dimensões da Faixa

| Parâmetro | Valor | Notas |
|-----------|-------|-------|
| Largura | 100mm | Centrada no painel |
| Altura | 85% × course height | ~340mm para course de 400mm |
| Opacidade | 80% | `opacity={0.8}` |
| Offset Z | 1mm | Evita z-fighting |
| Cor EXT | `#3B82F6` | Azul (mesmo do motor interno) |
| Cor INT | `#FFFFFF` | Branco |

#### Material da Faixa

```typescript
<meshBasicMaterial
  color={stripeColor}
  transparent
  opacity={0.8}
  side={THREE.DoubleSide}
  depthWrite={false}
  polygonOffset
  polygonOffsetFactor={-1}
  polygonOffsetUnits={-1}
/>
```

---

### Resultado Visual Esperado

```text
┌────────────────────────────────────────────┐
│ PAREDE EXTERIOR                            │
│                                            │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐      │
│  │ FULL │ │ FULL │ │ CUT  │ │ FULL │      │
│  │ ████ │ │ ████ │ │ ████ │ │ ████ │      │ ← Faixa AZUL
│  │ amar │ │ amar │ │ verm │ │ amar │      │
│  └──────┘ └──────┘ └──────┘ └──────┘      │
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│ PAREDE INTERIOR                            │
│                                            │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐      │
│  │ FULL │ │ FULL │ │ CUT  │ │ FULL │      │
│  │ ░░░░ │ │ ░░░░ │ │ ░░░░ │ │ ░░░░ │      │ ← Faixa BRANCA
│  │ amar │ │ amar │ │ verm │ │ amar │      │
│  └──────┘ └──────┘ └──────┘ └──────┘      │
└────────────────────────────────────────────┘
```

---

### Ficheiros a Modificar

1. **`src/components/viewer/ExternalEngineRenderer.tsx`**
   - Adicionar constantes de cor para faixas
   - Criar componente `PanelStripe`
   - Modificar `DualSkinPanel` para usar cor base em ambas as skins
   - Adicionar faixas (front e back) em cada skin
   - Remover `ExteriorOverlay`
   - Atualizar `WallFallback` para consistência

---

### Validação

Após implementação:
1. Importar DXF no modo External Engine
2. Verificar que painéis FULL são amarelos em ambas as faces
3. Verificar que painéis CUT são vermelhos em ambas as faces
4. Verificar que paredes exteriores têm faixa AZUL visível de ambos os lados
5. Verificar que paredes interiores têm faixa BRANCA visível de ambos os lados
6. Rodar a câmara para confirmar que a classificação é legível de qualquer ângulo

