/* ==========================================================================
   LeadSum - Cloudflare Worker Entrypoint (API + Static Assets)
   ========================================================================== */

function getEnv(env, key, defaultVal = "") {
  return (env && env[key]) ? String(env[key]) : defaultVal;
}

function json(statusCode, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status: statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function parseNamedIds(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => {
    const [label, id] = item.split(":");
    return { label: (label || "").trim(), id: (id || "").trim() };
  }).filter((item) => item.label && item.id);
}

function extractTokenFromReq(request) {
  const authHeader = request.headers.get("authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const metaToken = request.headers.get("x-meta-token");
  if (metaToken) {
    return String(metaToken).trim();
  }
  return null;
}

async function graph(env, pathname, params = {}, accessToken) {
  const apiVersion = getEnv(env, "META_API_VERSION", "v22.0");
  const graphBase = `https://graph.facebook.com/${apiVersion}`;
  const effectiveToken = accessToken || getEnv(env, "META_ACCESS_TOKEN");

  if (!effectiveToken) {
    const error = new Error("Token di accesso Meta non fornito. Effettua il login.");
    error.status = 401;
    throw error;
  }

  const url = new URL(`${graphBase}/${pathname.replace(/^\//, "")}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });
  url.searchParams.set("access_token", effectiveToken);

  const response = await fetch(url.toString());
  const payload = await response.json();

  if (!response.ok || payload.error) {
    const error = new Error(payload.error?.message || `Errore Meta API ${response.status}`);
    error.status = response.status;
    error.meta = payload.error || payload;
    throw error;
  }

  return payload;
}

async function graphPost(env, pathname, params = {}, accessToken) {
  const apiVersion = getEnv(env, "META_API_VERSION", "v22.0");
  const graphBase = `https://graph.facebook.com/${apiVersion}`;
  const effectiveToken = accessToken || getEnv(env, "META_ACCESS_TOKEN");

  if (!effectiveToken) {
    const error = new Error("META_ACCESS_TOKEN mancante nelle variabili d'ambiente");
    error.status = 400;
    throw error;
  }

  const url = new URL(`${graphBase}/${pathname.replace(/^\//, "")}`);
  const body = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  });
  body.set("access_token", effectiveToken);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json();

  if (!response.ok || payload.error) {
    const error = new Error(payload.error?.message || `Errore Meta API ${response.status}`);
    error.status = response.status;
    error.meta = payload.error || payload;
    throw error;
  }

  return payload;
}

function pageTokenForId(env, pageId) {
  const page = parseNamedIds(getEnv(env, "META_FACEBOOK_PAGES")).find((item) => item.id === pageId);
  if (!page) return null;
  return getEnv(env, `META_PAGE_ACCESS_TOKEN_${page.label}`, null);
}

function pageTokenForInstagramId(env, instagramId) {
  const instagram = parseNamedIds(getEnv(env, "META_INSTAGRAM_ACCOUNTS")).find((item) => item.id === instagramId);
  if (!instagram) return null;
  return getEnv(env, `META_PAGE_ACCESS_TOKEN_${instagram.label}`, null);
}

function pageForInstagramId(env, instagramId) {
  const instagram = parseNamedIds(getEnv(env, "META_INSTAGRAM_ACCOUNTS")).find((item) => item.id === instagramId);
  if (!instagram) return null;
  return parseNamedIds(getEnv(env, "META_FACEBOOK_PAGES")).find((item) => item.label === instagram.label) || null;
}

async function dynamicPageTokenForId(env, pageId, accessToken) {
  if (!pageId) return null;
  try {
    const page = await graph(env, `/${pageId}`, { fields: "access_token" }, accessToken);
    return page.access_token || null;
  } catch {
    return null;
  }
}

function configuredSources(env) {
  return {
    facebookPages: parseNamedIds(getEnv(env, "META_FACEBOOK_PAGES")),
    instagramAccounts: parseNamedIds(getEnv(env, "META_INSTAGRAM_ACCOUNTS"))
  };
}

function dedupeById(items) {
  return Array.from(new Map(items.filter((item) => item.id).map((item) => [item.id, item])).values());
}

function normalizeBusinessPage(page, sourceType) {
  return {
    id: page.id,
    label: page.name || page.username || page.id,
    name: page.name || page.username || "",
    sourceType
  };
}

function normalizeBusinessInstagram(page, sourceType) {
  const instagram = page.instagram_business_account;
  if (!instagram?.id) return null;
  return {
    id: instagram.id,
    label: instagram.username || instagram.name || page.name || instagram.id,
    name: instagram.name || instagram.username || "",
    pageId: page.id,
    pageName: page.name || "",
    sourceType
  };
}

async function listBusinessPages(env, businessId, edge, sourceType, accessToken) {
  const payload = await graph(env, `/${businessId}/${edge}`, {
    fields: "id,name,username,instagram_business_account{id,username,name}",
    limit: "100"
  }, accessToken);
  const pages = payload.data || [];
  return {
    facebookPages: pages.map((page) => normalizeBusinessPage(page, sourceType)),
    instagramAccounts: pages.map((page) => normalizeBusinessInstagram(page, sourceType)).filter(Boolean)
  };
}

