// ============================================================
//  ScoutDex — Backend v1.0
//  Node.js / Express — Railway
// ============================================================
//  .env requis :
//    SUPABASE_URL
//    SUPABASE_SERVICE_KEY
//    SUPABASE_ANON_KEY
//    ANTHROPIC_API_KEY
//    BALLDONTLIE_KEY     (optionnel, renforce NBA)
//    PORT                (défaut 3001)
// ============================================================

import express          from 'express';
import cors             from 'cors';
import cron             from 'node-cron';
import fetch            from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET","POST","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
}));
app.options("*", cors());
app.use(express.json());

// ── Clients Supabase ──────────────────────────────────────────
const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const dbPublic = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ============================================================
//  UTILITAIRES
// ============================================================

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non authentifié' });
  const { data: { user }, error } = await dbPublic.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Token invalide' });
  req.user = user;
  next();
}

async function logSync(type, playerId, status, rows = 0, errorMsg = null) {
  try {
    await db.from('sync_logs').insert({
      sync_type:    type,
      player_id:    playerId || null,
      status,
      rows_updated: rows,
      error:        errorMsg,
      finished_at:  new Date().toISOString(),
    });
  } catch (e) {
    console.error('[logSync]', e.message);
  }
}

async function callClaude(messages, { maxTokens = 1500, webSearch = false } = {}) {
  const headers = {
    'Content-Type':      'application/json',
    'x-api-key':         process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  if (webSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';

  const body = { model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages };
  if (webSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`Claude API: ${data.error.message}`);
  return data.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
}

function parseAIJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Aucun JSON dans la réponse IA');
  return JSON.parse(match[0]);
}

// Calcul automatique des stats avancées depuis les stats de base
function calculateAdvancedStats(p) {
  const s = {};
  if (p.pts && p.fga && p.fta)
    s.ts_pct  = parseFloat((p.pts / (2 * (p.fga + 0.44 * p.fta)) * 100).toFixed(1));
  if (p.fgm && p.fg3m && p.fga)
    s.efg_pct = parseFloat(((p.fgm + 0.5 * p.fg3m) / p.fga * 100).toFixed(1));
  if (p.ortg && p.drtg)
    s.net_rtg = parseFloat((p.ortg - p.drtg).toFixed(1));
  if (p.ast && p.tov && p.tov > 0)
    s.ast_to  = parseFloat((p.ast / p.tov).toFixed(2));
  return s;
}

// ============================================================
//  SANTÉ
// ============================================================
app.get('/health', (_, res) => res.json({
  status: 'ok', version: '1.0.0', time: new Date().toISOString()
}));

// ============================================================
//  JOUEURS — CRUD
// ============================================================

app.get('/players', requireAuth, async (req, res) => {
  const { league, status, position, search } = req.query;
  let q = db.from('players').select(
    'id, first_name, last_name, position, team, league, status, scout_grade, age, height_cm, nationality, pts, reb, ast, bpm, ts_pct, usg_pct, photo_url, last_synced_at, reports(id, global_grade, report_date)'
  );
  if (league)   q = q.eq('league', league);
  if (status)   q = q.eq('status', status);
  if (position) q = q.eq('position', position);
  if (search)   q = q.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,team.ilike.%${search}%`);
  q = q.order('scout_grade', { ascending: false });
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/players/:id', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('players').select('*, reports(*)').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ error: 'Joueur introuvable' });
  res.json(data);
});

app.post('/players', requireAuth, async (req, res) => {
  const payload = { ...req.body, created_by: req.user.id, ...calculateAdvancedStats(req.body) };
  const { data, error } = await db.from('players').insert(payload).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.patch('/players/:id', requireAuth, async (req, res) => {
  const payload = { ...req.body, ...calculateAdvancedStats(req.body) };
  const { data, error } = await db
    .from('players').update(payload).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/players/:id', requireAuth, async (req, res) => {
  const { error } = await db.from('players').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

// ============================================================
//  AGENT IA — AUTO-REMPLISSAGE
// ============================================================
app.post('/players/autofill', requireAuth, async (req, res) => {
  const { name, league } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom du joueur requis' });

  try {
    const searchText = await callClaude([{
      role: 'user',
      content: `Search basketball player "${name}" ${league || ''} 2024-25 season.
Find: points, rebounds, assists, steals, blocks, turnovers, FG%, 3P%, FT%, minutes, games played.
Also: age, height (cm), weight (kg), nationality, team, league, position.
Advanced stats if available: BPM, VORP, PER, USG%, TS%, eFG%, ORTG, DRTG.
Search basketball-reference, eurobasket, proballers, ESPN.`
    }], { webSearch: true, maxTokens: 2000 });

    const formatted = await callClaude([{
      role: 'user',
      content: `Data about basketball player "${name}":
${searchText.substring(0, 4000)}

Return ONLY valid JSON. No markdown. Percentages as 0-100. null for unknown.
{"first_name":"","last_name":"","nationality":"","age":null,"height_cm":null,"weight_kg":null,"position":"","team":"","league":"","season":"2024-25","gp":null,"min":null,"pts":null,"reb":null,"ast":null,"stl":null,"blk":null,"tov":null,"fga":null,"fgm":null,"fg_pct":null,"fg3a":null,"fg3m":null,"fg3_pct":null,"fta":null,"ftm":null,"ft_pct":null,"per":null,"bpm":null,"obpm":null,"dbpm":null,"usg_pct":null,"vorp":null,"ortg":null,"drtg":null,"observation":""}`
    }], { maxTokens: 1000 });

    const player = parseAIJson(formatted);
    Object.assign(player, calculateAdvancedStats(player));
    res.json({ ok: true, player });

  } catch (e) {
    console.error('[Autofill]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
//  SYNC STATS — Agent IA + BallDontLie NBA en renfort
// ============================================================
async function syncPlayerStats(player) {
  const name = `${player.first_name} ${player.last_name}`;
  console.log(`[Sync] ${name} (${player.league})...`);

  try {
    // Renfort NBA via BallDontLie
    if (player.league === 'NBA' && process.env.BALLDONTLIE_KEY) {
      const r = await fetch(
        `https://api.balldontlie.io/v1/players?search=${encodeURIComponent(name)}&per_page=3`,
        { headers: { 'Authorization': process.env.BALLDONTLIE_KEY } }
      );
      if (r.ok) {
        const found = (await r.json()).data?.[0];
        if (found) {
          const sr = await fetch(
            `https://api.balldontlie.io/v1/season_averages?player_ids[]=${found.id}&season=2024`,
            { headers: { 'Authorization': process.env.BALLDONTLIE_KEY } }
          );
          if (sr.ok) {
            const s = (await sr.json()).data?.[0];
            if (s) {
              const updates = {
                gp: s.games_played, min: s.min ? parseFloat(s.min) : null,
                pts: s.pts, reb: s.reb, ast: s.ast, stl: s.stl, blk: s.blk, tov: s.turnover,
                fg_pct:  s.fg_pct  ? +(s.fg_pct  * 100).toFixed(1) : null,
                fg3_pct: s.fg3_pct ? +(s.fg3_pct * 100).toFixed(1) : null,
                ft_pct:  s.ft_pct  ? +(s.ft_pct  * 100).toFixed(1) : null,
                season: '2024-25', last_synced_at: new Date().toISOString(),
              };
              Object.assign(updates, calculateAdvancedStats({ ...player, ...updates }));
              await db.from('players').update(updates).eq('id', player.id);
              await logSync('balldontlie', player.id, 'success', 1);
              console.log(`[Sync] ✅ ${name} — BallDontLie`);
              return;
            }
          }
        }
      }
    }

    // Agent IA pour toutes les autres ligues
    const searchText = await callClaude([{
      role: 'user',
      content: `Find 2024-25 season stats for basketball player "${name}" in ${player.league || 'pro basketball'}.
Search basketball-reference, eurobasket, proballers, ESPN.
Stats needed: pts, reb, ast, stl, blk, tov, FG%, 3P%, FT%, min, gp.
Advanced if available: BPM, VORP, PER, USG%, TS%, ORTG, DRTG.`
    }], { webSearch: true, maxTokens: 1500 });

    const formatted = await callClaude([{
      role: 'user',
      content: `Stats for "${name}": ${searchText.substring(0, 3000)}
Return ONLY JSON, no markdown, percentages 0-100, null for unknown.
{"gp":null,"min":null,"pts":null,"reb":null,"ast":null,"stl":null,"blk":null,"tov":null,"fga":null,"fgm":null,"fg_pct":null,"fg3a":null,"fg3m":null,"fg3_pct":null,"fta":null,"ftm":null,"ft_pct":null,"per":null,"bpm":null,"obpm":null,"dbpm":null,"usg_pct":null,"vorp":null,"ortg":null,"drtg":null,"team":""}`
    }], { maxTokens: 600 });

    const stats = parseAIJson(formatted);
    const updates = Object.fromEntries(Object.entries(stats).filter(([, v]) => v !== null && v !== ''));

    if (Object.keys(updates).length < 3) throw new Error('Pas assez de stats trouvées');

    updates.season         = '2024-25';
    updates.last_synced_at = new Date().toISOString();
    Object.assign(updates, calculateAdvancedStats({ ...player, ...updates }));

    await db.from('players').update(updates).eq('id', player.id);
    await logSync('ai_agent', player.id, 'success', 1);
    console.log(`[Sync] ✅ ${name} — Agent IA`);

  } catch (e) {
    console.error(`[Sync] ❌ ${name}:`, e.message);
    await logSync('ai_agent', player.id, 'error', 0, e.message);
  }
}

