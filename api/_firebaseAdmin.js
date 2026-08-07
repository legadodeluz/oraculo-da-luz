// ── Inicialização do Firebase Admin SDK ─────────────────────────────
// Usado só do lado do servidor (dentro das functions em /api).
// NUNCA importe este arquivo em código que roda no navegador.
//
// Precisa de 3 variáveis de ambiente configuradas no painel do Vercel
// (Project Settings → Environment Variables), vindas de uma "chave de
// conta de serviço" gerada no console do Firebase:
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY   (cole com as quebras de linha como "\n")
//
// Nota: a partir da versão 14 do pacote "firebase-admin", a API mudou para
// o formato modular (initializeApp/cert/getApps importados de
// "firebase-admin/app", em vez do antigo "admin.initializeApp()" etc.).
// Usamos aqui o formato novo.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function inicializar() {
  const existentes = getApps();
  if (existentes.length > 0) return existentes[0];

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Faltam variáveis de ambiente do Firebase Admin (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY)."
    );
  }

  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

export function getFirestoreAdmin() {
  inicializar();
  return getFirestore();
}
