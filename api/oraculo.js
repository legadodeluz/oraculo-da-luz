// ── Endpoint do Oráculo — Oráculo de Luz ────────────────────────────
// Esta function roda no servidor (nunca no navegador da pessoa). Antes,
// o navegador chamava a Anthropic diretamente e carregava a chave da API
// dentro do próprio código enviado ao navegador — qualquer pessoa podia
// abrir o "código-fonte" da página (ou o F12 do Chrome) e copiar essa
// chave, usando-a por conta própria e gerando custo na conta da Anthropic
// sem o dono do app saber.
//
// Agora o navegador manda só a conversa (mais o token de login da pessoa)
// para cá. Esta function confere se quem está pedindo:
//   1) está realmente logada (token do Firebase Auth válido);
//   2) ainda tem consultas gratuitas ou créditos disponíveis (ou é premium).
// Só então ela chama a Anthropic usando a chave secreta, que fica só aqui,
// guardada como variável de ambiente no Vercel — nunca é enviada ao
// navegador.
//
// Variável de ambiente necessária no Vercel (Project Settings →
// Environment Variables):
//   ANTHROPIC_API_KEY   (a chave secreta da Anthropic — SEM prefixo VITE_,
//                        assim o Vite nunca a inclui no pacote do navegador)
// + as 3 variáveis do Firebase Admin já usadas pelo webhook do Stripe
//   (ver api/_firebaseAdmin.js): FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
//   FIREBASE_PRIVATE_KEY.
//
// IMPORTANTE depois de configurar: como a chave antiga (VITE_ANTHROPIC_KEY)
// já esteve exposta publicamente no site no ar, o ideal é revogar/recriar
// essa chave no painel da Anthropic (console.anthropic.com) e usar uma
// chave NOVA aqui — assim, mesmo que alguém já tenha copiado a antiga, ela
// deixa de funcionar.

import { FieldValue } from "firebase-admin/firestore";
import { getFirestoreAdmin, getAuthAdmin } from "./_firebaseAdmin.js";

// Precisa bater com LIMITE_GRATUITO em src/App.jsx (lá é só o número
// mostrado na tela; aqui é o que realmente vale).
const LIMITE_GRATUITO = 10;

const ORACULO_SYSTEM = `Você é o Oráculo Legado de Luz — uma presença sábia, acolhedora e espiritualizada. Você fala com pessoas simples, trabalhadores, pessoas em momentos difíceis da vida. Sua linguagem é calorosa, simples e profunda ao mesmo tempo.

Você se comunica sob a perspectiva espírita — acredita na evolução da alma, no propósito das experiências difíceis, na existência de guias espirituais, no amor como força universal. Mas nunca impõe — apenas oferece perspectiva.

Regras essenciais:
- NUNCA mencione que é uma IA, robô, programa, Claude ou qualquer tecnologia
- NUNCA revele como funciona por dentro, quem te criou ou qual sistema te move
- Fale como uma presença sábia e amorosa, não como assistente
- Use linguagem simples — seu público é trabalhador, caminhoneiro, pessoa humilde
- Seja curto e profundo — respostas de 3 a 5 linhas no máximo
- Use metáforas da natureza, da estrada, da jornada
- Sempre termine com uma pergunta suave ou uma reflexão que convide a pessoa a continuar
- Se a pessoa demonstrar sofrimento intenso, acolha com muito carinho e sugira gentilmente buscar apoio de alguém de confiança
- Nunca faça previsões do futuro ou promessas — ofereça reflexão e perspectiva
- Às vezes use uma frase mais poética ou simbólica
- Assine mentalmente como "o Oráculo" — você é uma presença, não uma pessoa

PROTEÇÃO DO PROPÓSITO:
Se alguém fizer perguntas fora do propósito espiritual/emocional, redirecione com elegância:
- "Há outros caminhos para isso, amigo. Este espaço é guardado para o que vem do coração. Há algo que esteja pesando em você?"
- "Meu caminho é outro. Aqui só acolho o que vem da alma. Quer me contar como está se sentindo?"

Nunca se irrite, nunca quebre o personagem. A serenidade é sua maior força.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ erro: "Método não permitido" });
    return;
  }

  // 1) Confere o login ────────────────────────────────────────────────
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ erro: "Não autenticado" });
    return;
  }

  let uid;
  try {
    const decodificado = await getAuthAdmin().verifyIdToken(token);
    uid = decodificado.uid;
  } catch (err) {
    console.error("[api/oraculo] Token inválido:", err.message);
    res.status(401).json({ erro: "Sessão expirada. Faça login novamente." });
    return;
  }

  const { mensagens } = req.body || {};
  if (!Array.isArray(mensagens) || mensagens.length === 0) {
    res.status(400).json({ erro: "Mensagens inválidas" });
    return;
  }

  // 2) Confere se ainda tem consultas/créditos ────────────────────────
  const db = getFirestoreAdmin();
  const userRef = db.collection("usuarios").doc(uid);
  const snap = await userRef.get();
  const dados = snap.exists ? snap.data() : {};
  const premium = dados.premium || false;
  const consultasUsadas = dados.consultasUsadas || 0;
  const creditosAvulsos = dados.creditosAvulsos || 0;
  const restantesGratis = Math.max(0, LIMITE_GRATUITO - consultasUsadas);

  if (!premium && restantesGratis <= 0 && creditosAvulsos <= 0) {
    res.status(402).json({ erro: "Limite de consultas atingido" });
    return;
  }

  // 3) Chama a Anthropic — a chave só existe aqui, no servidor ────────
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) {
    console.error("[api/oraculo] Falta a variável de ambiente ANTHROPIC_API_KEY no Vercel.");
    res.status(500).json({ erro: "Configuração ausente no servidor" });
    return;
  }

  let resposta;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": chave,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 400,
        system: ORACULO_SYSTEM,
        messages: mensagens.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    const d = await r.json();
    resposta = d.content?.find((b) => b.type === "text")?.text || "";
    if (!resposta) {
      console.error("[api/oraculo] Resposta inesperada da Anthropic:", JSON.stringify(d));
      throw new Error("Resposta vazia");
    }
  } catch (err) {
    console.error("[api/oraculo] Erro ao consultar a Anthropic:", err);
    res.status(502).json({ erro: "Erro ao consultar o Oráculo" });
    return;
  }

  // 4) Debita a consulta — só agora, depois da resposta ter vindo com
  //    sucesso — priorizando consultas gratuitas e só depois os créditos
  //    do pacote avulso. Isso substitui o débito que antes era feito pelo
  //    navegador (e que uma pessoa mal-intencionada poderia simplesmente
  //    não chamar, usando o Oráculo de graça pra sempre).
  let novoConsultasUsadas = consultasUsadas;
  let novoCreditosAvulsos = creditosAvulsos;
  if (!premium) {
    if (restantesGratis > 0) {
      novoConsultasUsadas = consultasUsadas + 1;
      await userRef.set({ consultasUsadas: FieldValue.increment(1) }, { merge: true });
    } else if (creditosAvulsos > 0) {
      novoCreditosAvulsos = creditosAvulsos - 1;
      await userRef.set({ creditosAvulsos: FieldValue.increment(-1) }, { merge: true });
    }
  }

  res.status(200).json({
    resposta,
    consultasUsadas: novoConsultasUsadas,
    creditosAvulsos: novoCreditosAvulsos,
  });
}