// Sync manuel d'un joueur
app.post('/players/:id/sync', requireAuth, async (req, res) => {
  const { data: player, error } = await db
    .from('players').select('*').eq('id', req.params.id).single();
  if (error || !player) return res.status(404).json({ error: 'Joueur introuvable' });
  syncPlayerStats(player).catch(console.error);
  res.json({ ok: true, message: 'Synchronisation lancée' });
});

// Sync tous les joueurs
async function syncAllPlayers() {
  console.log('[CRON] Démarrage sync nocturne...');
  const { data: players } = await db
    .from('players')
    .select('id, first_name, last_name, league, fga, fgm, fg3m, fta, ortg, drtg, ast, tov')
    .not('first_name', 'is', null);

  if (!players?.length) return console.log('[CRON] Aucun joueur');
  console.log(`[CRON] ${players.length} joueurs à synchroniser`);

  for (const player of players) {
    await syncPlayerStats(player);
    await new Promise(r => setTimeout(r, 3000)); // 3s entre chaque joueur
  }
  console.log('[CRON] ✅ Terminé');
}

app.post('/admin/sync-all', requireAuth, (req, res) => {
  syncAllPlayers().catch(console.error);
  res.json({ ok: true, message: 'Sync lancée en arrière-plan' });
});

cron.schedule('0 6 * * *', syncAllPlayers, { timezone: 'Europe/Paris' });

