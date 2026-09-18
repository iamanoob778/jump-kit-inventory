// netlify/functions/checks.js
// Logs a kit inspection: who checked it, when, notes, and a snapshot of item
// status at that moment — so you have an audit trail, not just a single
// "last checked" timestamp that tells you nothing about *what* was checked.
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const method = event.httpMethod;
  const body = event.body ? JSON.parse(event.body) : {};
  const qs = event.queryStringParameters || {};

  try {
    // GET /checks?kit_id=... — history of checks for one kit, newest first
    if (method === 'GET') {
      if (!qs.kit_id) return respond(400, { error: 'kit_id required' });
      const { data, error } = await supabase
        .from('kit_checks')
        .select('*')
        .eq('kit_id', qs.kit_id)
        .order('checked_at', { ascending: false })
        .limit(qs.limit ? parseInt(qs.limit, 10) : 20);
      if (error) throw error;
      return respond(200, data);
    }

    // POST /checks — log a new inspection for a kit
    // body: { kit_id, checked_by, notes }
    if (method === 'POST') {
      if (!body.kit_id) return respond(400, { error: 'kit_id required' });

      const { data: items, error: itemsErr } = await supabase
        .from('items')
        .select('*')
        .eq('kit_id', body.kit_id);
      if (itemsErr) throw itemsErr;

      const liveItems = items.map((i) => ({
        ...i,
        status: computeStatus(i.quantity, i.low_stock_threshold, i.expires_at),
      }));
      const itemsOk = liveItems.filter((i) => i.status === 'ok').length;
      const itemsFlagged = liveItems.length - itemsOk;

      const { data: check, error: checkErr } = await supabase
        .from('kit_checks')
        .insert({
          kit_id: body.kit_id,
          checked_by: body.checked_by || '',
          notes: body.notes || '',
          items_ok: itemsOk,
          items_flagged: itemsFlagged,
          snapshot: liveItems,
        })
        .select();
      if (checkErr) throw checkErr;

      const { error: kitErr } = await supabase
        .from('kits')
        .update({ last_checked_at: new Date().toISOString() })
        .eq('id', body.kit_id);
      if (kitErr) throw kitErr;

      return respond(200, check[0]);
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

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
