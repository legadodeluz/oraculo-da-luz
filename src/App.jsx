import { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
import { getFirestore, doc, getDoc, setDoc, updateDoc, arrayUnion, serverTimestamp, onSnapshot } from "firebase/firestore";

// ── Firebase config ────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyD9XZv4TvRTacCiGHmFvLz4lKWb2yVyxqI",
  authDomain: "oraculo-da-luz.firebaseapp.com",
  projectId: "oraculo-da-luz",
  storageBucket: "oraculo-da-luz.firebasestorage.app",
  messagingSenderId: "1030908591747",
  appId: "1:1030908591747:web:9c1187064d6fe240e2e5b6"
};
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

// ── Constantes ─────────────────────────────────────────────────────
const LIMITE_GRATUITO = 10;
// Isto é só o número mostrado na tela. Quem realmente credita as consultas é o
// webhook (api/stripe-webhook.js) — se mudar aqui, mude lá também.
const CREDITOS_PACOTE_AVULSO = 30;
const STRIPE_PAYMENT_LINK_ASSINATURA = "https://buy.stripe.com/eVqbJ1dFT91TdNY37NbMQ00";
// TODO(Hélio): troque pelo link do produto "Pacote de 30 consultas" (R$19,90, pagamento único)
// depois de criá-lo no painel do Stripe.
const STRIPE_PAYMENT_LINK_PACOTE = "https://buy.stripe.com/SEU_LINK_DO_PACOTE_AQUI";

const OPENING_PHRASES = [
  "O que está pesando no seu coração hoje?",
  "Qual pensamento não te deixa em paz neste momento?",
  "O que você gostaria de compartilhar com o universo agora?",
  "Fale comigo. Estou aqui, sem julgamentos.",
  "O que sua alma está tentando te dizer?",
];

const REFLEXOES_INICIAIS = [
  "✨ Cada jornada tem seu tempo. O seu momento está chegando.",
  "🕯️ A escuridão que você sente hoje é o prelúdio da luz que vem.",
  "🌿 Nada do que você viveu foi em vão. Tudo tem um propósito.",
  "⭐ Você é mais forte do que imagina. Sua alma sabe disso.",
];

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

// ── Firestore helpers ──────────────────────────────────────────────
// Importante: premium, creditosAvulsos, stripeCustomerId e stripeSubscriptionId
// só são concedidos pelo webhook do Stripe (api/stripe-webhook.js), que roda no
// servidor e confirma o pagamento de verdade. O app aqui só LÊ esses campos e,
// no máximo, consome (diminui) créditos avulsos — nunca concede acesso sozinho.
async function getUserData(uid) {
  const ref = doc(db, "usuarios", uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return snap.data();
  const novo = { consultasUsadas: 0, premium: false, creditosAvulsos: 0, criadoEm: serverTimestamp(), historico: [] };
  await setDoc(ref, novo);
  return novo;
}

async function incrementarConsultaDB(uid) {
  const ref = doc(db, "usuarios", uid);
  const snap = await getDoc(ref);
  const atual = snap.data()?.consultasUsadas || 0;
  await updateDoc(ref, { consultasUsadas: atual + 1 });
  return atual + 1;
}

async function consumirCreditoAvulsoDB(uid) {
  const ref = doc(db, "usuarios", uid);
  const snap = await getDoc(ref);
  const atual = snap.data()?.creditosAvulsos || 0;
  if (atual <= 0) return 0;
  await updateDoc(ref, { creditosAvulsos: atual - 1 });
  return atual - 1;
}

async function salvarMensagemDB(uid, role, content) {
  await updateDoc(doc(db, "usuarios", uid), {
    historico: arrayUnion({ role, content, timestamp: new Date().toISOString() })
  });
}

// ── API Oráculo ────────────────────────────────────────────────────
async function consultarOraculo(mensagens) {
  const chave = import.meta.env.VITE_ANTHROPIC_KEY;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": chave,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      system: ORACULO_SYSTEM,
      messages: mensagens.map(m => ({ role: m.role, content: m.content })),
    }),
  });
  const d = await r.json();
  return d.content?.find(b => b.type === "text")?.text || "";
}

// ── Componentes visuais ────────────────────────────────────────────
function Stars() {
  const stars = Array.from({ length: 60 }, (_, i) => ({
    id: i, x: Math.random() * 100, y: Math.random() * 100,
    size: Math.random() * 2.5 + 0.5, delay: Math.random() * 4, duration: Math.random() * 3 + 2,
  }));
  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0 }}>
      {stars.map(s => (
        <div key={s.id} style={{
          position: "absolute", left: `${s.x}%`, top: `${s.y}%`,
          width: s.size, height: s.size, borderRadius: "50%", background: "#fff",
          opacity: 0, animation: `twinkle ${s.duration}s ease-in-out ${s.delay}s infinite`,
        }} />
      ))}
    </div>
  );
}

function Flame() {
  return (
    <div style={{ position: "relative", width: 60, height: 80, margin: "0 auto" }}>
      <div style={{ position: "absolute", bottom: 0, left: "50%", transform: "translateX(-50%)", width: 12, height: 20, background: "linear-gradient(to top, #8B6914, #C8A84B)", borderRadius: "50% 50% 0 0" }} />
      <div style={{ position: "absolute", bottom: 14, left: "50%", transform: "translateX(-50%)", width: 28, height: 42, background: "linear-gradient(to top, #f97316, #fbbf24, #fef3c7)", borderRadius: "50% 50% 30% 30%", animation: "flicker 1.8s ease-in-out infinite", filter: "blur(0.5px)" }} />
      <div style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", width: 16, height: 28, background: "linear-gradient(to top, #fbbf24, #fef9c3, rgba(255,255,255,0.9))", borderRadius: "50% 50% 30% 30%", animation: "flicker 1.4s ease-in-out 0.3s infinite" }} />
      <div style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)", width: 60, height: 60, background: "radial-gradient(circle, rgba(251,191,36,0.25) 0%, transparent 70%)", animation: "glow 2s ease-in-out infinite" }} />
    </div>
  );
}

