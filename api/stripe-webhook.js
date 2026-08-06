// ── Webhook do Stripe — Oráculo de Luz ──────────────────────────────
// Esta function é o "mensageiro" que confere, direto com o Stripe, se um
// pagamento realmente aconteceu — e só então libera o acesso no Firestore.
// É o que fecha a brecha de segurança de confiar no retorno do navegador.
//
// Endpoint público (depois do deploy): https://<seu-dominio>/api/stripe-webhook
// Cadastre esse endereço no painel do Stripe (Developers → Webhooks) e
// selecione os eventos: checkout.session.completed, customer.subscription.deleted,
// customer.subscription.updated.
//
// Variáveis de ambiente necessárias no Vercel:
//   STRIPE_SECRET_KEY       (chave secreta da sua conta Stripe)
//   STRIPE_WEBHOOK_SECRET   (gerada ao cadastrar o endpoint do webhook no Stripe)
//   + as variáveis do Firebase Admin (ver api/_firebaseAdmin.js)

import Stripe from "stripe";
import { getFirestoreAdmin, admin } from "./_firebaseAdmin.js";

const CREDITOS_PACOTE_AVULSO = 30;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function revogarPremiumPorCustomerId(db, customerId) {
  if (!customerId) return;
  const snap = await db
    .collection("usuarios")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();

  if (snap.empty) {
    console.warn("[stripe-webhook] Nenhum usuário encontrado para o customer", customerId);
    return;
  }
  await snap.docs[0].ref.set({ premium: false }, { merge: true });
}

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Precisamos do corpo BRUTO (sem parsear) para validar a assinatura do Stripe.
    const rawBody = await request.text();
    const assinatura = request.headers.get("stripe-signature");

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        assinatura,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("[stripe-webhook] Assinatura inválida:", err.message);
      return new Response(`Webhook Error: ${err.message}`, { status: 400 });
    }

    const db = getFirestoreAdmin();

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const uid = session.client_reference_id;

          if (!uid) {
            console.warn("[stripe-webhook] checkout.session.completed sem client_reference_id — ignorado.");
            break;
          }

          const userRef = db.collection("usuarios").doc(uid);

          if (session.mode === "subscription") {
            await userRef.set(
              {
                premium: true,
                stripeCustomerId: session.customer || null,
                stripeSubscriptionId: session.subscription || null,
              },
              { merge: true }
            );
          } else if (session.mode === "payment") {
            await userRef.set(
              { creditosAvulsos: admin.firestore.FieldValue.increment(CREDITOS_PACOTE_AVULSO) },
              { merge: true }
            );
          }
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          await revogarPremiumPorCustomerId(db, subscription.customer);
          break;
        }

        case "customer.subscription.updated": {
          const subscription = event.data.object;
          if (subscription.status === "canceled" || subscription.status === "unpaid") {
            await revogarPremiumPorCustomerId(db, subscription.customer);
          }
          break;
        }

        default:
          // Outros eventos não nos interessam por enquanto.
          break;
      }
    } catch (err) {
      console.error("[stripe-webhook] Erro processando evento:", err);
      return new Response("Erro interno ao processar o evento", { status: 500 });
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};
