// netlify/functions/kits.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const method = event.httpMethod;
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    // GET /kits — list all kits, each annotated with a live readiness score
    if (method === 'GET') {
      const { data, error } = await supabase
        .from('kits')
        .select('*')
        .order('sort_order', { ascending: true });
      if (error) throw error;

      const { data: readiness, error: readinessErr } = await supabase
        .from('kit_readiness')
        .select('*');
      if (readinessErr) throw readinessErr;

      const readinessByKit = Object.fromEntries(readiness.map((r) => [r.kit_id, r]));
      const withReadiness = data.map((k) => ({
        ...k,
        readiness_pct: readinessByKit[k.id]?.readiness_pct ?? 100,
        flagged_items: readinessByKit[k.id]?.flagged_items ?? 0,
        total_items: readinessByKit[k.id]?.total_items ?? 0,
      }));
      return respond(200, withReadiness);
    }

    // POST /kits — create a new kit
    if (method === 'POST' && !body.action) {
      const { data, error } = await supabase
        .from('kits')
        .insert({ name: body.name, notes: body.notes || '' })
        .select();
      if (error) throw error;
      return respond(200, data[0]);
    }

    // PATCH-style actions via POST with an "action" field
    if (method === 'POST' && body.action === 'rename') {
      const { data, error } = await supabase
        .from('kits')
        .update({ name: body.name })
        .eq('id', body.id)
        .select();
      if (error) throw error;
      return respond(200, data[0]);
    }

    if (method === 'POST' && body.action === 'update_notes') {
      const { data, error } = await supabase
        .from('kits')
        .update({ notes: body.notes })
        .eq('id', body.id)
        .select();
      if (error) throw error;
      return respond(200, data[0]);
    }

    if (method === 'POST' && body.action === 'mark_checked') {
      const { data, error } = await supabase
        .from('kits')
        .update({ last_checked_at: new Date().toISOString() })
        .eq('id', body.id)
        .select();
      if (error) throw error;
      return respond(200, data[0]);
    }

    if (method === 'POST' && body.action === 'update_photo') {
      const { data, error } = await supabase
        .from('kits')
        .update({ photo_url: body.photo_url })
        .eq('id', body.id)
        .select();
      if (error) throw error;
      return respond(200, data[0]);
    }

    if (method === 'POST' && body.action === 'duplicate') {
      // 1. Fetch original kit
      const { data: original, error: fetchErr } = await supabase
        .from('kits')
        .select('*')
        .eq('id', body.id)
        .single();
      if (fetchErr) throw fetchErr;

      // 2. Create the new kit
      const { data: newKit, error: kitErr } = await supabase
        .from('kits')
        .insert({
          name: body.newName || `${original.name} (copy)`,
          notes: original.notes,
        })
        .select();
      if (kitErr) throw kitErr;

      // 3. Copy all items from original kit into new kit
      const { data: items, error: itemsErr } = await supabase
        .from('items')
        .select('*')
        .eq('kit_id', body.id);
      if (itemsErr) throw itemsErr;

      if (items.length > 0) {
        const copies = items.map((item) => ({
          kit_id: newKit[0].id,
          name: item.name,
          category: item.category,
          item_type: item.item_type,
          estimate_only: item.estimate_only,
          quantity: item.quantity,
          low_stock_threshold: item.low_stock_threshold,
          expires_at: item.expires_at,
          status: item.status,
        }));
        const { error: insertErr } = await supabase.from('items').insert(copies);
        if (insertErr) throw insertErr;
      }

      return respond(200, newKit[0]);
    }

    if (method === 'POST' && body.action === 'reorder') {
      // body.order = [{id, sort_order}, ...]
      const updates = body.order.map(({ id, sort_order }) =>
        supabase.from('kits').update({ sort_order }).eq('id', id)
      );
      await Promise.all(updates);
      return respond(200, { success: true });
    }

    if (method === 'DELETE') {
      const { error } = await supabase.from('kits').delete().eq('id', body.id);
      if (error) throw error;
      return respond(200, { success: true });
    }

    return respond(405, { error: 'Method not allowed' });
  } catch (err) {
    return respond(500, { error: err.message });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