function Mensagem({ msg, index }) {
  const isUser = msg.role === "user";
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 16, animation: `fadeUp 0.4s ease ${index * 0.05}s both` }}>
      {!isUser && (
        <div style={{ width: 32, height: 32, borderRadius: "50%", flexShrink: 0, marginRight: 10, marginTop: 2, background: "radial-gradient(circle, #fbbf24, #f97316)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, boxShadow: "0 0 12px rgba(251,191,36,0.5)" }}>✦</div>
      )}
      <div style={{ maxWidth: "78%", padding: "13px 17px", borderRadius: isUser ? "20px 20px 4px 20px" : "20px 20px 20px 4px", background: isUser ? "rgba(139,100,20,0.25)" : "rgba(255,255,255,0.06)", border: `1px solid ${isUser ? "rgba(200,168,75,0.3)" : "rgba(251,191,36,0.15)"}`, backdropFilter: "blur(10px)" }}>
        <p style={{ color: isUser ? "#fef3c7" : "#f5e6c8", fontSize: 16, lineHeight: 1.75, margin: 0, fontFamily: "'Lora', Georgia, serif", whiteSpace: "pre-wrap" }}>{msg.content}</p>
      </div>
    </div>
  );
}

// ── Modal Upgrade ──────────────────────────────────────────────────
function ModalUpgrade({ onFechar, uid }) {
  // O redirect_url só sinaliza pro app mostrar "estamos confirmando seu pagamento" —
  // quem realmente libera o acesso é o webhook do Stripe, do lado do servidor.
  const redirectUrl = encodeURIComponent(window.location.origin + "/?pago=true");

  function irParaAssinatura() {
    const url = `${STRIPE_PAYMENT_LINK_ASSINATURA}?client_reference_id=${uid}&redirect_url=${redirectUrl}`;
    window.open(url, "_blank");
  }

  function irParaPacote() {
    const url = `${STRIPE_PAYMENT_LINK_PACOTE}?client_reference_id=${uid}&redirect_url=${redirectUrl}`;
    window.open(url, "_blank");
  }

  const cardStyle = { background: "rgba(251,191,36,0.05)", border: "1px solid rgba(251,191,36,0.15)", borderRadius: 16, padding: "18px 16px", marginBottom: 14, textAlign: "left" };
  const btnStyle = { width: "100%", background: "linear-gradient(135deg, #f97316, #fbbf24)", border: "none", borderRadius: 100, padding: "13px", color: "#1a0a2e", fontSize: 13.5, fontFamily: "'Cinzel',serif", letterSpacing: 1.5, fontWeight: 700, cursor: "pointer", boxShadow: "0 0 20px rgba(251,191,36,0.35)", marginTop: 12 };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(5,2,16,0.92)", backdropFilter: "blur(16px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", animation: "fadeIn 0.3s ease", overflowY: "auto" }}>
      <div style={{ background: "linear-gradient(145deg, rgba(20,10,40,0.98), rgba(10,5,25,0.98))", border: "1px solid rgba(251,191,36,0.25)", borderRadius: 24, padding: "32px 26px", maxWidth: 380, width: "100%", textAlign: "center", boxShadow: "0 0 60px rgba(251,191,36,0.08)", animation: "fadeUp 0.4s ease", margin: "auto" }}>
        <div style={{ width: 60, height: 60, borderRadius: "50%", background: "radial-gradient(circle, rgba(251,191,36,0.2), rgba(249,115,22,0.1))", border: "1px solid rgba(251,191,36,0.3)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", fontSize: 24, animation: "pulse-gold 3s ease-in-out infinite" }}>🕯️</div>
        <p style={{ fontFamily: "'Cinzel',serif", fontSize: 11, letterSpacing: 5, color: "rgba(251,191,36,0.6)", textTransform: "uppercase", marginBottom: 8 }}>Legado de Luz</p>
        <h2 style={{ fontFamily: "'Cinzel',serif", fontSize: 20, color: "#fef3c7", letterSpacing: 1, marginBottom: 10, lineHeight: 1.3 }}>Sua jornada continua</h2>
        <p style={{ color: "rgba(254,243,199,0.55)", fontSize: 13, lineHeight: 1.7, fontStyle: "italic", marginBottom: 22 }}>
          Escolha a forma que combina melhor com você.
        </p>

        {/* Assinatura */}
        <div style={cardStyle}>
          <p style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: "#fbbf24", letterSpacing: 1, marginBottom: 6 }}>✦ Acesso Ilimitado</p>
          <p style={{ color: "rgba(254,243,199,0.6)", fontSize: 12, lineHeight: 1.7, fontStyle: "italic", marginBottom: 8 }}>Consultas sem limite, todo mês. Cancele quando quiser.</p>
          <span style={{ fontFamily: "'Cinzel',serif", fontSize: 26, fontWeight: 700, color: "#fef3c7" }}>R$ 9,90</span>
          <span style={{ color: "rgba(254,243,199,0.4)", fontSize: 12, marginLeft: 5, fontStyle: "italic" }}>/mês</span>
          <button onClick={irParaAssinatura} style={btnStyle}>✦ Assinar Acesso Ilimitado</button>
        </div>

        {/* Pacote avulso */}
        <div style={cardStyle}>
          <p style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: "#fbbf24", letterSpacing: 1, marginBottom: 6 }}>✦ Pacote de {CREDITOS_PACOTE_AVULSO} Consultas</p>
          <p style={{ color: "rgba(254,243,199,0.6)", fontSize: 12, lineHeight: 1.7, fontStyle: "italic", marginBottom: 8 }}>Uma consulta para cada dia do mês. Sem renovação automática.</p>
          <span style={{ fontFamily: "'Cinzel',serif", fontSize: 26, fontWeight: 700, color: "#fef3c7" }}>R$ 19,90</span>
          <span style={{ color: "rgba(254,243,199,0.4)", fontSize: 12, marginLeft: 5, fontStyle: "italic" }}>pagamento único</span>
          <button onClick={irParaPacote} style={btnStyle}>✦ Comprar Pacote de {CREDITOS_PACOTE_AVULSO}</button>
        </div>

        <p style={{ color: "rgba(254,243,199,0.2)", fontSize: 10, fontStyle: "italic", margin: "8px 0 16px" }}>Pagamento seguro via Stripe</p>
        {onFechar && <button onClick={onFechar} style={{ background: "none", border: "none", color: "rgba(254,243,199,0.25)", fontSize: 12, cursor: "pointer", fontFamily: "'Lora',serif", fontStyle: "italic" }}>Voltar</button>}
      </div>
    </div>
  );
}

