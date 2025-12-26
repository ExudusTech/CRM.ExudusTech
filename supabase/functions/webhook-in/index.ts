/**
 * Webhook de entrada de leads (100% produto).
 *
 * Endpoint público para receber leads de Hotmart/forms/n8n/Make e criar:
 * - Contato (upsert por email/telefone)
 * - Deal (no board + estágio configurados na fonte)
 *
 * Rota (Supabase Edge Functions):
 * - `POST /functions/v1/webhook-in/<source_id>`
 *
 * Autenticação:
 * - Header `X-Webhook-Secret` deve bater com o `secret` da fonte em `integration_inbound_sources`.
 *
 * Observação:
 * - Este handler usa `SUPABASE_SERVICE_ROLE_KEY` (segredo padrão do Supabase) e ignora RLS.
 */
import { createClient } from "npm:@supabase/supabase-js@2";

type LeadPayload = {
  external_event_id?: string;
  name?: string;
  email?: string;
  phone?: string;
  source?: string;
  notes?: string;
  company_name?: string;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getSourceIdFromPath(req: Request): string | null {
  const url = new URL(req.url);
  // pathname esperado: /functions/v1/webhook-in/<source_id>
  const parts = url.pathname.split("/").filter(Boolean);
  const idx = parts.findIndex((p) => p === "webhook-in");
  if (idx === -1) return null;
  return parts[idx + 1] ?? null;
}

function normalizePhone(phone?: string) {
  if (!phone) return null;
  const cleaned = phone.trim();
  return cleaned || null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Método não permitido" });

  const sourceId = getSourceIdFromPath(req);
  if (!sourceId) return json(404, { error: "source_id ausente na URL" });

  const secretHeader = req.headers.get("X-Webhook-Secret") || "";
  if (!secretHeader) return json(401, { error: "Secret ausente" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json(500, { error: "Supabase não configurado no runtime" });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: source, error: sourceErr } = await supabase
    .from("integration_inbound_sources")
    .select("id, organization_id, entry_board_id, entry_stage_id, secret, active")
    .eq("id", sourceId)
    .maybeSingle();

  if (sourceErr) return json(500, { error: "Erro ao buscar fonte", details: sourceErr.message });
  if (!source || !source.active) return json(404, { error: "Fonte não encontrada/inativa" });
  if (String(source.secret) !== String(secretHeader)) return json(401, { error: "Secret inválido" });

  let payload: LeadPayload;
  try {
    payload = (await req.json()) as LeadPayload;
  } catch {
    return json(400, { error: "JSON inválido" });
  }

  const leadName = payload.name?.trim() || null;
  const leadEmail = payload.email?.trim()?.toLowerCase() || null;
  const leadPhone = normalizePhone(payload.phone || undefined);
  const externalEventId = payload.external_event_id?.trim() || null;

  // 1) Auditoria/dedupe (idempotente quando external_event_id existe)
  if (externalEventId) {
    const { error: insertEventErr } = await supabase
      .from("webhook_events_in")
      .insert({
        organization_id: source.organization_id,
        source_id: source.id,
        provider: payload.source || "generic",
        external_event_id: externalEventId,
        payload: payload as unknown as Record<string, unknown>,
        status: "received",
      });

    // Unique violation (dedupe) -> OK idempotente
    if (insertEventErr && !String(insertEventErr.message).toLowerCase().includes("duplicate")) {
      return json(500, { error: "Falha ao registrar evento", details: insertEventErr.message });
    }
  }

  // 2) Upsert de contato (por email e/ou telefone)
  let contactId: string | null = null;
  if (leadEmail || leadPhone) {
    const filters: string[] = [];
    if (leadEmail) filters.push(`email.eq.${leadEmail}`);
    if (leadPhone) filters.push(`phone.eq.${leadPhone}`);

    const { data: existingContacts, error: findErr } = await supabase
      .from("contacts")
      .select("id, name, email, phone, organization_id")
      .eq("organization_id", source.organization_id)
      .or(filters.join(","))
      .limit(1);

    if (findErr) return json(500, { error: "Falha ao buscar contato", details: findErr.message });

    if (existingContacts && existingContacts.length > 0) {
      const existing = existingContacts[0];
      contactId = existing.id;

      const updates: Record<string, unknown> = {};
      if (leadName && (!existing.name || existing.name === "Sem nome")) updates.name = leadName;
      if (leadEmail && !existing.email) updates.email = leadEmail;
      if (leadPhone && !existing.phone) updates.phone = leadPhone;
      if (payload.company_name) updates.company_name = payload.company_name;
      if (payload.notes) updates.notes = payload.notes;
      if (payload.source) updates.source = payload.source;

      if (Object.keys(updates).length > 0) {
        const { error: updErr } = await supabase
          .from("contacts")
          .update(updates)
          .eq("id", contactId);
        if (updErr) return json(500, { error: "Falha ao atualizar contato", details: updErr.message });
      }
    } else {
      const { data: created, error: createErr } = await supabase
        .from("contacts")
        .insert({
          organization_id: source.organization_id,
          name: leadName || leadEmail || leadPhone || "Lead",
          email: leadEmail,
          phone: leadPhone,
          source: payload.source || "webhook",
          company_name: payload.company_name || null,
          notes: payload.notes || null,
        })
        .select("id")
        .single();

      if (createErr) return json(500, { error: "Falha ao criar contato", details: createErr.message });
      contactId = created?.id ?? null;
    }
  }

  // 3) Criar deal no board/estágio de entrada
  const dealTitle = leadName || leadEmail || leadPhone || "Novo Lead";
  const { data: createdDeal, error: dealErr } = await supabase
    .from("deals")
    .insert({
      organization_id: source.organization_id,
      title: dealTitle,
      value: 0,
      probability: 0,
      priority: "medium",
      board_id: source.entry_board_id,
      stage_id: source.entry_stage_id,
      contact_id: contactId,
      last_stage_change_date: new Date().toISOString(),
      tags: [],
      custom_fields: {
        inbound_source_id: source.id,
        inbound_external_event_id: externalEventId,
      },
    })
    .select("id")
    .single();

  if (dealErr) return json(500, { error: "Falha ao criar deal", details: dealErr.message });

  // Atualiza auditoria (best-effort)
  if (externalEventId) {
    await supabase
      .from("webhook_events_in")
      .update({
        status: "processed",
        created_contact_id: contactId,
        created_deal_id: createdDeal?.id ?? null,
      })
      .eq("source_id", source.id)
      .eq("external_event_id", externalEventId);
  }

  return json(200, {
    ok: true,
    organization_id: source.organization_id,
    contact_id: contactId,
    deal_id: createdDeal?.id,
  });
});