// ============================================================
//  RAPPORTS
// ============================================================

app.post('/players/:id/reports', requireAuth, async (req, res) => {
  const { data, error } = await db.from('reports')
    .insert({ ...req.body, player_id: req.params.id, created_by: req.user.id, source: 'Manuel' })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.post('/players/:id/reports/ai', requireAuth, async (req, res) => {
  const { data: player, error } = await db
    .from('players').select('*').eq('id', req.params.id).single();
  if (error || !player) return res.status(404).json({ error: 'Joueur introuvable' });

  const name = `${player.first_name} ${player.last_name}`;

  const statsLines = [
    player.gp    && `Matchs: ${player.gp} | Min: ${player.min}`,
    player.pts   && `PTS:${player.pts} REB:${player.reb} AST:${player.ast} STL:${player.stl} BLK:${player.blk} TOV:${player.tov}`,
    player.fg_pct && `FG%:${player.fg_pct} 3P%:${player.fg3_pct} FT%:${player.ft_pct}`,
    player.ts_pct && `TS%:${player.ts_pct} eFG%:${player.efg_pct} USG%:${player.usg_pct}`,
    player.bpm    && `BPM:${player.bpm} (OFF:${player.obpm}/DEF:${player.dbpm}) VORP:${player.vorp} PER:${player.per}`,
    player.ortg   && `ORTG:${player.ortg} DRTG:${player.drtg} Net:${player.net_rtg}`,
  ].filter(Boolean).join('\n');

  const prompt = `Tu es analyste data et scout basketball professionnel.
Style : précis, factuel, chaque point justifié par des chiffres. Niveau NBA Analytics.

JOUEUR : ${name} | ${player.position} | ${player.team} | ${player.league}
ÂGE : ${player.age} ans | TAILLE : ${player.height_cm} cm | NATION : ${player.nationality}
NOTE SCOUT : ${player.scout_grade}/10 | STATUT : ${player.status}
PLAFOND : ${player.ceiling || 'Non défini'}

STATS 2024-25 :
${statsLines || 'Non disponibles'}
${player.strengths   ? `\nFORCES : ${player.strengths}`        : ''}
${player.weaknesses  ? `\nFAIBLESSES : ${player.weaknesses}`   : ''}
${player.observation ? `\nTERRAIN : ${player.observation}`     : ''}
${player.comparable  ? `\nCOMPARABLE : ${player.comparable}`   : ''}

Rédige un rapport scout analytique complet en français :

## PROFIL
2-3 phrases. Type de joueur, impact, style. 1-2 stats clés.

## ANALYSE OFFENSIVE
Forces offensives avec stats. Contextualise le USG%, TS%. Créateur/finisseur/espaceur ?

## ANALYSE DÉFENSIVE
Stats défensives, engagement, lacunes réelles.

## PROJECTION & PLAFOND
Niveau atteignable ? Délai ? Rôle précis ? Base sur l'âge + courbe stats.

## VERDICT
⭐ TOP PROSPECT / 🟢 PRIORITAIRE / 🟡 À SURVEILLER / 🔵 EN VEILLE / 🔴 ÉCARTÉ
+ 2 phrases de justification.`;

  try {
    const reportText = await callClaude([{ role: 'user', content: prompt }], { maxTokens: 1200 });
    const { data: saved, error: saveError } = await db.from('reports').insert({
      player_id:    req.params.id,
      created_by:   req.user.id,
      source:       'IA',
      report_date:  new Date().toISOString().split('T')[0],
      global_grade: player.scout_grade || 5,
      ai_report:    reportText,
      observation:  reportText,
    }).select().single();
    if (saveError) throw new Error(saveError.message);
    res.json({ ok: true, report: saved });
  } catch (e) {
    console.error('[Rapport IA]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.patch('/reports/:id', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('reports').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/reports/:id', requireAuth, async (req, res) => {
  const { error } = await db.from('reports').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

// ============================================================
//  WATCHLIST
// ============================================================

app.get('/watchlist', requireAuth, async (req, res) => {
  const { data, error } = await db.from('watchlist')
    .select('added_at, note, players(*)')
    .eq('user_id', req.user.id)
    .order('added_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(w => ({ ...w.players, watchlisted_at: w.added_at, watchlist_note: w.note })));
});

app.post('/watchlist/:playerId', requireAuth, async (req, res) => {
  const { error } = await db.from('watchlist')
    .upsert({ user_id: req.user.id, player_id: req.params.playerId, note: req.body.note });
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ok: true });
});

app.delete('/watchlist/:playerId', requireAuth, async (req, res) => {
  const { error } = await db.from('watchlist')
    .delete().eq('user_id', req.user.id).eq('player_id', req.params.playerId);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

// ============================================================
//  COMPARAISON JOUEURS
// ============================================================
app.post('/players/compare', requireAuth, async (req, res) => {
  const { playerIds } = req.body;
  if (!playerIds?.length || playerIds.length < 2) return res.status(400).json({ error: 'Minimum 2 joueurs' });
  if (playerIds.length > 4) return res.status(400).json({ error: 'Maximum 4 joueurs' });

  const { data: players, error } = await db.from('players').select('*').in('id', playerIds);
  if (error || !players?.length) return res.status(404).json({ error: 'Joueurs introuvables' });

  const summary = players.map(p =>
    `${p.first_name} ${p.last_name} (${p.position}, ${p.team}, ${p.league}) — ` +
    `${p.pts}pts ${p.reb}reb ${p.ast}ast | TS%:${p.ts_pct} BPM:${p.bpm} USG%:${p.usg_pct} | Note:${p.scout_grade}/10`
  ).join('\n');

  try {
    const analysis = await callClaude([{
      role: 'user',
      content: `Compare ces ${players.length} joueurs en tant qu'analyste pro :\n${summary}\n\nAnalyse comparative (6-8 phrases) : efficacité offensive (TS%, USG%), apport défensif, impact global (BPM), profil de club adapté, classement final justifié.`
    }], { maxTokens: 700 });
    res.json({ ok: true, players, analysis });
  } catch {
    res.json({ ok: true, players, analysis: null });
  }
});

// ============================================================
//  DASHBOARD
// ============================================================
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const [
      { count: totalPlayers },
      { data: byStatus },
      { data: byLeague },
      { data: topPlayers },
      { data: recentReports },
      { data: lastSync },
    ] = await Promise.all([
      db.from('players').select('*', { count: 'exact', head: true }),
      db.from('players').select('status').neq('status', null),
      db.from('players').select('league').neq('league', null),
      db.from('players').select('id, first_name, last_name, position, team, league, scout_grade, status, pts, bpm').order('scout_grade', { ascending: false }).limit(5),
      db.from('reports').select('id, report_date, source, global_grade, players(first_name, last_name)').order('created_at', { ascending: false }).limit(5),
      db.from('sync_logs').select('*').order('started_at', { ascending: false }).limit(1).single(),
    ]);

    const statusCount = (byStatus || []).reduce((acc, { status }) => {
      acc[status] = (acc[status] || 0) + 1; return acc;
    }, {});

    const leagueCount = (byLeague || []).reduce((acc, { league }) => {
      acc[league] = (acc[league] || 0) + 1; return acc;
    }, {});

    res.json({ totalPlayers, statusCount, leagueCount, topPlayers, recentReports, lastSync });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
//  CALENDRIER
// ============================================================
app.get('/schedule', requireAuth, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const in7   = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  const { data, error } = await db.from('player_schedule')
    .select('players(id, first_name, last_name, team, league, scout_grade), schedule(*)')
    .gte('schedule.game_date', req.query.from || today)
    .lte('schedule.game_date', req.query.to   || in7)
    .order('schedule.game_date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).filter(d => d.schedule));
});

// ============================================================
//  LOGS
// ============================================================
app.get('/admin/sync-logs', requireAuth, async (req, res) => {
  const { data, error } = await db.from('sync_logs')
    .select('*, players(first_name, last_name)')
    .order('started_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ============================================================
//  DÉMARRAGE
// ============================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🏀 ScoutDex API v1.0 — port ${PORT}`);
  console.log(`   Sync nocturne : 6h00 Europe/Paris`);
});