// ── Tela de Login ──────────────────────────────────────────────────
function TelaLogin() {
  const [modo, setModo]           = useState("inicio"); // inicio | entrar | cadastrar | recuperar
  const [email, setEmail]         = useState("");
  const [senha, setSenha]         = useState("");
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro]           = useState("");
  const [sucesso, setSucesso]     = useState("");

  async function loginGoogle() {
    setCarregando(true); setErro("");
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) { setErro("Não foi possível fazer login com Google. Tente novamente."); }
    setCarregando(false);
  }

  async function loginEmail() {
    if (!email || !senha) { setErro("Preencha e-mail e senha."); return; }
    setCarregando(true); setErro("");
    try {
      await signInWithEmailAndPassword(auth, email, senha);
    } catch (e) {
      if (e.code === "auth/invalid-credential") setErro("E-mail ou senha incorretos.");
      else if (e.code === "auth/user-not-found") setErro("Usuário não encontrado.");
      else setErro("Erro ao entrar. Tente novamente.");
    }
    setCarregando(false);
  }

  async function cadastrarEmail() {
    if (!email || !senha) { setErro("Preencha e-mail e senha."); return; }
    if (senha.length < 6) { setErro("A senha deve ter pelo menos 6 caracteres."); return; }
    setCarregando(true); setErro("");
    try {
      await createUserWithEmailAndPassword(auth, email, senha);
    } catch (e) {
      if (e.code === "auth/email-already-in-use") setErro("Este e-mail já está cadastrado.");
      else setErro("Erro ao criar conta. Tente novamente.");
    }
    setCarregando(false);
  }

  async function recuperarSenha() {
    if (!email) { setErro("Digite seu e-mail."); return; }
    setCarregando(true); setErro(""); setSucesso("");
    try {
      await sendPasswordResetEmail(auth, email);
      setSucesso("E-mail de recuperação enviado! Verifique sua caixa de entrada.");
    } catch (e) { setErro("Erro ao enviar e-mail. Verifique o endereço digitado."); }
    setCarregando(false);
  }

  const inputStyle = { width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(251,191,36,0.25)", borderRadius: 14, padding: "13px 18px", color: "#fef3c7", fontSize: 14, fontFamily: "'Lora',Georgia,serif", fontStyle: "italic", outline: "none", letterSpacing: 1 };
  const btnPrimary = { width: "100%", background: "linear-gradient(135deg,rgba(139,100,20,0.5),rgba(200,168,75,0.3))", border: "1px solid rgba(251,191,36,0.4)", borderRadius: 100, padding: "14px", color: "#fef3c7", fontSize: 14, fontFamily: "'Cinzel',serif", letterSpacing: 2, cursor: "pointer" };
  const btnLink = { background: "none", border: "none", color: "rgba(251,191,36,0.5)", fontSize: 12, cursor: "pointer", fontFamily: "'Lora',serif", fontStyle: "italic", textDecoration: "underline" };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 24px", minHeight: "100vh", animation: "fadeIn 1s ease", position: "relative", zIndex: 1 }}>
      <div style={{ animation: "float 4s ease-in-out infinite", marginBottom: 24 }}><Flame /></div>
      <p style={{ fontFamily: "'Cinzel',serif", fontSize: 11, letterSpacing: 6, color: "rgba(251,191,36,0.5)", textTransform: "uppercase", marginBottom: 8 }}>Legado de Luz</p>
      <h1 style={{ fontFamily: "'Cinzel',serif", fontSize: "clamp(28px,7vw,44px)", fontWeight: 700, color: "#fef3c7", textAlign: "center", lineHeight: 1.2, marginBottom: 6, letterSpacing: 2, textShadow: "0 0 40px rgba(251,191,36,0.3)" }}>O Oráculo</h1>
      <div style={{ width: 50, height: 1, background: "linear-gradient(90deg,transparent,rgba(251,191,36,0.5),transparent)", margin: "12px auto 24px" }} />

      <div style={{ width: "100%", maxWidth: 300, display: "flex", flexDirection: "column", gap: 10 }}>

        {/* Google */}
        <button onClick={loginGoogle} disabled={carregando} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, background: "rgba(255,255,255,0.95)", border: "none", borderRadius: 100, padding: "13px 24px", cursor: "pointer", fontSize: 14, fontWeight: 600, color: "#1a1a1a", boxShadow: "0 4px 20px rgba(0,0,0,0.3)" }}>
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          {carregando ? "Entrando..." : "Entrar com Google"}
        </button>

        {/* Divisor */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0" }}>
          <div style={{ flex: 1, height: 1, background: "rgba(251,191,36,0.15)" }} />
          <p style={{ color: "rgba(254,243,199,0.25)", fontSize: 11, fontStyle: "italic" }}>ou</p>
          <div style={{ flex: 1, height: 1, background: "rgba(251,191,36,0.15)" }} />
        </div>

        {/* Formulário email/senha */}
        {modo === "recuperar" ? (
          <>
            <p style={{ color: "rgba(254,243,199,0.5)", fontSize: 13, textAlign: "center", fontStyle: "italic" }}>Digite seu e-mail para recuperar a senha</p>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Seu e-mail..." style={inputStyle} />
            <button onClick={recuperarSenha} disabled={carregando} style={btnPrimary}>{carregando ? "Enviando..." : "Enviar recuperação"}</button>
            {sucesso && <p style={{ color: "#6EE7B7", fontSize: 12, textAlign: "center", fontStyle: "italic" }}>{sucesso}</p>}
            <button onClick={() => { setModo("entrar"); setErro(""); setSucesso(""); }} style={btnLink}>← Voltar</button>
          </>
        ) : (
          <>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Seu e-mail..." style={inputStyle} />
            <input type="password" value={senha} onChange={e => setSenha(e.target.value)} placeholder="Sua senha..." style={inputStyle} onKeyDown={e => e.key === "Enter" && (modo === "entrar" ? loginEmail() : cadastrarEmail())} />
            {modo === "cadastrar" ? (
              <>
                <button onClick={cadastrarEmail} disabled={carregando} style={btnPrimary}>{carregando ? "Criando conta..." : "Criar conta"}</button>
                <button onClick={() => { setModo("entrar"); setErro(""); }} style={btnLink}>Já tenho conta</button>
              </>
            ) : (
              <>
                <button onClick={loginEmail} disabled={carregando} style={btnPrimary}>{carregando ? "Entrando..." : "Entrar com e-mail"}</button>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <button onClick={() => { setModo("cadastrar"); setErro(""); }} style={btnLink}>Criar conta</button>
                  <button onClick={() => { setModo("recuperar"); setErro(""); }} style={btnLink}>Esqueci a senha</button>
                </div>
              </>
            )}
          </>
        )}

        {erro && <p style={{ color: "#f87171", fontSize: 12, textAlign: "center", fontStyle: "italic", margin: 0 }}>{erro}</p>}
      </div>

      <p style={{ color: "rgba(254,243,199,0.15)", fontSize: 10, marginTop: 32, fontStyle: "italic", textAlign: "center" }}>Seus dados são privados e protegidos.</p>
    </div>
  );
}

