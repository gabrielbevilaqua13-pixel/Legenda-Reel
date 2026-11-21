import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { enterOwnerMode, issuePackAdmin } from "@/lib/admin.functions";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Administração — Legenda" }] }),
  component: Admin,
});

function Admin() {
  const [secret, setSecret] = useState("");
  const [payment, setPayment] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="mx-auto min-h-screen max-w-xl px-5 py-16">
      <p className="text-xs font-bold uppercase tracking-[0.25em] text-primary">Legenda</p>
      <h1 className="mt-3 font-display text-4xl font-extrabold">Administração</h1>
      <p className="mt-4 text-sm leading-6 text-muted-foreground">
        Confirme primeiro no Mercado Pago que o pagamento de R$ 9,90 foi aprovado. Cada ID gera um
        único código de 10 minutos.
      </p>
      <form
        className="mt-8 space-y-5 rounded-2xl border border-white/10 bg-white/[0.03] p-6"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setCode("");
          setMessage("");
          try {
            const result = await issuePackAdmin({ data: { secret, payment } });
            setCode(result.code);
            setMessage("Código pronto. Envie-o somente ao comprador confirmado.");
          } catch {
            setMessage("Não foi possível gerar o código. Confira a senha e o ID do pagamento.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block space-y-2 text-sm font-semibold">
          <span>Senha administrativa</span>
          <input
            className="w-full rounded-xl border border-white/15 bg-background px-4 py-3 font-normal"
            type="password"
            autoComplete="current-password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            required
          />
        </label>
        <Button type="button" disabled={busy || !secret} onClick={async () => {
          setBusy(true);
          setMessage("");
          try {
            await enterOwnerMode({ data: secret });
            window.location.assign("/");
          } catch {
            setMessage("Não foi possível entrar. Confira a senha administrativa.");
          } finally {
            setBusy(false);
          }
        }}>Usar o editor como proprietário</Button>
        <label className="block space-y-2 text-sm font-semibold">
          <span>ID numérico do pagamento aprovado</span>
          <input
            className="w-full rounded-xl border border-white/15 bg-background px-4 py-3 font-normal"
            inputMode="numeric"
            pattern="[0-9]+"
            value={payment}
            onChange={(event) => setPayment(event.target.value)}
            required
          />
        </label>
        <Button className="w-full" disabled={busy}>
          {busy ? "Gerando…" : "Gerar código de 10 minutos"}
        </Button>
      </form>
      {code && (
        <div className="mt-6 rounded-2xl border border-primary/30 bg-primary/[0.07] p-5">
          <p className="text-xs font-bold uppercase tracking-wider text-primary">
            Código do cliente
          </p>
          <code className="mt-3 block break-all text-lg font-bold">{code}</code>
          <Button
            className="mt-4"
            variant="outline"
            onClick={async () => {
              await navigator.clipboard.writeText(code);
              setMessage("Código copiado.");
            }}
          >
            Copiar código
          </Button>
        </div>
      )}
      <p className="mt-4 text-sm" role="status">
        {message}
      </p>
    </main>
  );
}
