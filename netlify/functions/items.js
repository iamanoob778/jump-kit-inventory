// netlify/functions/items.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Keyword -> category map, ordered roughly by TCCC/TECC priority (most
// specific / life-critical matches first, so e.g. "chest seal" hits Airway
// & Breathing before a generic "seal" rule could ever exist). Each entry is
// [regex, category label]. Matching is case-insensitive against the item
// name. First match wins.
const CATEGORY_RULES = [
  [/tourniquet|\bcat\b|hemostatic|quikclot|quik-?clot|celox|combat gauze|pressure dressing|israeli bandage|emergency bandage|junctional/i, 'Hemorrhage Control'],
  [/chest seal|occlusive|needle decompression|\bnpa\b|nasopharyngeal|\bopa\b|oral airway|airway|bag valve mask|\bbvm\b|cric(othyroidotomy)?|king tube|supraglottic/i, 'Airway & Breathing'],
  [/splint|\bsam splint\b|cravat|triangular bandage|c-collar|cervical collar|backboard/i, 'Splinting & Fractures'],
  [/burn dressing|water-?jel|burn gel|burn sheet/i, 'Burn Care'],
  [/gauze|dressing|bandage|abd pad|kerlix|cling wrap|band-?aid|adhesive pad|wound closure|suture|steri-?strip|moleskin/i, 'Wound Care'],
  [/glove|nitrile|latex glove|face mask|surgical mask|n95|eye protection|goggles|safety glasses|apron|gown/i, 'PPE'],
  [/tylenol|acetaminophen|ibuprofen|advil|aspirin|benadryl|diphenhydramine|epi-?pen|epinephrine|naloxone|narcan|antibiotic ointment|neosporin|antihistamine|glucose|electrolyte tab|medication|pill|tablet/i, 'Medications'],
  [/emergency blanket|mylar|space blanket|hand warmer|hot pack|cold pack|ice pack|chemical light|glow stick|poncho/i, 'Environmental'],
  [/triage tag|notepad|pen\b|sharpie|marker|permit|documentation/i, 'Documentation'],
  [/water pouch|water bottle|energy bar|food bar|electrolyte|nutrition/i, 'Hydration & Nutrition'],
  [/shears|scissors|flashlight|headlamp|multitool|knife|tape\b|duct tape|carabiner|paracord|radio|whistle|stethoscope|penlight|thermometer|bp cuff|sphygmomanometer/i, 'Tools & Equipment'],
];

function inferCategory(name) {
  if (!name) return 'uncategorized';
  for (const [pattern, category] of CATEGORY_RULES) {
    if (pattern.test(name)) return category;
  }
  return 'uncategorized';
}

// Categories that are re-used equipment rather than stuff that gets used up.
// Everything else defaults to consumable.
const DURABLE_CATEGORIES = ['Splinting & Fractures', 'Tools & Equipment'];

function inferItemType(category) {
  return DURABLE_CATEGORIES.includes(category) ? 'durable' : 'consumable';
}

// Items that are almost always stored/counted by pack or box rather than
// individually — gloves, masks, gauze, swabs. If someone logs one of these
// without an explicit count (just "Nitrile Gloves", not "Nitrile Gloves x50"),
// we mark it as an estimate and don't threshold-alarm on it, since "1 pack"
// isn't a real quantity and shouldn't trip a false LOW badge.
const BULK_ESTIMATE_PATTERN = /glove|nitrile|latex glove|\bmask\b|n95|gauze|swab/i;

function isBulkEstimateCandidate(name) {
  return BULK_ESTIMATE_PATTERN.test(name || '');
}

const ALLOWED_CATEGORIES = [
  'Hemorrhage Control', 'Airway & Breathing', 'Splinting & Fractures', 'Burn Care',
  'Wound Care', 'PPE', 'Medications', 'Environmental', 'Documentation',
  'Hydration & Nutrition', 'Tools & Equipment',
];

const CLASSIFY_SYSTEM_PROMPT = `You classify items from a medical trauma kit into exactly one of these categories, based on what you know the item actually is: ${ALLOWED_CATEGORIES.join(', ')}. Use medical/EMS knowledge, not just keywords in the name — e.g. know that a brand name or abbreviation belongs to a category even if the words don't literally match it. If an item genuinely doesn't fit any category or you don't recognize it, use "uncategorized". Respond with ONLY a raw JSON object mapping each exact input item name to its category string. No markdown, no code fences, no other text.`;

function safeClassifyResults(parsed, names) {
  const safe = {};
  for (const name of names) {
    if (ALLOWED_CATEGORIES.includes(parsed[name])) safe[name] = parsed[name];
  }
  return safe;
}

