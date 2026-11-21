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

## Venda de minutos (piloto)

O primeiro vídeo de até 60 segundos pode usar o teste gratuito. Cada pacote avulso custa R$ 9,90 e adiciona 600 segundos. A cotação arredonda a duração total para o próximo segundo. Edições, exportações e o reenvio do mesmo áudio pela mesma carteira não geram novo débito. O teste é vinculado à carteira, com limite adicional de um teste por rede a cada 24 horas. Os códigos de pacote também recuperam a carteira em outro navegador e devem ficar com o comprador.

O piloto usa o mesmo Valkey do controle de requisições para manter os saldos. Configure no servidor:

| Variável                  | Valor                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| REDIS_URL                 | Endereço privado do Valkey persistente.                              |
| MERCADO_PAGO_PAYMENT_LINK | Link de pagamento público do Mercado Pago para o produto de R$ 9,90. |
| LEGENDA_SUPPORT_EMAIL     | E-mail de atendimento que receberá a referência do pagamento.        |
| LEGENDA_ADMIN_SECRET      | Senha longa para a área administrativa.                              |

Sem o Valkey, o editor mantém o fluxo anterior. A compra aparece quando o link e o contato estão configurados.

Após conferir na conta vendedora o pagamento aprovado de R$ 9,90, abra `/admin`, informe a senha administrativa e o ID numérico do pagamento. A página gera o código do comprador.

Entregue o código em particular ao comprador confirmado. Confira a identidade do destinatário pelos dados da venda antes do envio. Repetir o comando para o mesmo pagamento devolve o mesmo código. O cliente entra em **Ativar pacote ou recuperar saldo**. Um código novo adiciona minutos à carteira aberta. Um código já ativado recupera a carteira original.