async function listSourcesForAdAccount(env, accountId, accessToken) {
  const fallback = configuredSources(env);
  if (!accountId) return { ...fallback, mode: "configured", note: "Account pubblicitario non selezionato." };

  try {
    const account = await graph(env, `/${accountId}`, { fields: "id,name,business{id,name}" }, accessToken);
    const businessId = account.business?.id;
    if (!businessId) {
      return { ...fallback, mode: "configured", note: "Questo account non espone un Business Manager collegato: uso le fonti configurate." };
    }

    const collected = { facebookPages: [], instagramAccounts: [] };
    const errors = [];
    for (const [edge, sourceType] of [["owned_pages", "business_owned"], ["client_pages", "business_client"]]) {
      try {
        const sources = await listBusinessPages(env, businessId, edge, sourceType, accessToken);
        collected.facebookPages.push(...sources.facebookPages);
        collected.instagramAccounts.push(...sources.instagramAccounts);
      } catch (error) {
        errors.push(`${edge}: ${error.message}`);
      }
    }

    const facebookPages = dedupeById(collected.facebookPages);
    const instagramAccounts = dedupeById(collected.instagramAccounts);
    if (!facebookPages.length && !instagramAccounts.length) {
      return {
        ...fallback,
        mode: "configured",
        note: errors.length ? `Meta non ha restituito pagine dal business: ${errors.join(" | ")}` : "Nessuna pagina business trovata: uso le fonti configurate."
      };
    }

    return {
      facebookPages,
      instagramAccounts,
      mode: "business",
      business: account.business,
      note: `Fonti prese dal Business Manager ${account.business.name || businessId}.`
    };
  } catch (error) {
    return { ...fallback, mode: "configured", note: `Non riesco a leggere il business dell'account: ${error.message}` };
  }
}

async function listAdAccounts(env, accessToken) {
  const effectiveToken = accessToken || getEnv(env, "META_ACCESS_TOKEN");
  if (!effectiveToken) {
    return [];
  }

  const payload = await graph(env, "/me/adaccounts", {
    fields: "id,account_id,name,account_status,currency,timezone_name",
    limit: "100"
  }, effectiveToken);
  return payload.data || [];
}

function parseInsightsMetrics(row = {}) {
  const spend = parseFloat(row.spend || 0);
  const impressions = parseInt(row.impressions || 0, 10);
  const clicks = parseInt(row.clicks || 0, 10);
  const reach = parseInt(row.reach || 0, 10);
  const ctr = parseFloat(row.ctr || (impressions > 0 ? (clicks / impressions) * 100 : 0));
  const cpc = parseFloat(row.cpc || (clicks > 0 ? spend / clicks : 0));
  const cpm = parseFloat(row.cpm || (impressions > 0 ? (spend / impressions) * 1000 : 0));
  const frequency = parseFloat(row.frequency || (reach > 0 ? impressions / reach : 1));

  const actions = Array.isArray(row.actions) ? row.actions : [];
  const actionMap = {};
  actions.forEach((a) => {
    if (a && a.action_type) {
      actionMap[a.action_type] = parseFloat(a.value || 0);
    }
  });

  const formLeads = (actionMap["onsite_conversion.lead_grouped"] || 0) +
                    (actionMap["leadgen_grouped"] || 0) +
                    (actionMap["onsite_conversion.flow_lead"] || 0);

  const pixelLeads = (actionMap["offsite_conversion.fb_pixel_lead"] || 0) +
                     (actionMap["offsite_conversion.custom.lead"] || 0);

  const messagingLeads = (actionMap["onsite_conversion.messaging_conversation_started_7d"] || 0) +
                         (actionMap["onsite_conversion.messaging_user_depth_2_or_higher"] || 0) +
                         (actionMap["onsite_conversion.messaging_first_reply"] || 0);

  const genericLeads = (actionMap["lead"] || 0);
  const contactActions = (actionMap["contact"] || 0) +
                         (actionMap["complete_registration"] || 0) +
                         (actionMap["schedule"] || 0) +
                         (actionMap["submit_application"] || 0);

  let totalLeads = 0;
  if (actionMap["onsite_conversion.lead_grouped"] !== undefined && actionMap["onsite_conversion.lead_grouped"] > 0) {
    totalLeads = actionMap["onsite_conversion.lead_grouped"] + pixelLeads;
  } else if (genericLeads > 0) {
    totalLeads = genericLeads;
  } else {
    totalLeads = formLeads + pixelLeads + messagingLeads + contactActions;
  }

  const cpl = totalLeads > 0 ? spend / totalLeads : 0;

  return {
    spend: Math.round(spend * 100) / 100,
    impressions,
    clicks,
    reach,
    frequency: Math.round(frequency * 100) / 100,
    ctr: Math.round(ctr * 100) / 100,
    cpc: Math.round(cpc * 100) / 100,
    cpm: Math.round(cpm * 100) / 100,
    totalLeads,
    formLeads,
    pixelLeads,
    messagingLeads,
    contactActions,
    cpl: Math.round(cpl * 100) / 100,
    actionMap
  };
}