async function classifyWithClaude(names) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: CLASSIFY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(names) }],
    }),
  });
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || '').join('');
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  return safeClassifyResults(parsed, names);
}

async function classifyWithGemini(names) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CLASSIFY_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(names) }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }
  );
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  return safeClassifyResults(parsed, names);
}

// For items the keyword rules can't place — brand names, abbreviations, or
// wording the CATEGORY_RULES regexes just don't cover — ask an AI model to
// classify using actual knowledge of what the item is, not string matching
// against the name. Tries Claude first (ANTHROPIC_API_KEY), then falls back
// to Gemini (GEMINI_API_KEY) if that's what you have set. If neither env
// var is set, this quietly returns no results and those items just stay
// uncategorized (same as before).
async function classifyWithAI(names) {
  if (!names.length) return {};
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const result = await classifyWithClaude(names);
      if (Object.keys(result).length) return result;
    } catch (err) {
      // fall through to Gemini if Claude call fails
    }
  }
  if (process.env.GEMINI_API_KEY) {
    try {
      return await classifyWithGemini(names);
    } catch (err) {
      return {};
    }
  }
  return {};
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  const body = event.body ? JSON.parse(event.body) : {};
  const qs = event.queryStringParameters || {};

  try {
    // GET /items?kit_id=... — items for one kit
    // GET /items?search=... — search across all kits
    // GET /items with no params — everything, across every kit (used by the
    // expiry dashboard)
    if (method === 'GET') {
      let query = supabase.from('items').select('*');

      if (qs.kit_id) query = query.eq('kit_id', qs.kit_id);
      if (qs.search) query = query.ilike('name', `%${qs.search}%`);
      if (qs.category) query = query.eq('category', qs.category);
      if (qs.status) query = query.eq('status', qs.status);
      if (qs.item_type) query = query.eq('item_type', qs.item_type);

      // Default order groups items by category, then alphabetically within
      // each category, so the list is organized without anyone having to
      // pick a sort option. The frontend's sort dropdown can still override
      // this per view.
      query = query.order('category', { ascending: true }).order('name', { ascending: true });

      const { data, error } = await query;
      if (error) throw error;

      // Look up kit names as a plain second query + JS map, rather than a
      // relational embed (select('*, kits(name)')). A manual join here is
      // more predictable across both the single-kit and "every kit at once"
      // views, and one bad/orphaned row can't take down the whole request.
      let kitNameById = {};
      if (data.length) {
        const kitIds = [...new Set(data.map((i) => i.kit_id).filter(Boolean))];
        if (kitIds.length) {
          const { data: kits, error: kitsErr } = await supabase.from('kits').select('id, name').in('id', kitIds);
          if (kitsErr) throw kitsErr;
          kitNameById = Object.fromEntries(kits.map((k) => [k.id, k.name]));
        }
      }

      // Recompute status live on every read (not just on write) so items don't
      // silently go stale — an item can cross into "expiring"/"expired" purely
      // by the calendar moving, with nobody having touched the record. Guarded
      // per-item so one malformed row (bad date, etc.) can't 500 the whole list.
      const withLiveStatus = data.map((item) => {
        let status = item.status;
        try {
          status = computeStatus(item.quantity, item.low_stock_threshold, item.expires_at);
        } catch (e) {
          // keep whatever status was already stored rather than failing the request
        }
        return { ...item, kits: { name: kitNameById[item.kit_id] || null }, status };
      });
      return respond(200, withLiveStatus);
    }

    // POST /items — add single item
    if (method === 'POST' && !body.action) {
      const trimmedName = (body.name || '').trim();

      // If an item with this name already exists in the kit, don't create a
      // duplicate row — add the new quantity onto the existing one.
      const { data: existingMatch, error: matchErr } = await supabase
        .from('items')
        .select('*')
        .eq('kit_id', body.kit_id)
        .ilike('name', trimmedName)
        .limit(1);
      if (matchErr) throw matchErr;

      if (existingMatch && existingMatch.length) {
        const match = existingMatch[0];
        const newQuantity = match.quantity + (body.quantity ?? 1);
        const { data, error } = await supabase
          .from('items')
          .update({
            quantity: newQuantity,
            status: computeStatus(newQuantity, match.low_stock_threshold, match.expires_at),
          })
          .eq('id', match.id)
          .select();
        if (error) throw error;
        return respond(200, { ...data[0], merged: true });
      }

      // Auto-categorize from the item name unless the caller explicitly set
      // a category — so manual entries keep whatever the person typed, but
      // items added without one get sorted automatically. If the keyword
      // rules can't place it, ask the AI classifier before falling back to
      // "uncategorized".
      let category = body.category && body.category.trim()
        ? body.category.trim()
        : inferCategory(trimmedName);
      if (category === 'uncategorized') {
        const aiResult = await classifyWithAI([trimmedName]);
        if (aiResult[trimmedName]) category = aiResult[trimmedName];
      }
      const item_type = body.item_type || inferItemType(category);
      // Only auto-flag as an estimate when the caller didn't specify a
      // quantity — if someone typed an actual number, trust it.
      const estimate_only = body.estimate_only ?? (body.quantity == null && isBulkEstimateCandidate(trimmedName));
      const quantity = body.quantity ?? 0;
      const low_stock_threshold = body.low_stock_threshold ?? (estimate_only ? 0 : 1);
      const { data, error } = await supabase
        .from('items')
        .insert({
          kit_id: body.kit_id,
          name: trimmedName,
          category,
          item_type,
          estimate_only,
          quantity,
          low_stock_threshold,
          expires_at: body.expires_at || null,
          status: computeStatus(quantity, low_stock_threshold, body.expires_at),
        })
        .select();
      if (error) throw error;
      return respond(200, data[0]);
    }

    // POST /items action=bulk_add — paste multiple lines
    if (method === 'POST' && body.action === 'bulk_add') {
      // body.lines = ["Gauze Pads 4x4 x10", "Tourniquet", ...]
      const parsedLines = body.lines.map((line) => parseLine(line)).filter((r) => r.name);
      if (!parsedLines.length) return respond(400, { error: 'No valid items parsed' });

      // Pull what's already in the kit once, so repeated pastes (or lines
      // that match something you already have) add onto the existing item
      // instead of creating duplicate rows.
      const { data: existingItems, error: existingErr } = await supabase
        .from('items')
        .select('*')
        .eq('kit_id', body.kit_id);
      if (existingErr) throw existingErr;
      const existingByName = new Map(existingItems.map((i) => [i.name.trim().toLowerCase(), i]));

      const toMerge = [];
      const needsAI = [];
      const newRows = [];

      for (const r of parsedLines) {
        const key = r.name.trim().toLowerCase();
        const existing = existingByName.get(key);
        if (existing) {
          toMerge.push({ existing, addQuantity: r.quantity });
          continue;
        }
        const category = inferCategory(r.name);
        // r.explicitQty is false when the line had no count ("Nitrile
        // Gloves") and parseLine defaulted it to 1. For bulk-packaged
        // consumables that's not a real count, so don't threshold-alarm.
        const estimate_only = !r.explicitQty && isBulkEstimateCandidate(r.name);
        const low_stock_threshold = estimate_only ? 0 : 1;
        const row = {
          kit_id: body.kit_id,
          name: r.name,
          quantity: r.quantity,
          category,
          item_type: inferItemType(category),
          estimate_only,
          low_stock_threshold,
        };
        if (category === 'uncategorized') needsAI.push(row);
        newRows.push(row);
      }

      // Classify everything the keyword rules missed in one batched call,
      // rather than waiting for a separate manual "AI Audit & Sort" pass.
      if (needsAI.length) {
        const aiResults = await classifyWithAI(needsAI.map((r) => r.name));
        for (const row of needsAI) {
          if (aiResults[row.name]) {
            row.category = aiResults[row.name];
            row.item_type = inferItemType(row.category);
          }
        }
      }
      newRows.forEach((row) => {
        row.status = computeStatus(row.quantity, row.low_stock_threshold, null);
      });

      let inserted = [];
      if (newRows.length) {
        const { data, error } = await supabase.from('items').insert(newRows).select();
        if (error) throw error;
        inserted = data;
      }

      const merged = [];
      for (const { existing, addQuantity } of toMerge) {
        const newQuantity = existing.quantity + addQuantity;
        const { data, error } = await supabase
          .from('items')
          .update({
            quantity: newQuantity,
            status: computeStatus(newQuantity, existing.low_stock_threshold, existing.expires_at),
          })
          .eq('id', existing.id)
          .select();
        if (error) throw error;
        merged.push(data[0]);
      }

      return respond(200, { inserted: inserted.length, merged: merged.length, items: [...inserted, ...merged] });
    }

    // POST /items action=csv_import — structured rows from an exported/edited CSV
    // body.rows = [{ name, quantity, category, item_type, low_stock_threshold,
    //                 expires_at, pack_size, lot_number, condition, estimate_only }, ...]
    if (method === 'POST' && body.action === 'csv_import') {
      const rows = (body.rows || []).filter((r) => r.name && r.name.trim());
      if (!rows.length) return respond(400, { error: 'No valid rows' });

      const { data: existingItems, error: existingErr } = await supabase
        .from('items')
        .select('*')
        .eq('kit_id', body.kit_id);
      if (existingErr) throw existingErr;
      const existingByName = new Map(existingItems.map((i) => [i.name.trim().toLowerCase(), i]));

      const toMerge = [];
      const needsAI = [];
      const newRows = [];

      for (const r of rows) {
        const name = r.name.trim();
        const key = name.toLowerCase();
        const quantity = parseInt(r.quantity, 10) || 0;
        const existing = existingByName.get(key);
        if (existing) {
          toMerge.push({ existing, addQuantity: quantity });
          continue;
        }
        let category = (r.category || '').trim();
        if (!category || (!ALLOWED_CATEGORIES.includes(category) && category !== 'uncategorized')) {
          category = inferCategory(name);
        }
        const estimate_only = r.estimate_only === 'true' || r.estimate_only === true
          || (!r.quantity && isBulkEstimateCandidate(name));
        const low_stock_threshold = r.low_stock_threshold !== undefined && r.low_stock_threshold !== ''
          ? parseInt(r.low_stock_threshold, 10)
          : (estimate_only ? 0 : 1);
        const row = {
          kit_id: body.kit_id,
          name,
          quantity,
          category,
          item_type: (r.item_type === 'durable' || r.item_type === 'consumable') ? r.item_type : inferItemType(category),
          estimate_only,
          low_stock_threshold,
          expires_at: r.expires_at || null,
          pack_size: r.pack_size || null,
          lot_number: r.lot_number || null,
          condition: r.condition || 'sealed',
        };
        if (category === 'uncategorized') needsAI.push(row);
        newRows.push(row);
      }

      if (needsAI.length) {
        const aiResults = await classifyWithAI(needsAI.map((r) => r.name));
        for (const row of needsAI) {
          if (aiResults[row.name]) {
            row.category = aiResults[row.name];
            row.item_type = inferItemType(row.category);
          }
        }
      }
      newRows.forEach((row) => {
        row.status = computeStatus(row.quantity, row.low_stock_threshold, row.expires_at);
      });

      let inserted = [];
      if (newRows.length) {
        const { data, error } = await supabase.from('items').insert(newRows).select();
        if (error) throw error;
        inserted = data;
      }

      const merged = [];
      for (const { existing, addQuantity } of toMerge) {
        const newQuantity = existing.quantity + addQuantity;
        const { data, error } = await supabase
          .from('items')
          .update({
            quantity: newQuantity,
            status: computeStatus(newQuantity, existing.low_stock_threshold, existing.expires_at),
          })
          .eq('id', existing.id)
          .select();
        if (error) throw error;
        merged.push(data[0]);
      }

      return respond(200, { inserted: inserted.length, merged: merged.length });
    }

    if (method === 'POST' && body.action === 'update') {
      const update = {};
      ['name', 'category', 'quantity', 'low_stock_threshold', 'expires_at', 'photo_url', 'pack_size', 'lot_number', 'condition', 'item_type', 'estimate_only'].forEach((f) => {
        if (body[f] !== undefined) update[f] = body[f];
      });
      // recompute status if relevant fields changed
      if ('quantity' in update || 'low_stock_threshold' in update || 'expires_at' in update) {
        const { data: current } = await supabase.from('items').select('*').eq('id', body.id).single();
        const qty = update.quantity ?? current.quantity;
        const thresh = update.low_stock_threshold ?? current.low_stock_threshold;
        const exp = update.expires_at ?? current.expires_at;
        update.status = computeStatus(qty, thresh, exp);
      }
      const { data, error } = await supabase.from('items').update(update).eq('id', body.id).select();
      if (error) throw error;
      return respond(200, data[0]);
    }

    // POST /items action=recategorize — backfill category on existing items
    // using the same keyword rules new items get automatically. Only touches
    // items with no category or 'uncategorized', so manual categories you've
    // already set are never overwritten. body.kit_id is optional; omit it to
    // recategorize across every kit.
    if (method === 'POST' && body.action === 'recategorize') {
      let query = supabase.from('items').select('id, name, category, item_type, quantity, low_stock_threshold, estimate_only');
      if (body.kit_id) query = query.eq('kit_id', body.kit_id);
      const { data: candidates, error: fetchErr } = await query;
      if (fetchErr) throw fetchErr;

      const needsCategory = candidates.filter(
        (i) => !i.category || i.category.trim() === '' || i.category === 'uncategorized'
      );

      let updated = 0;
      const stillUnknown = [];

      // Pass 1: fast keyword rules.
      for (const item of needsCategory) {
        const category = inferCategory(item.name);
        if (category === 'uncategorized') {
          stillUnknown.push(item);
          continue;
        }
        const { error: updateErr } = await supabase
          .from('items')
          .update({ category, item_type: item.item_type || inferItemType(category) })
          .eq('id', item.id);
        if (updateErr) throw updateErr;
        updated += 1;
      }

      // Pass 2: whatever the keyword rules couldn't place, ask the model —
      // it can recognize an item by what it actually is (brand names,
      // abbreviations, unusual phrasing) instead of matching text in the name.
      let aiClassified = 0;
      if (stillUnknown.length) {
        const aiResults = await classifyWithAI(stillUnknown.map((i) => i.name));
        for (const item of stillUnknown) {
          const category = aiResults[item.name];
          if (!category) continue;
          const { error: updateErr } = await supabase
            .from('items')
            .update({ category, item_type: item.item_type || inferItemType(category) })
            .eq('id', item.id);
          if (updateErr) throw updateErr;
          aiClassified += 1;
          updated += 1;
        }
      }

      const needsType = candidates.filter(
        (i) => !i.item_type && i.category && i.category !== 'uncategorized' && !needsCategory.some((c) => c.id === i.id)
      );
      for (const item of needsType) {
        const { error: updateErr } = await supabase
          .from('items')
          .update({ item_type: inferItemType(item.category) })
          .eq('id', item.id);
        if (updateErr) throw updateErr;
        updated += 1;
      }

      // Existing items logged as "1 pack" of something hard to count, still
      // sitting on the old default threshold of 1, so they read as LOW even
      // though nobody actually knows the real count.
      const needsEstimateFlag = candidates.filter(
        (i) => i.estimate_only == null && isBulkEstimateCandidate(i.name) && i.quantity <= (i.low_stock_threshold ?? 1)
      );
      let flaggedEstimates = 0;
      for (const item of needsEstimateFlag) {
        const { error: updateErr } = await supabase
          .from('items')
          .update({ estimate_only: true, low_stock_threshold: 0, status: 'ok' })
          .eq('id', item.id);
        if (updateErr) throw updateErr;
        flaggedEstimates += 1;
      }

      return respond(200, {
        checked: candidates.length,
        updated,
        aiClassified,
        stillUncategorized: stillUnknown.length - aiClassified,
        flaggedEstimates,
      });
    }

    if (method === 'POST' && body.action === 'duplicate_to_kit') {
      const { data: original, error: fetchErr } = await supabase
        .from('items')
        .select('*')
        .eq('id', body.id)
        .single();
      if (fetchErr) throw fetchErr;
      const { data, error } = await supabase
        .from('items')
        .insert({
          kit_id: body.target_kit_id,
          name: original.name,
          category: original.category,
          item_type: original.item_type,
          estimate_only: original.estimate_only,
          quantity: original.quantity,
          low_stock_threshold: original.low_stock_threshold,
          expires_at: original.expires_at,
          status: original.status,
        })
        .select();
      if (error) throw error;
      return respond(200, data[0]);
    }

    if (method === 'DELETE') {
      const { error } = await supabase.from('items').delete().eq('id', body.id);
      if (error) throw error;
      return respond(200, { success: true });
    }

    return respond(405, { error: 'Method not allowed' });
  } catch (err) {
    return respond(500, { error: err.message });
  }
};

function computeStatus(quantity, threshold, expiresAt) {
  if (expiresAt) {
    const days = (new Date(expiresAt) - new Date()) / 86400000;
    if (days < 0) return 'expired';
    if (days <= 30) return 'expiring';
  }
  if (quantity <= threshold) return 'low';
  return 'ok';
}

// Parses lines like "Gauze Pads 4x4 x10" or "Tourniquet, 3" or just "Tourniquet"
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return { name: '', quantity: 0, explicitQty: false };
  const xMatch = trimmed.match(/^(.*?)\s*[xX]\s*(\d+)$/);
  if (xMatch) return { name: xMatch[1].trim(), quantity: parseInt(xMatch[2], 10), explicitQty: true };
  const commaMatch = trimmed.match(/^(.*?),\s*(\d+)$/);
  if (commaMatch) return { name: commaMatch[1].trim(), quantity: parseInt(commaMatch[2], 10), explicitQty: true };
  return { name: trimmed, quantity: 1, explicitQty: false };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
