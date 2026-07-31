// Script de sincronização automática do escritório.
// Roda de forma independente (sem navegador) via GitHub Actions.
// 1) Busca movimentações processuais no DataJud (CNJ) para os processos judiciais já cadastrados.
// 2) Busca publicações no DJEN pela OAB cadastrada e usa isso para:
//    - atualizar andamentos de processos já cadastrados
//    - cadastrar automaticamente processos que apareceram numa publicação mas ainda não existem
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

function limparNumeroProcesso(numero) {
  return (numero || "").replace(/\D/g, "");
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

async function buscarIntimacoesDJEN(oabNumero, oabUf, dias = 30) {
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

// Busca publicações da OAB no DJEN e usa para atualizar/cadastrar processos automaticamente,
// além de manter a lista de intimações do sistema atualizada e vinculada.
async function sincronizarProcessosPorOab() {
  const config = (await sbGet("config")) || {};
  const { oabNumero, oabUf } = config;
  if (!oabNumero || !oabUf) {
    console.log("[OAB] OAB não configurada em Configurações — pulando busca por OAB.");
    return;
  }

  const publicacoes = await buscarIntimacoesDJEN(oabNumero, oabUf, 30);
  console.log(`[OAB] ${publicacoes.length} publicação(ões) encontrada(s) para OAB ${oabNumero}/${oabUf}.`);
  if (publicacoes.length === 0) return;

  let processosLocais = (await sbGet("processos")) || [];
  let intimacoesLocais = (await sbGet("intimacoes")) || [];
  const idsTocados = new Set();
  let criados = 0, atualizados = 0;

  for (const pub of publicacoes) {
    const numeroLimpo = limparNumeroProcesso(pub.numeroProcesso);
    if (!numeroLimpo) continue;

    let idx = processosLocais.findIndex(p => limparNumeroProcesso(p.numero) === numeroLimpo);
    const descAndamento = `Publicação DJEN: ${(pub.texto || "").slice(0, 300)}`;

    if (idx === -1) {
      const novo = {
        id: `auto-${numeroLimpo}-${Date.now()}`, numero: pub.numeroProcesso, clienteId: "", sistema: "PJe", classificacao: "",
        vara: pub.orgao || "", autor: "", reu: "", assunto: "", valorCausa: "", prazo: "", prazoAto: "",
        obs: "Processo cadastrado automaticamente pelo robô a partir de uma publicação/intimação da OAB. Confira e complete os dados (cliente, vara, partes).",
        arquivado: false, andamentos: [{ data: pub.data || new Date().toISOString().slice(0, 10), desc: descAndamento }]
      };
      processosLocais = [...processosLocais, novo];
      idx = processosLocais.length - 1;
      criados++;
      console.log(`[OAB] Processo novo cadastrado automaticamente: ${pub.numeroProcesso}`);
    } else {
      const jaTem = (processosLocais[idx].andamentos || []).some(a => a.data === pub.data && a.desc === descAndamento);
      if (!jaTem) {
        processosLocais[idx] = { ...processosLocais[idx], andamentos: [...(processosLocais[idx].andamentos || []), { data: pub.data || new Date().toISOString().slice(0, 10), desc: descAndamento }] };
        atualizados++;
        console.log(`[OAB] Processo ${pub.numeroProcesso} atualizado com publicação.`);
      }
    }

    idsTocados.add(processosLocais[idx].id);

    const jaEstaNasIntimacoes =