function calculateActiveDailyBudgets(campaigns = [], adsets = [], ads = []) {
  let totalDailyBudget = 0;
  let cboActiveBudget = 0;
  let aboActiveBudget = 0;
  const campaignBudgetMap = {};
  const adsetBudgetMap = {};

  const activeCampaigns = campaigns.filter(c => c.status === "ACTIVE" || c.effective_status === "ACTIVE");
  const activeCampaignIds = new Set(activeCampaigns.map(c => c.id));

  const activeAdsets = adsets.filter(a => {
    const isStatusActive = a.status === "ACTIVE" || a.effective_status === "ACTIVE";
    const isParentActive = activeCampaignIds.has(a.campaign_id);
    return isStatusActive && isParentActive;
  });
  const activeAdsetIds = new Set(activeAdsets.map(a => a.id));

  const activeCampaignIdsWithActiveAds = new Set();
  const activeAdsetIdsWithActiveAds = new Set();

  ads.forEach(ad => {
    const isAdActive = (ad.status === "ACTIVE" || ad.effective_status === "ACTIVE") &&
                       activeAdsetIds.has(ad.adset_id) &&
                       activeCampaignIds.has(ad.campaign_id);
    if (isAdActive) {
      activeAdsetIdsWithActiveAds.add(ad.adset_id);
      activeCampaignIdsWithActiveAds.add(ad.campaign_id);
    }
  });

  campaigns.forEach(c => {
    const rawDaily = parseFloat(c.daily_budget || 0) / 100;
    const rawLifetime = parseFloat(c.lifetime_budget || 0) / 100;
    const isCBO = rawDaily > 0 || rawLifetime > 0;
    const isStrictlyActiveCBO = activeCampaignIds.has(c.id) && activeCampaignIdsWithActiveAds.has(c.id) && rawDaily > 0;

    campaignBudgetMap[c.id] = {
      isCBO,
      dailyBudget: rawDaily,
      lifetimeBudget: rawLifetime,
      type: isCBO ? (rawDaily > 0 ? "CBO Giornaliero" : "CBO Totale") : "ABO",
      isActiveDaily: isStrictlyActiveCBO
    };

    if (isStrictlyActiveCBO) {
      totalDailyBudget += rawDaily;
      cboActiveBudget += rawDaily;
    }
  });

  adsets.forEach(a => {
    const rawDaily = parseFloat(a.daily_budget || 0) / 100;
    const rawLifetime = parseFloat(a.lifetime_budget || 0) / 100;
    const parentCBO = campaignBudgetMap[a.campaign_id]?.isCBO;

    const isStrictlyActiveABO = !parentCBO &&
                               activeCampaignIds.has(a.campaign_id) &&
                               activeAdsetIds.has(a.id) &&
                               activeAdsetIdsWithActiveAds.has(a.id) &&
                               rawDaily > 0;

    adsetBudgetMap[a.id] = {
      dailyBudget: rawDaily,
      lifetimeBudget: rawLifetime,
      isABO: !parentCBO && rawDaily > 0,
      isActiveDaily: isStrictlyActiveABO
    };

    if (isStrictlyActiveABO) {
      totalDailyBudget += rawDaily;
      aboActiveBudget += rawDaily;
    }
  });

  return {
    totalDailyBudget: Math.round(totalDailyBudget * 100) / 100,
    cboActiveBudget: Math.round(cboActiveBudget * 100) / 100,
    aboActiveBudget: Math.round(aboActiveBudget * 100) / 100,
    campaignBudgetMap,
    adsetBudgetMap
  };
}

function getDemoInsightsData(datePreset = "last_7d") {
  const daysCount = datePreset === "today" ? 1 : (datePreset === "yesterday" ? 1 : (datePreset === "last_30d" ? 30 : 7));
  const mult = daysCount === 1 ? 1 : (daysCount === 30 ? 4.2 : 1.8);

  const campaigns = [
    {
      id: "cmp_demo_101",
      name: "[CBO] Lead Gen - Acquisizione Contatti Immobiliari",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      objective: "OUTCOME_LEADS",
      daily_budget: "6000",
      lifetime_budget: null,
      budgetType: "CBO Giornaliero",
      dailyBudgetVal: 60.00,
      todaySpend: 42.80,
      todayLeads: 9,
      todayCpl: 4.75,
      spend: Math.round(312.40 * mult * 100) / 100,
      totalLeads: Math.round(68 * mult),
      formLeads: Math.round(58 * mult),
      pixelLeads: Math.round(10 * mult),
      messagingLeads: 0,
      cpl: 4.59,
      impressions: Math.round(18500 * mult),
      clicks: Math.round(540 * mult),
      ctr: 2.92,
      cpc: 0.58,
      cpm: 16.88
    },
    {
      id: "cmp_demo_102",
      name: "[ABO] WhatsApp Direct - Consulenza & Preventivi",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      objective: "OUTCOME_ENGAGEMENT",
      daily_budget: null,
      lifetime_budget: null,
      budgetType: "ABO (Livello Gruppo)",
      dailyBudgetVal: 40.00,
      todaySpend: 28.50,
      todayLeads: 5,
      todayCpl: 5.70,
      spend: Math.round(198.60 * mult * 100) / 100,
      totalLeads: Math.round(32 * mult),
      formLeads: 0,
      pixelLeads: 0,
      messagingLeads: Math.round(32 * mult),
      cpl: 6.20,
      impressions: Math.round(12400 * mult),
      clicks: Math.round(390 * mult),
      ctr: 3.15,
      cpc: 0.51,
      cpm: 16.01
    }
  ];

  const adsets = [
    {
      id: "adset_demo_201",
      campaign_id: "cmp_demo_101",
      campaign_name: "[CBO] Lead Gen - Acquisizione Contatti Immobiliari",
      name: "Lookalike 1% Acquirenti & Form Inviati",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      daily_budget: null,
      dailyBudgetVal: 0.00,
      spend: Math.round(184.20 * mult * 100) / 100,
      totalLeads: Math.round(45 * mult),
      cpl: 4.09,
      impressions: Math.round(11200 * mult),
      clicks: Math.round(340 * mult),
      ctr: 3.04
    }
  ];

  const ads = [
    {
      id: "ad_demo_301",
      name: "ADV 01 - Video Tour Villa con Giardino [Top]",
      campaign_id: "cmp_demo_101",
      campaign_name: "[CBO] Lead Gen - Acquisizione Contatti Immobiliari",
      adset_id: "adset_demo_201",
      adset_name: "Lookalike 1% Acquirenti & Form Inviati",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      spend: Math.round(112.50 * mult * 100) / 100,
      totalLeads: Math.round(31 * mult),
      cpl: 3.63,
      impressions: Math.round(7400 * mult),
      clicks: Math.round(230 * mult),
      ctr: 3.11,
      cpc: 0.49,
      cpm: 15.20,
      creative: {
        title: "Nuova Villa con Giardino a pochi minuti dal centro",
        body: "Scarica subito la scheda tecnica e prenota una visita privata.",
        thumbnail_url: "assets/default-creative.svg"
      }
    }
  ];

  const totalSpend = campaigns.reduce((acc, c) => acc + c.spend, 0);
  const totalLeads = campaigns.reduce((acc, c) => acc + c.totalLeads, 0);
  const formLeads = campaigns.reduce((acc, c) => acc + c.formLeads, 0);
  const pixelLeads = campaigns.reduce((acc, c) => acc + c.pixelLeads, 0);
  const messagingLeads = campaigns.reduce((acc, c) => acc + c.messagingLeads, 0);
  const impressions = campaigns.reduce((acc, c) => acc + c.impressions, 0);
  const clicks = campaigns.reduce((acc, c) => acc + c.clicks, 0);
  const averageCpl = totalLeads > 0 ? totalSpend / totalLeads : 0;
  const totalDailyBudget = 100.00;
  const todaySpend = 71.30;
  const yesterdaySpend = 95.40;
  const averageDailySpend = Math.round((totalSpend / daysCount) * 100) / 100;
  const pacingPercent = Math.round((todaySpend / totalDailyBudget) * 1000) / 10;
  const projectedTodaySpend = Math.round(todaySpend * 1.35 * 100) / 100;

  return {
    isDemo: true,
    account: {
      id: "act_demo_123456789",
      name: "Account Demo - Lead Intelligence",
      currency: "EUR",
      timezone_name: "Europe/Rome",
      status: "ACTIVE"
    },
    dateRange: {
      preset: datePreset,
      daysCount
    },
    kpis: {
      totalSpend: Math.round(totalSpend * 100) / 100,
      totalLeads,
      averageCpl: Math.round(averageCpl * 100) / 100,
      todaySpend,
      yesterdaySpend,
      averageDailySpend,
      totalDailyBudget,
      pacingPercent,
      projectedTodaySpend,
      impressions,
      clicks,
      ctr: impressions > 0 ? Math.round((clicks / impressions) * 10000) / 100 : 0,
      cpc: clicks > 0 ? Math.round((totalSpend / clicks) * 100) / 100 : 0,
      cpm: impressions > 0 ? Math.round((totalSpend / impressions) * 100000) / 100 : 0
    },
    leadBreakdown: {
      formLeads,
      pixelLeads,
      messagingLeads
    },
    campaigns,
    adsets,
    ads
  };
}

