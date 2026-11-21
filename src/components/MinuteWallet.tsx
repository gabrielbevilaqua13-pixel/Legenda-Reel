import { useState } from "react";
import { Button } from "./ui/button";
import { activatePack, getWallet } from "@/lib/billing.functions";

export type Wallet = NonNullable<Awaited<ReturnType<typeof getWallet>>>;
export function timeLabel(seconds: number) {
  return (
    [
      Math.floor(seconds / 60) ? Math.floor(seconds / 60) + " min" : "",
      seconds % 60 ? (seconds % 60) + " s" : "",
    ]
      .filter(Boolean)
      .join(" ") || "0 s"
  );
}
export function MinuteWallet({
  wallet,
  onChange,
}: {
  wallet: Wallet;
  onChange: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <section className="mb-5 space-y-3 rounded-2xl border border-primary/25 bg-primary/[0.04] p-5">
      <h2 className="font-display text-xl font-bold">Seus minutos</h2>
      <p>
        Saldo de {timeLabel(wallet.seconds)}
        {wallet.trial && " · Primeiro vídeo de até 1 minuto grátis"}
      </p>
      <p className="text-sm text-muted-foreground">
        10 minutos por R$ 9,90. Você pode editar e exportar quantas vezes quiser.
      </p>
      {wallet.link && (
        <details>
          <summary className="cursor-pointer font-semibold text-primary">
            Comprar 10 minutos
          </summary>
          <p className="my-2 text-sm">
            Após pagar, envie o número do pagamento para{" "}
            <a className="underline" href={"mailto:" + wallet.contact}>
              {wallet.contact}
            </a>
            . Você receberá seu código após a confirmação manual.
          </p>
          <a className="font-bold underline" href={wallet.link} target="_blank" rel="noreferrer">
            Pagar R$ 9,90 no Mercado Pago
          </a>
        </details>
      )}
      {!wallet.link && <p className="text-sm text-muted-foreground">Vendas em breve.</p>}
      <details>
        <summary className="cursor-pointer text-sm font-semibold">
          Ativar pacote ou recuperar saldo
        </summary>
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setMessage("");
            try {
              await activatePack({ data: code.trim() });
              await onChange();
              setCode("");
              setMessage("Saldo atualizado.");
            } catch {
              setMessage("Confira o código e tente novamente.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <input
            className="min-w-0 rounded-lg border bg-background px-3"
            aria-label="Código do pacote"
            placeholder="Código do pacote"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          <Button disabled={busy}>Ativar</Button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">
          Guarde o código em local privado. Ele permite recuperar a carteira em outro aparelho. Um
          código já usado abre a carteira original.
        </p>
        <p role="status">{message}</p>
      </details>
    </section>
  );
}
