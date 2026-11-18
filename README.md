# Legenda

Aplicação web para criar legendas precisas e personalizadas para vídeos curtos, com sincronização palavra por palavra e exportação do vídeo.

## Aplicação

https://reel-word-glow-app.onrender.com

## Tecnologias

- React
- TanStack Start
- TypeScript
- Vite
- Bun
- Groq para transcrição de áudio
- Render para hospedagem

## Desenvolvimento local

Requisitos: Bun e Node.js.

```bash
git clone https://github.com/gabrielbevilaqua13-pixel/reel-word-glow.git
cd reel-word-glow
bun install
bun run dev
```

## Verificações

```bash
bun run lint
bun run test
bun run build
```

## Implantação

O serviço de produção é hospedado no Render e acompanha a branch `redesign/interface-2026`.