function getDemoDailyTrendData(datePreset = "last_7d") {
  const days = datePreset === "last_30d" ? 30 : (datePreset === "last_14d" ? 14 : 7);
  const list = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const baseSpend = isWeekend ? 115 : 92;
    const spend = Math.round((baseSpend + (Math.sin(i) * 18) + (Math.random() * 10)) * 100) / 100;
    const leads = Math.max(3, Math.round(spend / (4.8 + Math.sin(i * 1.5) * 1.2)));
    const cpl = Math.round((spend / leads) * 100) / 100;
    const impressions = Math.round(spend * 58);
    const clicks = Math.round(impressions * 0.028);

    list.push({
      date: dateStr,
      dateFormatted: d.toLocaleDateString("it-IT", { day: "2-digit", month: "short" }),
      spend,
      leads,
      cpl,
      impressions,
      clicks,
      ctr: Math.round((clicks / impressions) * 10000) / 100
    });
  }

  return list;
}

async function fetchLiveInsightsSummary(env, accountId, query = {}, accessToken) {
  const datePreset = query.datePreset || "last_7d";
  const since = query.since;
  const until = query.until;

  const timeParams = {};
  if (since && until) {
    timeParams.time_range = JSON.stringify({ since, until });
  } else {
    timeParams.date_preset = datePreset;
  }

  const [accountInfo, campaignsRes, adsetsRes, adsRes] = await Promise.all([
    graph(env, `/${accountId}`, { fields: "id,account_id,name,currency,timezone_name,account_status" }, accessToken),
    graph(env, `/${accountId}/campaigns`, {
      fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,buying_type,created_time,updated_time",
      limit: "200"
    }, accessToken).catch(() => ({ data: [] })),
    graph(env, `/${accountId}/adsets`, {
      fields: "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,optimization_goal,billing_event,bid_amount,created_time,updated_time",
      limit: "250"
    }, accessToken).catch(() => ({ data: [] })),
    graph(env, `/${accountId}/ads`, {
      fields: "id,name,status,effective_status,campaign_id,adset_id,created_time,updated_time",
      limit: "300"
    }, accessToken).catch(() => ({ data: [] }))
  ]);

  const campaigns = campaignsRes.data || [];
  const adsets = adsetsRes.data || [];
  const ads = adsRes.data || [];

  const { totalDailyBudget, campaignBudgetMap, adsetBudgetMap } = calculateActiveDailyBudgets(campaigns, adsets, ads);

  const [accountInsightsRes, todayInsightsRes, yesterdayInsightsRes, campaignInsightsRes, adsetInsightsRes, adInsightsRes, todayCampaignInsightsRes] = await Promise.all([
    graph(env, `/${accountId}/insights`, {
      ...timeParams,
      fields: "spend,impressions,clicks,reach,ctr,cpc,cpm,frequency,actions,cost_per_action_type"
    }, accessToken).catch(() => ({ data: [] })),
    graph(env, `/${accountId}/insights`, {
      date_preset: "today",
      fields: "spend,actions"
    }, accessToken).catch(() => ({ data: [] })),
    graph(env, `/${accountId}/insights`, {
      date_preset: "yesterday",
      fields: "spend,actions"
    }, accessToken).catch(() => ({ data: [] })),
    graph(env, `/${accountId}/insights`, {
      ...timeParams,
      level: "campaign",
      fields: "campaign_id,campaign_name,spend,impressions,clicks,reach,ctr,cpc,cpm,actions,cost_per_action_type",
      limit: "200"
    }, accessToken).catch(() => ({ data: [] })),
    graph(env, `/${accountId}/insights`, {
      ...timeParams,
      level: "adset",
      fields: "adset_id,adset_name,campaign_id,spend,impressions,clicks,reach,ctr,cpc,cpm,actions,cost_per_action_type",
      limit: "250"
    }, accessToken).catch(() => ({ data: [] })),
    graph(env, `/${accountId}/insights`, {
      ...timeParams,
      level: "ad",
      fields: "ad_id,ad_name,adset_id,campaign_id,spend,impressions,clicks,reach,ctr,cpc,cpm,actions,cost_per_action_type",
      limit: "300"
    }, accessToken).catch(() => ({ data: [] })),
    graph(env, `/${accountId}/insights`, {
      date_preset: "today",
      level: "campaign",
      fields: "campaign_id,spend,actions",
      limit: "200"
    }, accessToken).catch(() => ({ data: [] }))
  ]);

  const todayCampaignMap = {};
  (todayCampaignInsightsRes.data || []).forEach(row => {
    const parsed = parseInsightsMetrics(row);
    todayCampaignMap[row.campaign_id] = {
      spend: parsed.spend,
      leads: parsed.totalLeads,
      cpl: parsed.cpl
    };
  });

  const accountMetric = parseInsightsMetrics(accountInsightsRes.data?.[0] || {});
  const todayMetric = parseInsightsMetrics(todayInsightsRes.data?.[0] || {});
  const yesterdayMetric = parseInsightsMetrics(yesterdayInsightsRes.data?.[0] || {});

  const campaignMap = new Map(campaigns.map(c => [c.id, c]));
  const adsetMap = new Map(adsets.map(a => [a.id, a]));

  const campaignInsightMap = {};
  (campaignInsightsRes.data || []).forEach(row => {
    campaignInsightMap[row.campaign_id] = parseInsightsMetrics(row);
  });

  const adsetInsightMap = {};
  (adsetInsightsRes.data || []).forEach(row => {
    adsetInsightMap[row.adset_id] = parseInsightsMetrics(row);
  });

  const adInsightMap = {};
  (adInsightsRes.data || []).forEach(row => {
    adInsightMap[row.ad_id] = parseInsightsMetrics(row);
  });

  const numericActId = String(accountInfo.account_id || accountInfo.id || accountId).replace(/^act_/, "");

  const enrichedCampaigns = campaigns.map(c => {
    const metrics = campaignInsightMap[c.id] || parseInsightsMetrics({});
    const today = todayCampaignMap[c.id] || { spend: 0, leads: 0, cpl: 0 };
    const budgetInfo = campaignBudgetMap[c.id] || { isCBO: false, dailyBudget: 0, lifetimeBudget: 0, type: "ABO" };

    return {
      id: c.id,
      name: c.name,
      adsManagerUrl: `https://www.facebook.com/adsmanager/manage/campaigns?act=${numericActId}&selected_campaign_ids=${c.id}`,
      status: c.status,
      effective_status: c.effective_status,
      objective: c.objective,
      budgetType: budgetInfo.type,
      dailyBudgetVal: budgetInfo.dailyBudget,
      lifetimeBudgetVal: budgetInfo.lifetimeBudget,
      todaySpend: today.spend,
      todayLeads: today.leads,
      todayCpl: today.cpl,
      spend: metrics.spend,
      totalLeads: metrics.totalLeads,
      formLeads: metrics.formLeads,
      pixelLeads: metrics.pixelLeads,
      messagingLeads: metrics.messagingLeads,
      cpl: metrics.cpl,
      impressions: metrics.impressions,
      clicks: metrics.clicks,
      ctr: metrics.ctr,
      cpc: metrics.cpc,
      cpm: metrics.cpm
    };
  });

  const enrichedAdsets = adsets.map(a => {
    const metrics = adsetInsightMap[a.id] || parseInsightsMetrics({});
    const parentCamp = campaignMap.get(a.campaign_id);
    const budgetInfo = adsetBudgetMap[a.id] || { dailyBudget: 0, lifetimeBudget: 0, isABO: false };

    return {
      id: a.id,
      name: a.name,
      campaign_id: a.campaign_id,
      campaign_name: parentCamp?.name || a.campaign_id,
      adsManagerUrl: `https://www.facebook.com/adsmanager/manage/adsets?act=${numericActId}&selected_adset_ids=${a.id}`,
      status: a.status,
      effective_status: a.effective_status,
      dailyBudgetVal: budgetInfo.dailyBudget,
      lifetimeBudgetVal: budgetInfo.lifetimeBudget,
      isABO: budgetInfo.isABO,
      spend: metrics.spend,
      totalLeads: metrics.totalLeads,
      cpl: metrics.cpl,
      impressions: metrics.impressions,
      clicks: metrics.clicks,
      ctr: metrics.ctr,
      cpc: metrics.cpc,
      cpm: metrics.cpm
    };
  });

  const enrichedAds = ads.map(ad => {
    const metrics = adInsightMap[ad.id] || parseInsightsMetrics({});
    const parentCamp = campaignMap.get(ad.campaign_id);
    const parentAdset = adsetMap.get(ad.adset_id);

    return {
      id: ad.id,
      name: ad.name,
      campaign_id: ad.campaign_id,
      campaign_name: parentCamp?.name || ad.campaign_id,
      adset_id: ad.adset_id,
      adset_name: parentAdset?.name || ad.adset_id,
      adsManagerUrl: `https://www.facebook.com/adsmanager/manage/ads?act=${numericActId}&selected_ad_ids=${ad.id}`,
      status: ad.status,
      effective_status: ad.effective_status,
      spend: metrics.spend,
      totalLeads: metrics.totalLeads,
      cpl: metrics.cpl,
      impressions: metrics.impressions,
      clicks: metrics.clicks,
      ctr: metrics.ctr,
      cpc: metrics.cpc,
      cpm: metrics.cpm
    };
  });

  const adIdSet = new Set(ads.map(a => a.id));
  (adInsightsRes.data || []).forEach(row => {
    if (row.ad_id && !adIdSet.has(row.ad_id)) {
      const metrics = parseInsightsMetrics(row);
      const parentCamp = campaignMap.get(row.campaign_id);
      const parentAdset = adsetMap.get(row.adset_id);
      enrichedAds.push({
        id: row.ad_id,
        name: row.ad_name || `Inserzione ${row.ad_id}`,
        campaign_id: row.campaign_id,
        campaign_name: parentCamp?.name || row.campaign_name || row.campaign_id,
        adset_id: row.adset_id,
        adset_name: parentAdset?.name || row.adset_name || row.adset_id,
        adsManagerUrl: `https://www.facebook.com/adsmanager/manage/ads?act=${numericActId}&selected_ad_ids=${row.ad_id}`,
        status: "PAUSED",
        effective_status: "PAUSED",
        spend: metrics.spend,
        totalLeads: metrics.totalLeads,
        cpl: metrics.cpl,
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        ctr: metrics.ctr,
        cpc: metrics.cpc,
        cpm: metrics.cpm
      });
    }
  });

  const daysCount = datePreset === "today" || datePreset === "yesterday" ? 1 : (datePreset === "last_30d" ? 30 : (datePreset === "last_14d" ? 14 : 7));
  const averageDailySpend = Math.round((accountMetric.spend / daysCount) * 100) / 100;
  const pacingPercent = totalDailyBudget > 0 ? Math.round((todayMetric.spend / totalDailyBudget) * 1000) / 10 : 0;
  const projectedTodaySpend = Math.round(todayMetric.spend * 1.35 * 100) / 100;

  return {
    isDemo: false,
    account: {
      id: accountInfo.id,
      account_id: accountInfo.account_id,
      name: accountInfo.name,
      currency: accountInfo.currency || "EUR",
      timezone_name: accountInfo.timezone_name || "Europe/Rome",
      status: accountInfo.account_status === 1 ? "ACTIVE" : "OTHER"
    },
    dateRange: {
      preset: datePreset,
      since,
      until,
      daysCount
    },
    kpis: {
      totalSpend: accountMetric.spend,
      totalLeads: accountMetric.totalLeads,
      averageCpl: accountMetric.cpl,
      todaySpend: todayMetric.spend,
      yesterdaySpend: yesterdayMetric.spend,
      averageDailySpend,
      totalDailyBudget,
      pacingPercent,
      projectedTodaySpend,
      impressions: accountMetric.impressions,
      clicks: accountMetric.clicks,
      ctr: accountMetric.ctr,
      cpc: accountMetric.cpc,
      cpm: accountMetric.cpm,
      frequency: accountMetric.frequency,
      reach: accountMetric.reach
    },
    leadBreakdown: {
      formLeads: accountMetric.formLeads,
      pixelLeads: accountMetric.pixelLeads,
      messagingLeads: accountMetric.messagingLeads
    },
    campaigns: enrichedCampaigns,
    adsets: enrichedAdsets,
    ads: enrichedAds
  };
}

