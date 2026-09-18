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

exports.handler = async (event) => {
  const method = event.httpMethod;
  const body = event.body ? JSON.parse(event.body) : {};
  const qs = event.queryStringParameters || {};

  try {
    // GET /items?kit_id=... — items for one kit
    // GET /items?search=... — search across all kits
    if (method === 'GET') {
      let query = supabase.from('items').select('*, kits(name)');

      if (qs.kit_id) query = query.eq('kit_id', qs.kit_id);
      if (qs.search) query = query.ilike('name', `%${qs.search}%`);
      if (qs.category) query = query.eq('category', qs.category);
      if (qs.status) query = query.eq('status', qs.status);

      // Default order groups items by category, then alphabetically within
      // each category, so the list is organized without anyone having to
      // pick a sort option. The frontend's sort dropdown can still override
      // this per view.
      query = query.order('category', { ascending: true }).order('name', { ascending: true });

      const { data, error } = await query;
      if (error) throw error;

      // Recompute status live on every read (not just on write) so items don't
      // silently go stale — an item can cross into "expiring"/"expired" purely
      // by the calendar moving, with nobody having touched the record.
      const withLiveStatus = data.map((item) => ({
        ...item,
        status: computeStatus(item.quantity, item.low_stock_threshold, item.expires_at),
      }));
      return respond(200, withLiveStatus);
    }

    // POST /items — add single item
    if (method === 'POST' && !body.action) {
      // Auto-categorize from the item name unless the caller explicitly set
      // a category — so manual entries keep whatever the person typed, but
      // items added without one get sorted automatically.
      const category = body.category && body.category.trim()
        ? body.category.trim()
        : inferCategory(body.name);
      const { data, error } = await supabase
        .from('items')
        .insert({
          kit_id: body.kit_id,
          name: body.name,
          category,
          quantity: body.quantity ?? 0,
          low_stock_threshold: body.low_stock_threshold ?? 1,
          expires_at: body.expires_at || null,
          status: computeStatus(body.quantity ?? 0, body.low_stock_threshold ?? 1, body.expires_at),
        })
        .select();
      if (error) throw error;
      return respond(200, data[0]);
    }

    // POST /items action=bulk_add — paste multiple lines
    if (method === 'POST' && body.action === 'bulk_add') {
      // body.lines = ["Gauze Pads 4x4 x10", "Tourniquet", ...]
      const rows = body.lines
        .map((line) => parseLine(line))
        .filter((r) => r.name)
        .map((r) => ({
          kit_id: body.kit_id,
          name: r.name,
          quantity: r.quantity,
          category: inferCategory(r.name),
          low_stock_threshold: 1,
          status: computeStatus(r.quantity, 1, null),
        }));
      if (rows.length === 0) return respond(400, { error: 'No valid items parsed' });
      const { data, error } = await supabase.from('items').insert(rows).select();
      if (error) throw error;
      return respond(200, data);
    }

    if (method === 'POST' && body.action === 'update') {
      const update = {};
      ['name', 'category', 'quantity', 'low_stock_threshold', 'expires_at', 'photo_url', 'pack_size', 'lot_number', 'condition'].forEach((f) => {
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
      let query = supabase.from('items').select('id, name, category');
      if (body.kit_id) query = query.eq('kit_id', body.kit_id);
      const { data: candidates, error: fetchErr } = await query;
      if (fetchErr) throw fetchErr;

      const toUpdate = candidates.filter(
        (i) => !i.category || i.category.trim() === '' || i.category === 'uncategorized'
      );

      let updated = 0;
      for (const item of toUpdate) {
        const category = inferCategory(item.name);
        if (category === 'uncategorized') continue; // nothing better to assign
        const { error: updateErr } = await supabase
          .from('items')
          .update({ category })
          .eq('id', item.id);
        if (updateErr) throw updateErr;
        updated += 1;
      }

      return respond(200, { checked: toUpdate.length, updated });
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
  if (!trimmed) return { name: '', quantity: 0 };
  const xMatch = trimmed.match(/^(.*?)\s*[xX]\s*(\d+)$/);
  if (xMatch) return { name: xMatch[1].trim(), quantity: parseInt(xMatch[2], 10) };
  const commaMatch = trimmed.match(/^(.*?),\s*(\d+)$/);
  if (commaMatch) return { name: commaMatch[1].trim(), quantity: parseInt(commaMatch[2], 10) };
  return { name: trimmed, quantity: 1 };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