const MUSICA_URL = "/hirohasaimoto-gentle-as-forever-484820.mp3";

// Quantas mensagens recentes (do histórico salvo) recarregar como contexto
// quando o usuário reabre a conversa — equilíbrio entre continuidade e custo.
const HISTORICO_CONTEXTO = 20;

// ── App principal ──────────────────────────────────────────────────
export default function App() {
  const [tela, setTela]               = useState("login");
  const [usuario, setUsuario]         = useState(null);
  const [dadosUsuario, setDadosUsuario] = useState(null);
  const [carregandoAuth, setCarregandoAuth] = useState(true);
  const [mensagens, setMensagens]     = useState([]);
  const [input, setInput]             = useState("");
  const [carregando, setCarregando]   = useState(false);
  const [reflexao, setReflexao]       = useState(0);
  const [mostrarCVV, setMostrarCVV]   = useState(false);
  const [musicaAtiva, setMusicaAtiva] = useState(false);
  const [vozAtiva, setVozAtiva]       = useState(false);
  const [escutando, setEscutando]     = useState(false);
  const [vozes, setVozes]             = useState([]);
  const [vozSelecionada, setVozSelecionada] = useState(null);
  const [mostrarVozes, setMostrarVozes]     = useState(false);
  const [velocidade, setVelocidade]         = useState(0.85);
  const [tom, setTom]                       = useState(0.92);
  const [mostrarPaywall, setMostrarPaywall] = useState(false);
  const [mostrarHistorico, setMostrarHistorico] = useState(false);
  const [confirmandoPagamento, setConfirmandoPagamento] = useState(false);
  const [mostrarBotaoTopo, setMostrarBotaoTopo]   = useState(false);
  const [mostrarBotaoFundo, setMostrarBotaoFundo] = useState(false);

  const bottomRef      = useRef(null);
  const inputRef       = useRef(null);
  const audioRef       = useRef(null);
  const recognitionRef = useRef(null);
  const mensagensRef   = useRef(null);

  // ── Auth listener ──────────────────────────────────────────────
  // Quem concede premium/créditos é sempre o webhook do Stripe (servidor).
  // Aqui o app só escuta o documento do usuário em tempo real (onSnapshot),
  // então assim que o webhook gravar a confirmação, a tela atualiza sozinha.
  useEffect(() => {
    let unsubDoc = null;

    const unsub = onAuthStateChanged(auth, async (user) => {
      setUsuario(user);
      if (unsubDoc) { unsubDoc(); unsubDoc = null; }

      if (user) {
        await getUserData(user.uid); // garante que o doc existe (cria se for a primeira vez)
        const ref = doc(db, "usuarios", user.uid);
        unsubDoc = onSnapshot(ref, (snap) => {
          if (snap.exists()) setDadosUsuario(snap.data());
        });

        // Detecta retorno do Stripe — só mostra uma mensagem de "confirmando",
        // não ativa nada aqui. Quem libera de fato é o webhook.
        const params = new URLSearchParams(window.location.search);
        if (params.get("pago") === "true") {
          setConfirmandoPagamento(true);
          window.history.replaceState({}, "", window.location.pathname);
          setTimeout(() => setConfirmandoPagamento(false), 8000);
        }
      } else {
        setDadosUsuario(null);
      }
      setCarregandoAuth(false);
    });

    return () => { unsub(); if (unsubDoc) unsubDoc(); };
  }, []);

  useEffect(() => {
    function carregarVozes() {
      const vs = window.speechSynthesis?.getVoices() || [];
      if (vs.length === 0) return;
      const vsPT = vs.filter(v => v.lang.startsWith("pt"));
      setVozes(vsPT.length > 0 ? vsPT : vs);
    }
    carregarVozes();
    window.speechSynthesis?.addEventListener("voiceschanged", carregarVozes);
    const t1 = setTimeout(carregarVozes, 500);
    const t2 = setTimeout(carregarVozes, 1500);
    return () => { window.speechSynthesis?.removeEventListener("voiceschanged", carregarVozes); clearTimeout(t1); clearTimeout(t2); };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setReflexao(p => (p + 1) % REFLEXOES_INICIAIS.length), 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    const t = setTimeout(atualizarBotoesDeScroll, 400); // dá tempo do scroll suave terminar antes de checar a posição
    return () => clearTimeout(t);
  }, [mensagens, carregando]);

  // Mostra/esconde os botões flutuantes de "ir para o topo" e "ir para o fim"
  // com base em quanto falta rolar em cada direção dentro da conversa.
  function atualizarBotoesDeScroll() {
    const el = mensagensRef.current;
    if (!el) return;
    setMostrarBotaoTopo(el.scrollTop > 200);
    setMostrarBotaoFundo(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
  }

  function irParaTopo() {
    mensagensRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function irParaFundo() {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  function abaixarMusica() { if (audioRef.current && musicaAtiva) audioRef.current.volume = 0.06; }
  function subirMusica() { if (audioRef.current && musicaAtiva) audioRef.current.volume = 0.25; }

  function toggleMusica() {
    if (!audioRef.current) { audioRef.current = new Audio(MUSICA_URL); audioRef.current.loop = true; audioRef.current.volume = 0.25; }
    if (musicaAtiva) { audioRef.current.pause(); setMusicaAtiva(false); }
    else { audioRef.current.play().catch(() => {}); setMusicaAtiva(true); }
  }

  function toggleVoz() { if (vozAtiva) window.speechSynthesis?.cancel(); setVozAtiva(v => !v); setMostrarVozes(false); }

  function falarTexto(texto) {
    if (!vozAtiva || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(texto);
    utter.lang = "pt-BR"; utter.rate = velocidade; utter.pitch = tom;
    if (vozSelecionada) utter.voice = vozSelecionada;
    else { const vs = window.speechSynthesis.getVoices(); const v = vs.find(v => v.lang.startsWith("pt")) || null; if (v) utter.voice = v; }
    utter.onstart = () => abaixarMusica(); utter.onend = () => subirMusica(); utter.onerror = () => subirMusica();
    window.speechSynthesis.speak(utter);
  }

  function iniciarVoz() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Seu navegador não suporta voz. Use o Chrome."); return; }
    if (escutando) { recognitionRef.current?.stop(); setEscutando(false); return; }
    const rec = new SR();
    rec.lang = "pt-BR"; rec.continuous = false; rec.interimResults = false;
    rec.onstart = () => setEscutando(true); rec.onend = () => setEscutando(false); rec.onerror = () => setEscutando(false);
    rec.onresult = e => setInput(e.results[0][0].transcript);
    recognitionRef.current = rec; rec.start();
  }



  function entrar() {
    setTela("oraculo");
    // Recarrega as últimas mensagens salvas para o Oráculo ter continuidade
    // com o que já foi conversado, em vez de começar sempre do zero.
    if (mensagens.length === 0 && dadosUsuario?.historico?.length > 0) {
      const recentes = dadosUsuario.historico
        .slice(-HISTORICO_CONTEXTO)
        .map(({ role, content }) => ({ role, content }));
      setMensagens(recentes);
    }
    setTimeout(() => inputRef.current?.focus(), 400);
    setTimeout(() => {
      if (!audioRef.current) { audioRef.current = new Audio(MUSICA_URL); audioRef.current.loop = true; audioRef.current.volume = 0.25; }
      audioRef.current.play().catch(() => {}); setMusicaAtiva(true);
    }, 800);
  }

  function detectarCrise(texto) {
    return ["suicídio","suicidio","me matar","acabar com tudo","não quero mais viver","nao quero mais viver","me machucar","desesperado","desesperada"].some(p => texto.toLowerCase().includes(p));
  }

  function compartilhar() {
    const url = window.location.href;
    if (navigator.share) navigator.share({ title: "O Oráculo · Legado de Luz", text: "✨ Um espaço de acolhimento e reflexão: ", url });
    else { navigator.clipboard.writeText(url); alert("Link copiado! 🕯️"); }
  }

  async function fazerLogout() {
    await signOut(auth);
    setUsuario(null); setDadosUsuario(null);
    setTela("login"); setMensagens([]);
    window.speechSynthesis?.cancel();
    if (audioRef.current) { audioRef.current.pause(); setMusicaAtiva(false); }
  }

  async function enviar() {
    if (!input.trim() || carregando || !usuario) return;
    const premium = dadosUsuario?.premium || false;
    const consultasUsadas = dadosUsuario?.consultasUsadas || 0;
    const creditosAvulsos = dadosUsuario?.creditosAvulsos || 0;
    const restantesGratis = Math.max(0, LIMITE_GRATUITO - consultasUsadas);
    if (!premium && restantesGratis <= 0 && creditosAvulsos <= 0) { setMostrarPaywall(true); return; }
    const texto = input.trim();
    setInput("");
    if (detectarCrise(texto)) setMostrarCVV(true);
    const novas = [...mensagens, { role: "user", content: texto }];
    setMensagens(novas);
    setCarregando(true);
    try {
      const resposta = await consultarOraculo(novas);
      setMensagens([...novas, { role: "assistant", content: resposta }]);
      falarTexto(resposta);
      if (!premium) {
        // Consome primeiro as consultas gratuitas; só depois os créditos avulsos comprados.
        if (restantesGratis > 0) {
          const novoTotal = await incrementarConsultaDB(usuario.uid);
          setDadosUsuario(d => ({ ...d, consultasUsadas: novoTotal }));
        } else if (creditosAvulsos > 0) {
          const novoTotal = await consumirCreditoAvulsoDB(usuario.uid);
          setDadosUsuario(d => ({ ...d, creditosAvulsos: novoTotal }));
        }
      }
      await salvarMensagemDB(usuario.uid, "user", texto);
      await salvarMensagemDB(usuario.uid, "assistant", resposta);
    } catch {
      setMensagens([...novas, { role: "assistant", content: "O silêncio também é uma resposta. Respire fundo e tente novamente..." }]);
    }
    setCarregando(false);
  }

  const premium = dadosUsuario?.premium || false;
  const consultasUsadas = dadosUsuario?.consultasUsadas || 0;
  const creditosAvulsos = dadosUsuario?.creditosAvulsos || 0;
  const restantesGratis = Math.max(0, LIMITE_GRATUITO - consultasUsadas);
  const restantes = premium ? null : restantesGratis + creditosAvulsos;

  if (carregandoAuth) return (
    <div style={{ minHeight: "100vh", background: "radial-gradient(ellipse at 20% 20%, #1a0a2e 0%, #050210 100%)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <p style={{ color: "rgba(251,191,36,0.5)", fontFamily: "'Cinzel',serif", letterSpacing: 3, fontSize: 14 }}>✦ Carregando ✦</p>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", width: "100%", background: "radial-gradient(ellipse at 20% 20%, #1a0a2e 0%, #0d0618 40%, #050210 100%)", display: "flex", flexDirection: "column", alignItems: "center", fontFamily: "'Lora', Georgia, serif", position: "relative", overflow: "hidden" }}>
      <Stars />
      <div style={{ position: "fixed", top: "-20%", right: "-10%", width: 500, height: 500, borderRadius: "50%", background: "radial-gradient(circle, rgba(88,28,135,0.15) 0%, transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "fixed", bottom: "-10%", left: "-10%", width: 400, height: 400, borderRadius: "50%", background: "radial-gradient(circle, rgba(30,58,138,0.12) 0%, transparent 70%)", pointerEvents: "none" }} />

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Cinzel:wght@400;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: rgba(251,191,36,0.2); border-radius: 10px; }
        textarea { resize: none; } textarea::placeholder { color: rgba(254,243,199,0.35); font-style: italic; }
        @keyframes twinkle { 0%,100%{opacity:0} 50%{opacity:0.8} }
        @keyframes flicker { 0%,100%{transform:translateX(-50%) scaleX(1)} 25%{transform:translateX(-52%) scaleX(0.95) scaleY(1.05)} 75%{transform:translateX(-48%) scaleX(1.05) scaleY(0.97)} }
        @keyframes glow { 0%,100%{opacity:0.6;transform:translateX(-50%) scale(1)} 50%{opacity:1;transform:translateX(-50%) scale(1.2)} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
        @keyframes fadeIn { from{opacity:0} to{opacity:1} }
        @keyframes pulse-gold { 0%,100%{box-shadow:0 0 20px rgba(251,191,36,0.3)} 50%{box-shadow:0 0 40px rgba(251,191,36,0.6)} }
        @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-8px)} }
        @keyframes rotate-slow { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
      `}</style>

      {mostrarPaywall && <ModalUpgrade uid={usuario?.uid} onFechar={() => setMostrarPaywall(false)} />}

      {confirmandoPagamento && (
        <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 1200, background: "rgba(10,5,25,0.97)", border: "1px solid rgba(251,191,36,0.35)", borderRadius: 100, padding: "10px 20px", boxShadow: "0 4px 24px rgba(0,0,0,0.4)", animation: "fadeUp 0.4s ease" }}>
          <p style={{ color: "#fbbf24", fontSize: 12.5, fontStyle: "italic", margin: 0 }}>✦ Confirmando seu pagamento com o Stripe... isso pode levar alguns segundos.</p>
        </div>
      )}


      {/* ── TELA LOGIN ── */}
      {tela === "login" && usuario === null && <TelaLogin />}

      {/* ── TELA ENTRADA (após login) ── */}
      {tela === "login" && usuario !== null && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 24px", minHeight: "100vh", animation: "fadeIn 1.2s ease", position: "relative", zIndex: 1 }}>
          <div style={{ position: "relative", marginBottom: 32, animation: "float 4s ease-in-out infinite" }}>
            <div style={{ width: 120, height: 120, borderRadius: "50%", border: "1px solid rgba(251,191,36,0.2)", position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", animation: "rotate-slow 20s linear infinite" }}>
              {[0,60,120,180,240,300].map(deg => <div key={deg} style={{ position: "absolute", width: 4, height: 4, borderRadius: "50%", background: "rgba(251,191,36,0.5)", top: "50%", left: "50%", transform: `rotate(${deg}deg) translateX(58px) translate(-50%,-50%)` }} />)}
            </div>
            <Flame />
          </div>
          <p style={{ fontFamily: "'Cinzel',serif", fontSize: 11, letterSpacing: 6, color: "rgba(251,191,36,0.5)", textTransform: "uppercase", marginBottom: 10 }}>Legado de Luz</p>
          <h1 style={{ fontFamily: "'Cinzel',serif", fontSize: "clamp(36px,8vw,52px)", fontWeight: 700, color: "#fef3c7", textAlign: "center", lineHeight: 1.2, marginBottom: 8, letterSpacing: 2, textShadow: "0 0 40px rgba(251,191,36,0.3)" }}>O Oráculo</h1>
          <div style={{ width: 60, height: 1, background: "linear-gradient(90deg, transparent, rgba(251,191,36,0.5), transparent)", margin: "16px auto 24px" }} />

          {/* Saudação ao usuário */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(251,191,36,0.12)", borderRadius: 100, padding: "8px 16px" }}>
            {usuario.photoURL && <img src={usuario.photoURL} alt="" style={{ width: 28, height: 28, borderRadius: "50%", border: "1px solid rgba(251,191,36,0.3)" }} />}
            <p style={{ color: "rgba(254,243,199,0.6)", fontSize: 13, fontStyle: "italic" }}>Olá, {usuario.displayName?.split(" ")[0]} ✦</p>
          </div>

          {!premium ? (
            <p style={{ color: "rgba(251,191,36,0.45)", fontSize: 12, textAlign: "center", fontStyle: "italic", marginBottom: 24 }}>
              ✦ {restantes} consulta{restantes !== 1 ? "s" : ""} gratuita{restantes !== 1 ? "s" : ""} restante{restantes !== 1 ? "s" : ""}
            </p>
          ) : (
            <p style={{ color: "rgba(110,231,183,0.5)", fontSize: 12, textAlign: "center", fontStyle: "italic", marginBottom: 24 }}>✦ Acesso completo ativo</p>
          )}

          <button onClick={entrar} style={{ background: "linear-gradient(135deg, rgba(139,100,20,0.4), rgba(200,168,75,0.2))", border: "1px solid rgba(251,191,36,0.4)", borderRadius: 100, padding: "16px 48px", color: "#fef3c7", fontSize: 15, fontFamily: "'Cinzel',serif", letterSpacing: 3, cursor: "pointer", animation: "pulse-gold 3s ease-in-out infinite" }}>
            Consultar
          </button>

          <div style={{ display: "flex", gap: 16, marginTop: 24 }}>
            <button onClick={() => setMostrarHistorico(true)} style={{ background: "none", border: "1px solid rgba(251,191,36,0.15)", borderRadius: 100, padding: "8px 16px", color: "rgba(254,243,199,0.3)", fontSize: 11, cursor: "pointer", fontFamily: "'Cinzel',serif", letterSpacing: 1 }}>
              📖 Histórico
            </button>
            <button onClick={fazerLogout} style={{ background: "none", border: "none", color: "rgba(254,243,199,0.2)", fontSize: 11, cursor: "pointer", fontFamily: "'Lora',serif", fontStyle: "italic" }}>
              Sair
            </button>
          </div>
        </div>
      )}

      {/* ── HISTÓRICO ── */}
      {mostrarHistorico && (
        <div style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(5,2,16,0.95)", backdropFilter: "blur(16px)", display: "flex", flexDirection: "column", padding: "24px 20px", animation: "fadeIn .3s ease" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
            <p style={{ fontFamily: "'Cinzel',serif", color: "#fef3c7", fontSize: 16, letterSpacing: 2 }}>📖 Seu Histórico</p>
            <button onClick={() => setMostrarHistorico(false)} style={{ background: "none", border: "none", color: "rgba(254,243,199,0.4)", fontSize: 22, cursor: "pointer" }}>×</button>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {dadosUsuario?.historico?.length > 0 ? (
              [...dadosUsuario.historico].reverse().map((msg, i) => (
                <div key={i} style={{ marginBottom: 12, padding: "12px 16px", background: msg.role === "user" ? "rgba(139,100,20,0.15)" : "rgba(255,255,255,0.04)", border: `1px solid ${msg.role === "user" ? "rgba(200,168,75,0.2)" : "rgba(251,191,36,0.08)"}`, borderRadius: 14 }}>
                  <p style={{ color: "rgba(251,191,36,0.4)", fontSize: 10, fontFamily: "'Cinzel',serif", letterSpacing: 1, marginBottom: 4 }}>{msg.role === "user" ? "Você" : "Oráculo"} · {new Date(msg.timestamp).toLocaleDateString("pt-BR")}</p>
                  <p style={{ color: "rgba(254,243,199,0.6)", fontSize: 15, lineHeight: 1.7, fontFamily: "'Lora', Georgia, serif", fontStyle: msg.role === "assistant" ? "italic" : "normal" }}>{msg.content}</p>
                </div>
              ))
            ) : (
              <p style={{ color: "rgba(254,243,199,0.3)", textAlign: "center", fontStyle: "italic", marginTop: 40 }}>Suas conversas aparecerão aqui.</p>
            )}
          </div>
        </div>
      )}

      {/* ── TELA ORÁCULO ── */}
      {tela === "oraculo" && usuario && (
        <div style={{ display: "flex", flexDirection: "column", width: "100%", maxWidth: 600, height: "100vh", overflow: "hidden", position: "relative", zIndex: 1, animation: "fadeIn 0.8s ease" }}>
          {/* Header */}
          <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid rgba(251,191,36,0.1)", backdropFilter: "blur(20px)", background: "rgba(5,2,16,0.5)", display: "flex", alignItems: "center", gap: 14, position: "sticky", top: 0, zIndex: 10 }}>
            <button onClick={() => { setTela("login"); setMensagens([]); setMostrarCVV(false); window.speechSynthesis?.cancel(); }} style={{ background: "none", border: "none", color: "rgba(254,243,199,0.4)", fontSize: 20, cursor: "pointer", padding: "4px 8px", borderRadius: 8 }}>←</button>
            <div style={{ flex: 1, textAlign: "center" }}>
              <p style={{ fontFamily: "'Cinzel',serif", fontSize: 16, color: "#fef3c7", letterSpacing: 2, margin: 0 }}>O Oráculo</p>
              <p style={{ color: "rgba(251,191,36,0.5)", fontSize: 10, letterSpacing: 3, textTransform: "uppercase", margin: "2px 0 0", fontFamily: "'Cinzel',serif" }}>Legado de Luz</p>
            </div>
            <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
              {!premium && (
                <button onClick={() => setMostrarPaywall(true)} style={{ background: restantes <= 3 ? "rgba(248,113,113,0.1)" : "rgba(251,191,36,0.08)", border: `1px solid ${restantes <= 3 ? "rgba(248,113,113,0.3)" : "rgba(251,191,36,0.2)"}`, borderRadius: 8, padding: "4px 9px", color: restantes <= 3 ? "#f87171" : "rgba(251,191,36,0.6)", fontSize: 11, cursor: "pointer", fontFamily: "'Cinzel',serif" }}>
                  {restantes}✦
                </button>
              )}
              {premium && <span style={{ fontSize: 11, color: "rgba(110,231,183,0.5)", fontFamily: "'Cinzel',serif", padding: "4px 8px" }}>∞✦</span>}
              <button onClick={() => setMostrarHistorico(true)} title="Histórico" aria-label="Ver histórico de conversas" style={{ background: "none", border: "none", color: "rgba(254,243,199,0.35)", fontSize: 16, cursor: "pointer", padding: "4px 7px", borderRadius: 8 }}>📖</button>
              <button onClick={toggleMusica} title={musicaAtiva ? "Desativar música ambiente" : "Ativar música ambiente"} aria-label={musicaAtiva ? "Desativar música ambiente" : "Ativar música ambiente"} style={{ background: musicaAtiva ? "rgba(251,191,36,0.15)" : "none", border: musicaAtiva ? "1px solid rgba(251,191,36,0.3)" : "1px solid transparent", borderRadius: 8, color: musicaAtiva ? "#fbbf24" : "rgba(254,243,199,0.35)", fontSize: 16, cursor: "pointer", padding: "4px 7px" }}>{musicaAtiva ? "🔔" : "🔕"}</button>
              <button onClick={() => setMostrarVozes(v => !v)} title="Configurações de voz" aria-label="Configurações de voz" style={{ background: vozAtiva ? "rgba(110,231,183,0.12)" : "none", border: vozAtiva ? "1px solid rgba(110,231,183,0.3)" : "1px solid transparent", borderRadius: 8, color: vozAtiva ? "#6EE7B7" : "rgba(254,243,199,0.35)", fontSize: 16, cursor: "pointer", padding: "4px 7px" }}>{vozAtiva ? "🔊" : "🔈"}</button>
              <button onClick={compartilhar} title="Compartilhar" aria-label="Compartilhar" style={{ background: "none", border: "none", color: "rgba(254,243,199,0.35)", fontSize: 16, cursor: "pointer", padding: "4px 7px", borderRadius: 8 }}>📤</button>
            </div>
          </div>

          {/* Painel de voz */}
          {mostrarVozes && (
            <div style={{ position: "fixed", top: 70, right: 10, background: "rgba(10,5,25,0.97)", border: "1px solid rgba(251,191,36,0.2)", borderRadius: 14, padding: 12, minWidth: 200, zIndex: 100, animation: "fadeUp .2s ease" }}>
              <button onClick={toggleVoz} style={{ width: "100%", padding: "8px 10px", marginBottom: 8, background: vozAtiva ? "rgba(248,113,113,0.1)" : "rgba(110,231,183,0.1)", border: `1px solid ${vozAtiva ? "rgba(248,113,113,0.3)" : "rgba(110,231,183,0.3)"}`, borderRadius: 10, color: vozAtiva ? "#f87171" : "#6EE7B7", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                {vozAtiva ? "🔇 Desativar voz" : "🔊 Ativar voz"}
              </button>
              <button onClick={() => setMostrarVozes(false)} style={{ width: "100%", padding: "6px", background: "none", border: "none", color: "rgba(254,243,199,0.2)", fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontStyle: "italic" }}>Fechar</button>
            </div>
          )}

          {/* Mensagens */}
          <div ref={mensagensRef} onScroll={atualizarBotoesDeScroll} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 20px", display: "flex", flexDirection: "column" }}>
            {mensagens.length === 0 && (
              <div style={{ textAlign: "center", padding: "40px 20px", animation: "fadeUp 0.8s ease 0.2s both" }}>
                <div style={{ width: 64, height: 64, borderRadius: "50%", background: "radial-gradient(circle, rgba(251,191,36,0.2), transparent)", border: "1px solid rgba(251,191,36,0.2)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: 24, animation: "pulse-gold 3s ease-in-out infinite" }}>✦</div>
                <p style={{ fontFamily: "'Cinzel',serif", color: "rgba(254,243,199,0.8)", fontSize: 17, lineHeight: 1.6, marginBottom: 24, fontStyle: "italic" }}>{OPENING_PHRASES[Math.floor(Math.random() * OPENING_PHRASES.length)]}</p>
                <div style={{ width: 40, height: 1, background: "linear-gradient(90deg, transparent, rgba(251,191,36,0.3), transparent)", margin: "0 auto 24px" }} />
                <p style={{ color: "rgba(254,243,199,0.35)", fontSize: 12, lineHeight: 1.7, fontStyle: "italic" }}>Este é um espaço sagrado de escuta.<br />Escreva o que está no seu coração.</p>
              </div>
            )}
            {mensagens.map((msg, i) => <Mensagem key={i} msg={msg} index={i} />)}

            {!premium && restantes <= 3 && restantes > 0 && mensagens.length > 0 && (
              <div style={{ background: "rgba(251,191,36,0.05)", border: "1px solid rgba(251,191,36,0.15)", borderRadius: 14, padding: "12px 16px", margin: "4px 0", textAlign: "center" }}>
                <p style={{ color: "rgba(251,191,36,0.6)", fontSize: 12, fontStyle: "italic", margin: "0 0 6px" }}>✦ {restantes} consulta{restantes !== 1 ? "s" : ""} restante{restantes !== 1 ? "s" : ""}</p>
                <button onClick={() => setMostrarPaywall(true)} style={{ background: "none", border: "1px solid rgba(251,191,36,0.25)", borderRadius: 100, padding: "6px 16px", color: "rgba(251,191,36,0.7)", fontSize: 11, fontFamily: "'Cinzel',serif", cursor: "pointer" }}>Ver plano completo</button>
              </div>
            )}

            {mostrarCVV && (
              <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 16, padding: "14px 16px", margin: "8px 0" }}>
                <p style={{ color: "#fca5a5", fontSize: 13, fontWeight: 600, margin: "0 0 6px" }}>💛 Você não está sozinho</p>
                <p style={{ color: "rgba(252,165,165,0.75)", fontSize: 12, lineHeight: 1.7, margin: "0 0 10px" }}>CVV — Centro de Valorização da Vida</p>
                <p style={{ color: "rgba(252,165,165,0.75)", fontSize: 12, margin: 0 }}>📞 Ligue <strong style={{ color: "#fca5a5" }}>188</strong> — gratuito, 24h, sigiloso</p>
                <button onClick={() => setMostrarCVV(false)} style={{ background: "none", border: "none", color: "rgba(252,165,165,0.4)", fontSize: 11, cursor: "pointer", marginTop: 8, fontFamily: "inherit", fontStyle: "italic" }}>Fechar</button>
              </div>
            )}

            {carregando && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
                <div style={{ width: 32, height: 32, borderRadius: "50%", background: "radial-gradient(circle, #fbbf24, #f97316)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>✦</div>
                <div style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(251,191,36,0.1)", borderRadius: "20px 20px 20px 4px", padding: "13px 18px", display: "flex", gap: 6 }}>
                  {[0,1,2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "rgba(251,191,36,0.6)", animation: `twinkle 1.2s ease-in-out ${i * 0.3}s infinite` }} />)}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Atalhos flutuantes: ir para o topo / ir para o fim da conversa */}
          <div style={{ position: "absolute", right: 14, bottom: 96, display: "flex", flexDirection: "column", gap: 8, zIndex: 20 }}>
            <button onClick={irParaTopo} title="Ir para o topo" aria-label="Ir para o topo da conversa" style={{ width: 36, height: 36, borderRadius: "50%", background: "rgba(10,5,25,0.85)", border: "1px solid rgba(251,191,36,0.25)", color: "rgba(254,243,199,0.7)", fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(10px)", boxShadow: "0 2px 10px rgba(0,0,0,0.3)", opacity: mostrarBotaoTopo ? 1 : 0, pointerEvents: mostrarBotaoTopo ? "auto" : "none", transition: "opacity 0.25s ease" }}>↑</button>
            <button onClick={irParaFundo} title="Ir para o fim" aria-label="Ir para o fim da conversa" style={{ width: 36, height: 36, borderRadius: "50%", background: "rgba(10,5,25,0.85)", border: "1px solid rgba(251,191,36,0.25)", color: "rgba(254,243,199,0.7)", fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(10px)", boxShadow: "0 2px 10px rgba(0,0,0,0.3)", opacity: mostrarBotaoFundo ? 1 : 0, pointerEvents: mostrarBotaoFundo ? "auto" : "none", transition: "opacity 0.25s ease" }}>↓</button>
          </div>

          {/* Input */}
          <div style={{ padding: "16px 20px 28px", borderTop: "1px solid rgba(251,191,36,0.1)", background: "rgba(5,2,16,0.7)", backdropFilter: "blur(20px)" }}>
            {!premium && restantes === 0 ? (
              <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
                <p style={{ color: "rgba(254,243,199,0.4)", fontSize: 13, fontStyle: "italic", marginBottom: 12 }}>Suas consultas gratuitas foram usadas. ✦</p>
                <button onClick={() => setMostrarPaywall(true)} style={{ background: "linear-gradient(135deg, #f97316, #fbbf24)", border: "none", borderRadius: 100, padding: "14px 32px", color: "#1a0a2e", fontSize: 14, fontFamily: "'Cinzel',serif", letterSpacing: 2, fontWeight: 700, cursor: "pointer", boxShadow: "0 0 20px rgba(251,191,36,0.4)" }}>✦ Continuar com o Oráculo</button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 10, alignItems: "flex-end", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(251,191,36,0.2)", borderRadius: 20, padding: "12px 14px" }}>
                <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } }} placeholder="Escreva o que está em seu coração..." rows={1} style={{ flex: 1, background: "none", border: "none", outline: "none", color: "#fef3c7", fontSize: 15, lineHeight: 1.6, fontFamily: "'Lora', Georgia, serif", fontStyle: "italic", maxHeight: 120, overflowY: "auto" }} onInput={e => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; }} />
                <button onClick={iniciarVoz} style={{ width: 38, height: 38, borderRadius: "50%", background: escutando ? "rgba(248,113,113,0.3)" : "rgba(255,255,255,0.06)", border: escutando ? "1px solid rgba(248,113,113,0.5)" : "1px solid transparent", color: escutando ? "#f87171" : "rgba(254,243,199,0.4)", fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>🎤</button>
                <button onClick={enviar} disabled={!input.trim() || carregando} style={{ width: 38, height: 38, borderRadius: "50%", background: input.trim() && !carregando ? "linear-gradient(135deg, #f97316, #fbbf24)" : "rgba(255,255,255,0.06)", border: "none", color: input.trim() && !carregando ? "#1a0a2e" : "rgba(254,243,199,0.2)", fontSize: 16, cursor: input.trim() && !carregando ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center" }}>✦</button>
              </div>
            )}
            <p style={{ color: "rgba(254,243,199,0.2)", fontSize: 10, textAlign: "center", marginTop: 10, fontStyle: "italic" }}>🎤 Toque no microfone para falar · Enter para enviar</p>
          </div>
        </div>
      )}
    </div>
  );
}
