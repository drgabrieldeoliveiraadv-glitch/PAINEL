// Script de sincronização automática do escritório.
// Roda de forma independente (sem navegador) via GitHub Actions.
// 1) Busca movimentações processuais no DataJud (CNJ) para os processos judiciais.
// 2) Busca publicações no DJEN (Diário de Justiça Eletrônico Nacional) pela OAB cadastrada.
// 3) Sincroniza compromissos e prazos com o Google Agenda.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USER_ID = process.env.SUPABASE_USER_ID;
const DATAJUD_API_KEY = process.env.DATAJUD_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const DATAJUD_ENDPOINTS = {
  TJRJ: "https://api-publica.datajud.cnj.jus.br/api_publica_tjrj/_search",
  TJSP: "https://api-publica.datajud.cnj.jus.br/api_publica_tjsp/_search",
  TRF2: "https://api-publica.datajud.cnj.jus.br/api_publica_trf2/_search",
  TST:  "https://api-publica.datajud.cnj.jus.br/api_publica_tst/_search",
};

function detectarTribunalPorNumero(numero) {
  const limpo = (numero || "").replace(/\D/g, "");
  if (limpo.length < 20) return "TJRJ";
  const j = limpo[13];
  const tr = limpo.slice(14, 16);
  if (j === "8" && tr === "19") return "TJRJ";
  if (j === "8" && tr === "26") return "TJSP";
  if (j === "4" && tr === "02") return "TRF2";
  if (j === "5") return "TST";
  return "TJRJ";
}

async function buscarAndamentosDataJud(numeroProcesso) {
  const numeroLimpo = (numeroProcesso || "").replace(/\D/g, "");
  if (numeroLimpo.length < 20) return [];
  const tribunal = detectarTribunalPorNumero(numeroProcesso);
  const endpoint = DATAJUD_ENDPOINTS[tribunal] || DATAJUD_ENDPOINTS.TJRJ;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `APIKey ${DATAJUD_API_KEY}` },
    body: JSON.stringify({ query: { match: { numeroProcesso: numeroLimpo } } })
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  const hits = data?.hits?.hits || [];
  if (hits.length === 0) return [];
  const fonte = hits[0]._source || {};
  const movimentos = fonte.movimentos || [];
  return movimentos
    .map(m => ({ data: (m.dataHora || "").slice(0, 10), desc: m.nome || "Movimentação", fonte: "datajud" }))
    .filter(m => m.data)
    .sort((a, b) => a.data.localeCompare(b.data));
}

async function buscarIntimacoesDJEN(oabNumero, oabUf, dias = 15) {
  if (!oabNumero || !oabUf) return [];
  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - dias * 86400000);
  const fmt = d => d.toISOString().slice(0, 10);
  const url = `https://comunicaapi.pje.jus.br/api/v1/comunicacao?numeroOab=${encodeURIComponent(oabNumero)}&ufOab=${encodeURIComponent(oabUf)}&dataDisponibilizacaoInicio=${fmt(inicio)}&dataDisponibilizacaoFim=${fmt(hoje)}`;
  const resp = await fetch(url);
  if (!resp.ok) return [];
  const data = await resp.json();
  const itens = data?.items || data?.content || [];
  return itens.map(it => ({
    id: it.id || `djen-${it.numero_processo || ""}-${it.data_disponibilizacao || ""}-${Math.random().toString(36).slice(2, 8)}`,
    data: (it.data_disponibilizacao || it.dataDisponibilizacao || "").slice(0, 10),
    orgao: it.orgao?.nome || it.nomeOrgao || "—",
    numeroProcesso: it.numero_processo || it.numeroProcesso || "",
    texto: it.texto || it.conteudo || "",
    vinculada: false
  }));
}