async function fetchLiveDailyTrend(env, accountId, query = {}, accessToken) {
  const datePreset = query.datePreset || "last_7d";
  const since = query.since;
  const until = query.until;

  const timeParams = {};
  if (since && until) {
    timeParams.time_range = JSON.stringify({ since, until });
  } else {
    timeParams.date_preset = datePreset;
  }

  const payload = await graph(env, `/${accountId}/insights`, {
    ...timeParams,
    time_increment: "1",
    fields: "date_start,spend,impressions,clicks,actions,cost_per_action_type",
    limit: "100"
  }, accessToken);

  return (payload.data || []).map(row => {
    const parsed = parseInsightsMetrics(row);
    const dateObj = new Date(row.date_start);
    return {
      date: row.date_start,
      dateFormatted: isNaN(dateObj.getTime()) ? row.date_start : dateObj.toLocaleDateString("it-IT", { day: "2-digit", month: "short" }),
      spend: parsed.spend,
      leads: parsed.totalLeads,
      cpl: parsed.cpl,
      impressions: parsed.impressions,
      clicks: parsed.clicks,
      ctr: parsed.ctr
    };
  });
}

async function handleApi(request, env, url) {
  try {
    const userToken = extractTokenFromReq(request);
    const serverToken = getEnv(env, "META_ACCESS_TOKEN");
    const effectiveToken = userToken || serverToken;
    const apiVersion = getEnv(env, "META_API_VERSION", "v22.0");

    if (url.pathname === "/api/auth/me") {
      const appId = getEnv(env, "META_APP_ID", "1487594375621582");
      if (!effectiveToken) {
        return json(200, { authenticated: false, appId });
      }

      try {
        const userRes = await graph(env, "/me", { fields: "id,name,picture{url}" }, effectiveToken);
        return json(200, {
          authenticated: true,
          appId,
          user: {
            id: userRes.id,
            name: userRes.name,
            picture: userRes.picture?.data?.url || null
          }
        });
      } catch (err) {
        return json(200, {
          authenticated: false,
          appId,
          error: err.message
        });
      }
    }

    if (url.pathname === "/api/auth/facebook-login" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const incomingToken = body.accessToken;
      const appId = getEnv(env, "META_APP_ID", "1487594375621582");
      const appSecret = getEnv(env, "META_APP_SECRET", "");

      if (!incomingToken) {
        return json(400, { error: "Access token non fornito" });
      }

      try {
        let finalToken = incomingToken;
        if (appSecret) {
          try {
            const exchangeRes = await fetch(`https://graph.facebook.com/${apiVersion}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${incomingToken}`);
            const exchangeData = await exchangeRes.json();
            if (exchangeData.access_token) {
              finalToken = exchangeData.access_token;
            }
          } catch (e) {
            console.warn("Could not exchange for long lived token:", e.message);
          }
        }

        const userRes = await graph(env, "/me", { fields: "id,name,picture{url}" }, finalToken);
        return json(200, {
          ok: true,
          accessToken: finalToken,
          user: {
            id: userRes.id,
            name: userRes.name,
            picture: userRes.picture?.data?.url || null
          }
        });
      } catch (err) {
        return json(401, {
          ok: false,
          error: `Login Meta non riuscito: ${err.message}`
        });
      }
    }

    if (url.pathname === "/api/auth/quick-login" && request.method === "POST") {
      if (!serverToken) {
        return json(400, { error: "Nessun token configurato nelle variabili d'ambiente del server (META_ACCESS_TOKEN)." });
      }

      let userObj = { id: "admin_user", name: "Amministratore LeadSum", picture: null };
      try {
        const userRes = await graph(env, "/me", { fields: "id,name,picture{url}" }, serverToken);
        if (userRes && userRes.name) {
          userObj = {
            id: userRes.id,
            name: userRes.name,
            picture: userRes.picture?.data?.url || null
          };
        }
      } catch (e) {
        console.warn("Could not fetch user profile from server token:", e.message);
      }

      return json(200, {
        ok: true,
        accessToken: serverToken,
        user: userObj
      });
    }

    if (url.pathname === "/api/meta/insights/clients-overview") {
      const accountIdsParam = url.searchParams.get("accountIds");
      const datePreset = url.searchParams.get("datePreset") || "yesterday";
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");
      const threshold = parseFloat(url.searchParams.get("threshold") || "15.00");

      if (!effectiveToken) {
        return json(401, {
          error: "Sessione non autenticata. Effettua prima l'accesso con Facebook.",
          requiresAuth: true
        });
      }

      let targetAccounts = [];
      const allAccs = await listAdAccounts(env, effectiveToken).catch(() => []);
      if (accountIdsParam && accountIdsParam !== "none") {
        const ids = accountIdsParam.split(",").map(s => s.trim()).filter(Boolean);
        targetAccounts = allAccs.filter(a => ids.includes(a.id));
      } else {
        targetAccounts = allAccs;
      }

      if (targetAccounts.length === 0) {
        return json(200, {
          isDemo: true,
          datePreset,
          since: since || null,
          until: until || null,
          clients: [
            {
              id: "act_demo_101",
              account_id: "demo_101",
              name: "Immobiliare Prestigio & Sviluppo",
              currency: "EUR",
              activeCampaignsCount: 2,
              totalCampaignsCount: 3,
              totalLeads: 68,
              formLeads: 58,
              messagingLeads: 0,
              pixelLeads: 10,
              spend: 312.40,
              cpl: 4.59,
              dailyBudget: 60.00,
              cboBudget: 60.00,
              aboBudget: 0,
              impressions: 18500,
              clicks: 540,
              ctr: 2.92,
              alertAdsCount: 0
            }
          ]
        });
      }

      const timeParams = {};
      if (datePreset === "custom" && since && until) {
        timeParams.time_range = JSON.stringify({ since, until });
      } else {
        timeParams.date_preset = datePreset;
      }

      const clientPromises = targetAccounts.map(async (acc) => {
        try {
          const [insightsRes, campaignsRes, adsetsRes, adsRes] = await Promise.all([
            graph(env, `/${acc.id}/insights`, {
              ...timeParams,
              fields: "spend,actions",
              limit: "5"
            }, effectiveToken).catch(() => ({ data: [] })),

            graph(env, `/${acc.id}/campaigns`, {
              fields: "id,name,status,effective_status,daily_budget,lifetime_budget",
              effective_status: "['ACTIVE']",
              limit: "100"
            }, effectiveToken).catch(() => ({ data: [] })),

            graph(env, `/${acc.id}/adsets`, {
              fields: "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget",
              effective_status: "['ACTIVE']",
              limit: "150"
            }, effectiveToken).catch(() => ({ data: [] })),

            graph(env, `/${acc.id}/ads`, {
              fields: "id,name,campaign_id,adset_id,status,effective_status",
              effective_status: "['ACTIVE']",
              limit: "250"
            }, effectiveToken).catch(() => ({ data: [] }))
          ]);

          const parsed = parseInsightsMetrics(insightsRes.data?.[0] || {});
          const activeCampaigns = campaignsRes.data || [];
          const activeAdsets = adsetsRes.data || [];
          const activeAds = adsRes.data || [];

          const { totalDailyBudget, cboActiveBudget, aboActiveBudget } = calculateActiveDailyBudgets(
            activeCampaigns,
            activeAdsets,
            activeAds
          );

          const isHighCpl = parsed.totalLeads > 0 && parsed.cpl > threshold;
          const isZeroLeadWaste = parsed.totalLeads === 0 && parsed.spend >= threshold;
          const alertAdsCount = (isHighCpl || isZeroLeadWaste) ? 1 : 0;

          return {
            id: acc.id,
            account_id: acc.account_id,
            name: acc.name,
            currency: acc.currency || "EUR",
            activeCampaignsCount: activeCampaigns.length,
            totalCampaignsCount: campaignsRes.data?.length || activeCampaigns.length,
            totalLeads: parsed.totalLeads,
            formLeads: parsed.formLeads,
            messagingLeads: parsed.messagingLeads,
            pixelLeads: parsed.pixelLeads,
            spend: parsed.spend,
            cpl: parsed.cpl,
            dailyBudget: totalDailyBudget,
            cboBudget: cboActiveBudget,
            aboBudget: aboActiveBudget,
            impressions: parsed.impressions,
            clicks: parsed.clicks,
            ctr: parsed.ctr,
            alertAdsCount
          };
        } catch (err) {
          return {
            id: acc.id,
            account_id: acc.account_id,
            name: acc.name,
            currency: acc.currency || "EUR",
            activeCampaignsCount: 0,
            totalLeads: 0,
            spend: 0,
            cpl: 0,
            dailyBudget: 0,
            alertAdsCount: 0,
            error: err.message
          };
        }
      });

      const clients = await Promise.all(clientPromises);
      return json(200, {
        isDemo: false,
        datePreset,
        since: since || null,
        until: until || null,
        clients
      });
    }

    if (url.pathname === "/api/meta/insights/summary") {
      const accountId = url.searchParams.get("accountId") || getEnv(env, "META_AD_ACCOUNT_ID", "act_demo_123456789");
      const datePreset = url.searchParams.get("datePreset") || "last_7d";
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");

      if (accountId.startsWith("act_demo") || accountId === "demo") {
        return json(200, getDemoInsightsData(datePreset));
      }

      if (!effectiveToken) {
        return json(401, {
          error: "Sessione Meta non autenticata. Effettua l'accesso con Facebook o inserisci un Access Token valido."
        });
      }

      try {
        const summary = await fetchLiveInsightsSummary(env, accountId, { datePreset, since, until }, effectiveToken);
        return json(200, summary);
      } catch (error) {
        return json(500, {
          error: `Errore caricamento inserzioni reali da Meta per ${accountId}: ${error.message}`
        });
      }
    }

    if (url.pathname === "/api/meta/insights/daily") {
      const accountId = url.searchParams.get("accountId") || "demo";
      const datePreset = url.searchParams.get("datePreset") || "last_7d";
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");

      if (accountId.startsWith("act_demo") || accountId === "demo" || !effectiveToken) {
        return json(200, { dailyTrends: getDemoDailyTrendData(datePreset) });
      }

      try {
        const dailyTrends = await fetchLiveDailyTrend(env, accountId, { datePreset, since, until }, effectiveToken);
        return json(200, { dailyTrends });
      } catch (error) {
        return json(200, { dailyTrends: getDemoDailyTrendData(datePreset), liveError: error.message });
      }
    }

    if (url.pathname === "/api/meta/ads/toggle-status" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { adId, status } = body;

      if (!adId || !status) {
        return json(400, { error: "Parametri mancanti: adId e status sono obbligatori" });
      }

      if (adId.startsWith("ad_demo") || !effectiveToken) {
        return json(200, { ok: true, adId, status, message: `Stato inserzione demo aggiornato a ${status}` });
      }

      const response = await graphPost(env, `/${adId}`, { status }, effectiveToken);
      return json(200, { ok: true, adId, status, meta: response });
    }

    if (url.pathname === "/api/meta/config") {
      let adAccounts = [];
      let adAccountsError = null;
      try {
        adAccounts = await listAdAccounts(env, effectiveToken);
      } catch (error) {
        adAccountsError = error.message;
      }
      if (!adAccounts || adAccounts.length === 0) {
        adAccounts = [
          {
            id: "act_demo_101",
            account_id: "demo_101",
            name: "Immobiliare Prestigio & Sviluppo",
            account_status: 1,
            currency: "EUR",
            timezone_name: "Europe/Rome",
            isDemo: true
          }
        ];
      }
      return json(200, {
        apiVersion,
        loginConfigId: getEnv(env, "META_LOGIN_CONFIG_ID", null),
        hasToken: Boolean(effectiveToken),
        ...configuredSources(env),
        adAccounts,
        adAccountsError
      });
    }

    if (url.pathname === "/api/meta/sources") {
      const accountId = url.searchParams.get("accountId");
      return json(200, await listSourcesForAdAccount(env, accountId, effectiveToken));
    }

    if (url.pathname === "/api/meta/adaccounts") {
      return json(200, { data: await listAdAccounts(env, effectiveToken) });
    }

    if (url.pathname === "/api/meta/campaigns") {
      const accountId = url.searchParams.get("accountId");
      if (!accountId || accountId.startsWith("act_demo") || !effectiveToken) {
        const demo = getDemoInsightsData("last_7d");
        return json(200, { data: demo.campaigns });
      }
      const payload = await graph(env, `/${accountId}/campaigns`, {
        fields: "id,name,status,effective_status,objective,created_time,updated_time",
        limit: "100"
      }, effectiveToken);
      return json(200, payload);
    }

    if (url.pathname === "/api/meta/adsets") {
      const accountId = url.searchParams.get("accountId");
      const campaignId = url.searchParams.get("campaignId");
      if (!accountId || accountId.startsWith("act_demo") || !effectiveToken) {
        const demo = getDemoInsightsData("last_7d");
        let sets = demo.adsets;
        if (campaignId) sets = sets.filter(s => s.campaign_id === campaignId);
        return json(200, { data: sets });
      }
      const filtering = campaignId ? JSON.stringify([{ field: "campaign.id", operator: "EQUAL", value: campaignId }]) : "";
      const payload = await graph(env, `/${accountId}/adsets`, {
        fields: "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,billing_event,optimization_goal",
        filtering,
        limit: "100"
      }, effectiveToken);
      return json(200, payload);
    }

    return json(404, { error: "Endpoint non trovato" });
  } catch (error) {
    return json(error.status || 500, {
      error: error.message,
      meta: error.meta || null
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not Found", { status: 404 });
  }
};
