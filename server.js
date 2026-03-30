// ============================================================
//  ProspectIQ — Backend v1.0
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


// Saison en cours dynamique
function currentSeason() {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  if (month >= 9) return `${year}-${String(year + 1).slice(2)}`
  return `${year - 1}-${String(year).slice(2)}`
}

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());
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

// Appel Claude — un seul appel, Sonnet pour autofill, Haiku pour le reste
async function callClaude(messages, { maxTokens = 1000, webSearch = false, model = 'claude-haiku-4-5-20251001' } = {}) {
  const headers = {
    'Content-Type':      'application/json',
    'x-api-key':         process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  if (webSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';

  const body = { model, max_tokens: maxTokens, messages };
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
//  AGENT IA — AUTO-REMPLISSAGE (1 seul appel Sonnet)
// ============================================================
app.post('/players/autofill', requireAuth, async (req, res) => {
  const { name, league } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom du joueur requis' });

  try {
    // Un seul appel Sonnet avec web search — recherche ET formatage en même temps
    const result = await callClaude([{
      role: 'user',
      content: `You are a professional basketball data analyst. Find accurate stats for player "${name}" currently playing in ${league || 'professional basketball'}.

SEARCH INSTRUCTIONS:
- Search for their CURRENT ${currentSeason()} season stats
- Priority sources: basketball-reference.com, eurobasket.com, proballers.com, espn.com, realgm.com, fibaeurope.com, lnb.fr
- If ${currentSeason()} not available, use most recent season
- Search their current team and league first, then cross-reference

DATA RULES — CRITICAL:
- ALL stats must be PER GAME AVERAGES, never season totals
- Percentages as numbers 0-100 (e.g. FG% = 48.3, NOT 0.483)
- Sanity checks: PTS 0-60, REB 0-25, AST 0-20, STL 0-5, BLK 0-5, FG% 20-75, 3P% 0-55, FT% 40-100
- If a value seems unrealistic for the position, set to null
- Height in centimeters (e.g. 193 for 6'4"), weight in kg
- position format: PG, SG, SF, PF, C, or combinations like PG/SG
- photo_url: direct URL to official headshot if available (ESPN, team website)

Return ONLY a valid JSON object, no markdown, no explanation:
{
  "first_name": "",
  "last_name": "",
  "nationality": "",
  "age": null,
  "height_cm": null,
  "weight_kg": null,
  "position": "",
  "team": "",
  "league": "",
  "season": "",
  "photo_url": "",
  "gp": null,
  "min": null,
  "pts": null,
  "reb": null,
  "ast": null,
  "stl": null,
  "blk": null,
  "tov": null,
  "fga": null,
  "fgm": null,
  "fg_pct": null,
  "fg3a": null,
  "fg3m": null,
  "fg3_pct": null,
  "fta": null,
  "ftm": null,
  "ft_pct": null,
  "per": null,
  "bpm": null,
  "obpm": null,
  "dbpm": null,
  "usg_pct": null,
  "vorp": null,
  "ortg": null,
  "drtg": null,
  "observation": "1 sentence scouting note based on the stats"
}`
    }], {
      webSearch: true,
      maxTokens: 1500,
      model: 'claude-sonnet-4-20250514'
    });

    const player = parseAIJson(result);
    Object.assign(player, calculateAdvancedStats(player));
    res.json({ ok: true, player });

  } catch (e) {
    console.error('[Autofill]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
//  SYNC STATS — Agent IA + BallDontLie NBA
// ============================================================
async function syncPlayerStats(player) {
  const name = `${player.first_name} ${player.last_name}`;
  console.log(`[Sync] ${name} (${player.league})...`);

  try {
    // NBA via BallDontLie
    if (player.league === 'NBA' && process.env.BALLDONTLIE_KEY) {
      const r = await fetch(
        `https://api.balldontlie.io/v1/players?search=${encodeURIComponent(name)}&per_page=3`,
        { headers: { 'Authorization': process.env.BALLDONTLIE_KEY } }
      );
      if (r.ok) {
        const found = (await r.json()).data?.[0];
        if (found) {
          const sr = await fetch(
            `https://api.balldontlie.io/v1/season_averages?player_ids[]=${found.id}&season=2025`,
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
                season: currentSeason(), last_synced_at: new Date().toISOString(),
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

    // Agent IA pour toutes les autres ligues (1 seul appel)
    const result = await callClaude([{
      role: 'user',
      content: `Basketball data analyst task: find ${currentSeason()} per game stats for "${name}" playing in ${player.league || 'professional basketball'}.

Search basketball-reference, eurobasket, proballers, ESPN, realgm, league official sites.
Return ONLY valid JSON. Percentages 0-100. PER GAME averages only (not totals). null if not found.
Sanity check before returning: PTS<60, REB<25, AST<20, STL<5, BLK<5, FG%<80.

{"gp":null,"min":null,"pts":null,"reb":null,"ast":null,"stl":null,"blk":null,"tov":null,"fga":null,"fgm":null,"fg_pct":null,"fg3a":null,"fg3m":null,"fg3_pct":null,"fta":null,"ftm":null,"ft_pct":null,"per":null,"bpm":null,"obpm":null,"dbpm":null,"usg_pct":null,"vorp":null,"ortg":null,"drtg":null,"team":""}`
    }], { webSearch: true, maxTokens: 1000 });

    const stats = parseAIJson(result);
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

app.post('/players/:id/sync', requireAuth, async (req, res) => {
  const { data: player, error } = await db
    .from('players').select('*').eq('id', req.params.id).single();
  if (error || !player) return res.status(404).json({ error: 'Joueur introuvable' });
  syncPlayerStats(player).catch(console.error);
  res.json({ ok: true, message: 'Synchronisation lancée' });
});

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
    await new Promise(r => setTimeout(r, 8000)); // Éviter rate limit Claude API
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

    // Contexte de ligue pour la contextualisation
  const leagueContext = {
    'NBA':           { level: 10, desc: 'meilleure ligue mondiale' },
    'EuroLeague':    { level: 9,  desc: 'meilleur niveau européen' },
    'G-League':      { level: 7,  desc: 'antichambre NBA' },
    'Betclic Élite': { level: 7,  desc: 'premier niveau français, équivalent D2 européen' },
    'EuroCup':       { level: 8,  desc: 'deuxième niveau européen' },
    'BCL':           { level: 7,  desc: 'troisième niveau européen' },
    'Liga ACB (ESP)':{ level: 8,  desc: 'premier niveau espagnol, top-3 européen' },
    'Pro B':         { level: 5,  desc: 'deuxième niveau français' },
    'NM1':           { level: 4,  desc: 'troisième niveau français' },
    'NCAA':          { level: 6,  desc: 'premier niveau universitaire américain' },
    'Lega A (ITA)':  { level: 7,  desc: 'premier niveau italien' },
    'BBL (GER)':     { level: 7,  desc: 'premier niveau allemand' },
    'Korisliiga (FIN)': { level: 5, desc: 'premier niveau finlandais' },
  }
  const lgCtx = leagueContext[player.league] || { level: 5, desc: 'ligue professionnelle' }

  // Détection automatique du profil
  const pts = player.pts || 0
  const ast = player.ast || 0
  const reb = player.reb || 0
  const usg = player.usg_pct || 0
  const ts  = player.ts_pct  || 0
  const bpm = player.bpm     || 0
  const stl = player.stl     || 0
  const blk = player.blk     || 0

  let detectedProfile = ''
  if (usg > 25 && pts > 18)                         detectedProfile = 'Primary scorer / 1st option'
  else if (ast > 6 && usg > 20)                     detectedProfile = 'Playmaker / Primary ball-handler'
  else if (usg > 22 && ast > 4 && pts > 14)         detectedProfile = 'Combo guard / Shot creator'
  else if (ts > 58 && usg < 18 && pts > 10)         detectedProfile = '3&D / Efficient role player'
  else if (reb > 8 && blk > 1.5)                    detectedProfile = 'Rim protector / Defensive anchor'
  else if (reb > 9 && pts > 12)                     detectedProfile = 'Two-way big / Paint presence'
  else if (ast > 5 && usg < 20)                     detectedProfile = 'Point guard / Facilitator'
  else if (stl > 1.5 && bpm > 1)                    detectedProfile = 'Two-way wing / Defensive specialist'
  else if (pts > 15 && ts > 55)                     detectedProfile = 'Efficient scorer / Secondary option'
  else                                               detectedProfile = 'Role player / Specialist'

  // InStat context si disponible
  const instatLines = [
    player.is_pnr_handler_made != null && `PnR Handler: ${player.is_pnr_handler_made}/match`,
    player.is_iso_made         != null && `Isolation: ${player.is_iso_made}/match`,
    player.is_cuts_made        != null && `Cuts: ${player.is_cuts_made}/match`,
    player.is_drives_made      != null && `Drives: ${player.is_drives_made}/match`,
    player.is_catch_shoot_made != null && `Catch&Shoot: ${player.is_catch_shoot_made}/match`,
    player.is_post_made        != null && `Post Up: ${player.is_post_made}/match`,
    player.is_deflections      != null && `Déflexions: ${player.is_deflections}/match`,
    player.is_contested_made   != null && `Tirs contestés mis: ${player.is_contested_made}/match`,
  ].filter(Boolean).join(' | ')

  const prompt = `You are a senior basketball data analyst and scout at NBA front office level.
Your reports are used by sporting directors and head coaches to make recruitment decisions.
Write in French. Be precise, factual, data-driven. Every statement must cite a statistic.
Never use vague phrases like "très athlétique" or "bon potentiel" without data to back it up.

═══════════════════════════════════════
FICHE JOUEUR
═══════════════════════════════════════
Nom : ${name}
Poste : ${player.position} | Profil détecté : ${detectedProfile}
Équipe : ${player.team} | Ligue : ${player.league} (niveau ${lgCtx.level}/10 — ${lgCtx.desc})
Âge : ${player.age} ans | Taille : ${player.height_cm} cm | Nation : ${player.nationality}
Note scout : ${player.scout_grade}/10 | Statut : ${player.status}
Plafond estimé : ${player.ceiling || 'Non défini'}
Comparable : ${player.comparable || 'Non défini'}
Saison : ${player.season || '2025-26'}

═══════════════════════════════════════
STATISTIQUES
═══════════════════════════════════════
${statsLines || 'Non disponibles'}
${instatLines ? `
INSTAT : ${instatLines}` : ''}
${player.strengths   ? `
FORCES OBSERVÉES : ${player.strengths}`      : ''}
${player.weaknesses  ? `
FAIBLESSES OBSERVÉES : ${player.weaknesses}` : ''}
${player.observation ? `
NOTES TERRAIN : ${player.observation}`        : ''}

═══════════════════════════════════════
INSTRUCTIONS DU RAPPORT
═══════════════════════════════════════
Rédige un rapport scout professionnel complet en français avec ces 6 sections :

## PROFIL & IDENTITÉ DE JEU
Définis son archétype précis (ex: "floor general à fort volume de création", "3&D wing efficace en catch-and-shoot", "rim runner dans le PnR"). 
Cite son profil détecté : ${detectedProfile}.
2-3 phrases maximum, chaque mot compte.

## ANALYSE OFFENSIVE
- Contextualise son scoring : ${pts} pts dans ${player.league} (niveau ${lgCtx.level}/10) équivaut à quel impact réel ?
- TS% ${ts}% : au-dessus/en-dessous de la moyenne du poste ? Efficient ou volume scorer ?
- USG% ${usg}% : quelle place dans le système ?
- Si InStat dispo : analyse son mode de création principal (PnR, ISO, Cuts, C&S...)
- Forces et lacunes offensives précises avec chiffres.

## ANALYSE DÉFENSIVE  
- Lire STL (${stl}), BLK (${blk}), DBPM si dispo.
- Engagement défensif réel ou passif ?
- Points faibles défensifs à exploiter.
- Si InStat : déflexions, tirs contestés.

## CONTEXTUALISATION & TRANSLATION
- CRITIQUE : Comment ses stats se traduisent-elles au niveau supérieur ?
- Facteur de traduction ligue : un joueur de ${player.league} (niveau ${lgCtx.level}/10) qui monte en EuroLeague voit ses stats baisser de combien ? Sois précis.
- Quels aspects de son jeu sont "translation-proof" (valables à tous niveaux) ?

## PROJECTION & PLAFOND
- Quel niveau peut-il atteindre dans 2 ans ? 5 ans ?
- Quel rôle précis : starter / quality rotation / specialist / depth ?
- Comparable data-driven : nomme un joueur pro dont les ratios à cet âge ressemblent aux siens. Justifie avec 2-3 stats similaires.
- Si âge < 23 : marge de progression probable sur quel aspect ?

## VERDICT FINAL
Ligne 1 : ⭐ TOP PROSPECT / 🟢 PRIORITAIRE / 🟡 À SURVEILLER / 🔵 EN VEILLE / 🔴 ÉCARTÉ
Ligne 2 : Recommandation d'action concrète (recruter maintenant / observer 3 matchs de plus / écarter / mettre en veille jusqu'à...).
Ligne 3 : Prix de marché estimé (faible/moyen/élevé pour le niveau ${player.league}).\`;

  try {
    const reportText = await callClaude([{ role: 'user', content: prompt }], { maxTokens: 1000 });
    const { data: saved, error: saveError } = await db.from('reports').insert({
      player_id:    req.params.id,
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
  console.log(`🏀 ProspectIQ API v1.0 — port ${PORT}`);
  console.log(`   Sync nocturne : 6h00 Europe/Paris`);
});


// ============================================================
//  BARTTORVIK — Stats NCAA avancées
// ============================================================
app.post('/players/:id/sync-barttorvik', requireAuth, async (req, res) => {
  const { id } = req.params
  const { data: player } = await db.from('players').select('first_name, last_name, team, barttorvik_url').eq('id', id).single()
  if (!player) return res.status(404).json({ error: 'Joueur introuvable' })

  // Extraire params depuis l'URL ou utiliser nom/équipe
  let year = new Date().getFullYear()
  let playerName = `${player.first_name} ${player.last_name}`
  let teamName = player.team || ''

  if (player.barttorvik_url) {
    const url = new URL(player.barttorvik_url)
    year      = url.searchParams.get('year') || year
    playerName = url.searchParams.get('p')   || playerName
    teamName   = url.searchParams.get('t')   || teamName
  }

  try {
    const apiUrl = `https://barttorvik.com/getplayer.php?year=${year}&player=${encodeURIComponent(playerName)}&team=${encodeURIComponent(teamName)}`
    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    })

    if (!resp.ok) throw new Error(`Barttorvik HTTP ${resp.status}`)
    const data = await resp.json()

    if (!data || !data.length) {
      // Fallback scraping HTML
      const htmlUrl = `https://barttorvik.com/playerstat.php?year=${year}&p=${encodeURIComponent(playerName)}&t=${encodeURIComponent(teamName)}`
      const htmlResp = await fetch(htmlUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      })
      const html = await htmlResp.text()

      const getVal = (label) => {
        const regex = new RegExp(`${label}[^\\d-]*([\\d.-]+)`, 'i')
        const m = html.match(regex)
        return m ? parseFloat(m[1]) : null
      }

      const updates = {
        pts:     getVal('PTS'),
        reb:     getVal('REB'),
        ast:     getVal('AST'),
        stl:     getVal('STL'),
        blk:     getVal('BLK'),
        fg_pct:  getVal('FG%') || getVal('eFG'),
        fg3_pct: getVal('3P%'),
        ft_pct:  getVal('FT%'),
        usg_pct: getVal('Usg'),
        bpm:     getVal('BPM') || getVal('OBPM'),
        porpag:  getVal('PORPAG'),
        adjoe:   getVal('AdjOE'),
        season:  `${year-1}-${String(year).slice(2)}`,
        last_synced_at: new Date().toISOString(),
      }

      const filtered = Object.fromEntries(Object.entries(updates).filter(([,v]) => v !== null))
      if (Object.keys(filtered).length < 3) throw new Error('Stats insuffisantes trouvées sur Barttorvik')

      await db.from('players').update(filtered).eq('id', id)
      await logSync('barttorvik', id, 'success', 1)
      return res.json({ ok: true, stats: filtered, source: 'html' })
    }

    // Parser la réponse JSON Barttorvik
    const p = Array.isArray(data[0]) ? data[0] : data
    const updates = {
      pts:     parseFloat(p[4])  || null,
      reb:     parseFloat(p[7])  || null,
      ast:     parseFloat(p[8])  || null,
      stl:     parseFloat(p[10]) || null,
      blk:     parseFloat(p[11]) || null,
      fg_pct:  parseFloat(p[14]) || null,
      fg3_pct: parseFloat(p[15]) || null,
      ft_pct:  parseFloat(p[16]) || null,
      usg_pct: parseFloat(p[17]) || null,
      bpm:     parseFloat(p[19]) || null,
      porpag:  parseFloat(p[22]) || null,
      adjoe:   parseFloat(p[20]) || null,
      season:  `${year-1}-${String(year).slice(2)}`,
      last_synced_at: new Date().toISOString(),
    }

    const filtered = Object.fromEntries(Object.entries(updates).filter(([,v]) => v !== null))
    await db.from('players').update(filtered).eq('id', id)
    await logSync('barttorvik', id, 'success', 1)
    res.json({ ok: true, stats: filtered, source: 'api' })

  } catch (e) {
    console.error('[Barttorvik]', e.message)
    await logSync('barttorvik', id, 'error', 0, e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ============================================================
//  KENPOM — Contexte équipe NCAA
// ============================================================
app.post('/players/:id/sync-kenpom', requireAuth, async (req, res) => {
  const { id } = req.params
  const { team, kenpom_user, kenpom_pass } = req.body
  if (!team) return res.status(400).json({ error: 'Nom d\'équipe requis' })

  try {
    // Login KenPom
    const loginResp = await fetch('https://kenpom.com/handlers/login_handler.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://kenpom.com/index.php',
      },
      body: new URLSearchParams({
        email:    kenpom_user || process.env.KENPOM_EMAIL,
        password: kenpom_pass || process.env.KENPOM_PASSWORD,
        submit:   'Login',
      }),
      redirect: 'manual',
    })

    const cookies = loginResp.headers.get('set-cookie') || ''
    if (!cookies.includes('PHPSESSID')) throw new Error('Login KenPom échoué — vérifie tes identifiants')

    // Récupérer la page équipe
    const teamUrl = `https://kenpom.com/team.php?team=${encodeURIComponent(team)}`
    const teamResp = await fetch(teamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookies,
      }
    })

    if (!teamResp.ok) throw new Error(`KenPom team HTTP ${teamResp.status}`)
    const html = await teamResp.text()

    const getVal = (label) => {
      const regex = new RegExp(`${label}[^\\d-]*([\\d.]+)`, 'i')
      const m = html.match(regex)
      return m ? parseFloat(m[1]) : null
    }

    const teamStats = {
      kenpom_adjoe:  getVal('AdjO') || getVal('Adj\\. O'),
      kenpom_adjde:  getVal('AdjD') || getVal('Adj\\. D'),
      kenpom_tempo:  getVal('AdjT') || getVal('Adj\\. T'),
      kenpom_luck:   getVal('Luck'),
      kenpom_rank:   getVal('Rk') || getVal('Rank'),
    }

    const filtered = Object.fromEntries(Object.entries(teamStats).filter(([,v]) => v !== null))

    if (Object.keys(filtered).length === 0) throw new Error('Aucune donnée KenPom trouvée')

    // Sauvegarder les stats équipe dans la fiche joueur
    await db.from('players').update(filtered).eq('id', id)
    res.json({ ok: true, teamStats: filtered })

  } catch (e) {
    console.error('[KenPom]', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ============================================================
//  RECHERCHE BARTTORVIK par nom (sans URL)
// ============================================================
app.get('/barttorvik/search', requireAuth, async (req, res) => {
  const { name, team, year } = req.query
  if (!name) return res.status(400).json({ error: 'Nom requis' })

  try {
    const y = year || new Date().getFullYear()
    const url = `https://barttorvik.com/getplayer.php?year=${y}&player=${encodeURIComponent(name)}${team ? `&team=${encodeURIComponent(team)}` : ''}`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    res.json({ ok: true, data })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})


// ============================================================
//  PLAYER SEASONS — Stats multi-ligues
// ============================================================

// GET toutes les saisons d'un joueur
app.get('/players/:id/seasons', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('player_seasons')
    .select('*')
    .eq('player_id', req.params.id)
    .order('season', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// POST — ajouter une ligne de stats
app.post('/players/:id/seasons', requireAuth, async (req, res) => {
  const payload = { ...req.body, player_id: req.params.id, updated_at: new Date().toISOString() }
  const { data, error } = await db.from('player_seasons').upsert(payload, {
    onConflict: 'player_id,season,league'
  }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// PATCH — modifier une stat inline
app.patch('/seasons/:seasonId', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('player_seasons')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.seasonId)
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE — supprimer une ligne de stats
app.delete('/seasons/:seasonId', requireAuth, async (req, res) => {
  const { error } = await db.from('player_seasons').delete().eq('id', req.params.seasonId)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// ============================================================
//  VALEUR MARCHANDE — Estimée par IA
// ============================================================
app.post('/players/:id/market-value', requireAuth, async (req, res) => {
  const { data: player } = await db.from('players').select('*').eq('id', req.params.id).single()
  if (!player) return res.status(404).json({ error: 'Joueur introuvable' })

  const statsLines = [
    player.pts     != null && `PTS: ${player.pts}`,
    player.ast     != null && `AST: ${player.ast}`,
    player.reb     != null && `REB: ${player.reb}`,
    player.ts_pct  != null && `TS%: ${player.ts_pct}`,
    player.usg_pct != null && `USG%: ${player.usg_pct}`,
    player.bpm     != null && `BPM: ${player.bpm}`,
    player.net_rtg != null && `Net: ${player.net_rtg}`,
  ].filter(Boolean).join(' | ')

  try {
    const result = await callClaude([{
      role: 'user',
      content: `You are a basketball contract expert with deep knowledge of European and NBA market values.

Player: ${player.first_name} ${player.last_name}
Position: ${player.position} | Age: ${player.age} | League: ${player.league} | Team: ${player.team}
Stats: ${statsLines}
Scout grade: ${player.scout_grade}/10
Ceiling: ${player.ceiling || 'Unknown'}

Estimate the realistic annual market value for this player based on:
1. Current performance and efficiency
2. Age and development trajectory  
3. League level (adjust for competition level)
4. Position scarcity and market demand
5. Recent comparable transfers in Europe

Return ONLY a JSON object:
{
  "market_value": "X€ — Y€ / an",
  "reasoning": "2 sentences max explaining the estimate",
  "comparable_contracts": "1-2 similar player contracts as reference"
}`
    }], { webSearch: true, maxTokens: 400 })

    const json = JSON.parse(result.replace(/```json|```/g, '').trim())
    await db.from('players').update({ market_value: json.market_value }).eq('id', req.params.id)
    res.json(json)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})
