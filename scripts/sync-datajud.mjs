// Script de sincronização automática com o DataJud (CNJ).
// Roda de forma independente (sem navegador) via GitHub Actions.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USER_ID = process.env.SUPABASE_USER_ID;
const DATAJUD_API_KEY = process.env.DATAJUD_API_KEY;

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

async function sbGet(chave) {
  const url = `${SUPABASE_URL}/rest/v1/dados_sistema?user_id=eq.${USER_ID}&chave=eq.${chave}&select=valor`;
  const resp = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` }
  });
  if (!resp.ok) throw new Error(`Falha ao ler do Supabase: ${resp.status} ${await resp.text()}`);
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
  if (!resp.ok) throw new Error(`Falha ao salvar no Supabase: ${resp.status} ${await resp.text()}`);
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !USER_ID || !DATAJUD_API_KEY) {
    console.error("Faltam variáveis de ambiente obrigatórias (verifique os Secrets no GitHub).");
    process.exit(1);
  }

  const processos = (await sbGet("processos")) || [];
  console.log(`Encontrados ${processos.length} processo(s) cadastrados.`);
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
        console.log(`Processo ${p.numero}: ${novos.length} andamento(s) novo(s)`);
      }
    } catch (e) {
      console.error(`Erro ao consultar processo ${p.numero}:`, e.message);
    }
  }

  if (totalNovos > 0) {
    await sbUpsert("processos", processos);
    console.log(`Sincronização concluída: ${totalNovos} andamento(s) novo(s) no total.`);
  } else {
    console.log("Sincronização concluída: nenhuma novidade.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