async function sbGet(chave) {
  const url = `${SUPABASE_URL}/rest/v1/dados_sistema?user_id=eq.${USER_ID}&chave=eq.${chave}&select=valor`;
  const resp = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` }
  });
  if (!resp.ok) throw new Error(`Falha ao ler do Supabase (${chave}): ${resp.status} ${await resp.text()}`);
  const rows = await resp.json();
  return rows[0]?.valor ?? null;
}

async function sbUpsert(chave, valor) {
  const url = `${SUPABASE_URL}/rest/v1/dados_sistema?on_conflict=user_id,chave`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({ user_id: USER_ID, chave, valor, atualizado_em: new Date().toISOString() })
  });
  if (!resp.ok) throw new Error(`Falha ao salvar no Supabase (${chave}): ${resp.status} ${await resp.text()}`);
}

async function sincronizarProcessos() {
  const processos = (await sbGet("processos")) || [];
  console.log(`[DataJud] Encontrados ${processos.length} processo(s) cadastrados.`);
  let totalNovos = 0;

  for (const p of processos) {
    if (p.arquivado || !p.numero) continue;
    try {
      const encontrados = await buscarAndamentosDataJud(p.numero);
      const jaExistem = new Set((p.andamentos || []).map(a => `${a.data}|${a.desc}`));
      const novos = encontrados.filter(a => !jaExistem.has(`${a.data}|${a.desc}`));
      if (novos.length > 0) {
        p.andamentos = [...(p.andamentos || []), ...novos];
        totalNovos += novos.length;
        console.log(`[DataJud] Processo ${p.numero}: ${novos.length} andamento(s) novo(s)`);
      }
    } catch (e) {
      console.error(`[DataJud] Erro ao consultar processo ${p.numero}:`, e.message);
    }
  }

  if (totalNovos > 0) {
    await sbUpsert("processos", processos);
    console.log(`[DataJud] Sincronização concluída: ${totalNovos} andamento(s) novo(s) no total.`);
  } else {
    console.log("[DataJud] Sincronização concluída: nenhuma novidade.");
  }
}

async function sincronizarIntimacoes() {
  const config = (await sbGet("config")) || {};
  const { oabNumero, oabUf } = config;
  if (!oabNumero || !oabUf) {
    console.log("[DJEN] OAB não configurada em Configurações — pulando busca de publicações.");
    return;
  }

  const intimacoesAtuais = (await sbGet("intimacoes")) || [];
  const encontradas = await buscarIntimacoesDJEN(oabNumero, oabUf, 15);
  const idsExistentes = new Set(intimacoesAtuais.map(i => i.id));
  const novas = encontradas.filter(i => !idsExistentes.has(i.id));

  if (novas.length > 0) {
    const atualizadas = [...novas, ...intimacoesAtuais];
    await sbUpsert("intimacoes", atualizadas);
    console.log(`[DJEN] ${novas.length} publicação(ões) nova(s) encontrada(s) para OAB ${oabNumero}/${oabUf}.`);
  } else {
    console.log(`[DJEN] Nenhuma publicação nova para OAB ${oabNumero}/${oabUf}.`);
  }
}

async function obterAccessTokenGoogle() {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  if (!resp.ok) throw new Error(`Falha ao renovar token do Google: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.access_token;
}

async function criarEventoGoogle(accessToken, evento) {
  const resp = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(evento)
  });
  if (!resp.ok) throw new Error(`Falha ao criar evento: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function sincronizarGoogleAgenda() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    console.log("[Google Agenda] Credenciais não configuradas — pulando.");
    return;
  }

  let accessToken;
  try {
    accessToken = await obterAccessTokenGoogle();
  } catch (e) {
    console.error("[Google Agenda] Erro ao autenticar:", e.message);
    return;
  }

  // 1) Compromissos cadastrados na Agenda (inclui audiências lançadas como compromisso)
  const agenda = (await sbGet("agenda")) || [];
  let mudouAgenda = false;
  for (const compromisso of agenda) {
    if (compromisso.googleEventId) continue;
    try {
      const inicio = `${compromisso.data}T${compromisso.hora || "09:00"}:00`;
      const evento = await criarEventoGoogle(accessToken, {
        summary: compromisso.titulo,
        location: compromisso.local || "",
        description: compromisso.obs || "",
        start: { dateTime: inicio, timeZone: "America/Sao_Paulo" },
        end: { dateTime: inicio, timeZone: "America/Sao_Paulo" }
      });
      compromisso.googleEventId = evento.id;
      mudouAgenda = true;
      console.log(`[Google Agenda] Compromisso "${compromisso.titulo}" sincronizado.`);
    } catch (e) {
      console.error(`[Google Agenda] Erro ao sincronizar compromisso "${compromisso.titulo}":`, e.message);
    }
  }
  if (mudouAgenda) await sbUpsert("agenda", agenda);

  // 2) Prazos de Processos, Sindicâncias e PEP
  const categorias = [["processos", "Processo"], ["sindicancias", "Sindicância"], ["peps", "PEP"]];
  for (const [chave, rotulo] of categorias) {
    const lista = (await sbGet(chave)) || [];
    let mudou = false;
    for (const item of lista) {
      if (item.arquivado || !item.prazo || item.googleEventIdPrazo) continue;
      try {
        const evento = await criarEventoGoogle(accessToken, {
          summary: `Prazo (${rotulo}): ${item.prazoAto || "sem descrição"} — ${item.numero || "sem número"}`,
          description: "Cadastrado automaticamente pelo sistema de gestão.",
          start: { date: item.prazo },
          end: { date: item.prazo }
        });
        item.googleEventIdPrazo = evento.id;
        mudou = true;
        console.log(`[Google Agenda] Prazo de ${rotulo.toLowerCase()} "${item.numero || ""}" sincronizado.`);
      } catch (e) {
        console.error(`[Google Agenda] Erro ao sincronizar prazo (${chave}):`, e.message);
      }
    }
    if (mudou) await sbUpsert(chave, lista);
  }
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !USER_ID) {
    console.error("Faltam variáveis de ambiente obrigatórias (verifique os Secrets no GitHub).");
    process.exit(1);
  }

  if (DATAJUD_API_KEY) {
    await sincronizarProcessos();
  } else {
    console.log("[DataJud] Chave não configurada — pulando sincronização de andamentos.");
  }

  await sincronizarIntimacoes();
  await sincronizarGoogleAgenda();
}

main().catch(e => { console.error(e); process.exit(1); });
