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
//
// Usamos aqui o formato "clássico" de function do Vercel (req, res), com o
// parser de corpo desligado — é o jeito oficialmente recomendado pelo Stripe
// para funcionar em Vercel, e evita depender do formato mais novo baseado em
// Request/Response da Web, que se mostrou instável em produção.

import Stripe from "stripe";
import { FieldValue } from "firebase-admin/firestore";
import { getFirestoreAdmin } from "./_firebaseAdmin.js";

export const config = {
  api: {
    bodyParser: false, // precisamos do corpo BRUTO (sem parsear) para validar a assinatura do Stripe
  },
};

const CREDITOS_PACOTE_AVULSO = 30;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function lerCorpoBruto(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    req.on("data", (parte) => partes.push(parte));
    req.on("end", () => resolve(Buffer.concat(partes)));
    req.on("error", reject);
  });
}

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const rawBody = await lerCorpoBruto(req);
  const assinatura = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      assinatura,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("[stripe-webhook] Assinatura inválida:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  const db = getFirestoreAdmin();

  // ── Idempotência ───────────────────────────────────────────────────
  // O Stripe garante entrega "pelo menos uma vez" — ou seja, o MESMO evento
  // pode chegar aqui mais de uma vez de propósito (nova tentativa automática
  // depois de um erro, um "Reenviar" manual no painel, etc.). Sem essa
  // proteção, reprocessar o mesmo "checkout.session.completed" concederia os
  // créditos ou o premium de novo, em dobro. Aqui registramos o ID do evento
  // antes de processá-lo; se ele já existir, é porque já foi tratado, e
  // simplesmente ignoramos a repetição.
  const eventoRef = db.collection("stripeEventosProcessados").doc(event.id);
  try {
    await eventoRef.create({
      tipo: event.type,
      processadoEm: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    if (err.code === 6 /* ALREADY_EXISTS */) {
      console.log(`[stripe-webhook] Evento ${event.id} já foi processado antes — ignorando repetição.`);
      res.status(200).json({ received: true, duplicado: true });
      return;
    }
    console.error("[stripe-webhook] Erro ao registrar idempotência do evento:", err);
    res.status(500).send("Erro interno ao processar o evento");
    return;
  }

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
            { creditosAvulsos: FieldValue.increment(CREDITOS_PACOTE_AVULSO) },
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
    res.status(500).send("Erro interno ao processar o evento");
    return;
  }

  res.status(200).json({ received: true });
}
