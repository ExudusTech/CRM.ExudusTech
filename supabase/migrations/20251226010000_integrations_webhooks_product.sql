-- =============================================================================
-- Webhooks "100% produto" (MVP) - Entrada de Leads + Saída (mudança de estágio)
-- =============================================================================
-- Data: 26/12/2025
-- Objetivo:
-- - Permitir que admins configurem, via UI, uma fonte de entrada (Board + Estágio)
--   e recebam leads via Edge Function.
-- - Permitir configurar um endpoint de saída que é acionado quando um deal muda de estágio.
--
-- Observação (MVP):
-- - Saída usa pg_net (async) e registra request_id; status final pode ser inspecionado via net._http_response.
-- - Retries/backoff automáticos não fazem parte deste MVP.

-- 1) Extensão pg_net (Database Webhooks / HTTP async)
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2) Tabelas de configuração (admin-only)
CREATE TABLE IF NOT EXISTS public.integration_inbound_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Entrada de Leads',
  entry_board_id UUID NOT NULL REFERENCES public.boards(id),
  entry_stage_id UUID NOT NULL REFERENCES public.board_stages(id),
  secret TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.integration_inbound_sources ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.integration_outbound_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Follow-up (Webhook)',
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT[] NOT NULL DEFAULT ARRAY['deal.stage_changed'],
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.integration_outbound_endpoints ENABLE ROW LEVEL SECURITY;

-- 3) Auditoria mínima
CREATE TABLE IF NOT EXISTS public.webhook_events_in (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.integration_inbound_sources(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'generic',
  external_event_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  created_contact_id UUID REFERENCES public.contacts(id),
  created_deal_id UUID REFERENCES public.deals(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.webhook_events_in ENABLE ROW LEVEL SECURITY;

-- Dedupe inbound quando existir external_event_id
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_in_dedupe
  ON public.webhook_events_in(source_id, external_event_id)
  WHERE external_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.webhook_events_out (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  deal_id UUID REFERENCES public.deals(id),
  from_stage_id UUID REFERENCES public.board_stages(id),
  to_stage_id UUID REFERENCES public.board_stages(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.webhook_events_out ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES public.integration_outbound_endpoints(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.webhook_events_out(id) ON DELETE CASCADE,
  request_id BIGINT, -- net.http_post request id
  status TEXT NOT NULL DEFAULT 'queued', -- queued | delivered | failed (MVP: queued)
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  response_status INT,
  error TEXT
);

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- 4) Policies (admin-only, seguindo padrão existente de organization_settings)
DROP POLICY IF EXISTS "Admins can manage inbound sources" ON public.integration_inbound_sources;
CREATE POLICY "Admins can manage inbound sources"
  ON public.integration_inbound_sources
  FOR ALL
  TO authenticated
  USING (
    auth.uid() IN (
      SELECT id FROM public.profiles
      WHERE organization_id = integration_inbound_sources.organization_id
        AND role = 'admin'
    )
  )
  WITH CHECK (
    auth.uid() IN (
      SELECT id FROM public.profiles
      WHERE organization_id = integration_inbound_sources.organization_id
        AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can manage outbound endpoints" ON public.integration_outbound_endpoints;
CREATE POLICY "Admins can manage outbound endpoints"
  ON public.integration_outbound_endpoints
  FOR ALL
  TO authenticated
  USING (
    auth.uid() IN (
      SELECT id FROM public.profiles
      WHERE organization_id = integration_outbound_endpoints.organization_id
        AND role = 'admin'
    )
  )
  WITH CHECK (
    auth.uid() IN (
      SELECT id FROM public.profiles
      WHERE organization_id = integration_outbound_endpoints.organization_id
        AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can view inbound webhook events" ON public.webhook_events_in;
CREATE POLICY "Admins can view inbound webhook events"
  ON public.webhook_events_in
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() IN (
      SELECT id FROM public.profiles
      WHERE organization_id = webhook_events_in.organization_id
        AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can view outbound webhook events" ON public.webhook_events_out;
CREATE POLICY "Admins can view outbound webhook events"
  ON public.webhook_events_out
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() IN (
      SELECT id FROM public.profiles
      WHERE organization_id = webhook_events_out.organization_id
        AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can view deliveries" ON public.webhook_deliveries;
CREATE POLICY "Admins can view deliveries"
  ON public.webhook_deliveries
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() IN (
      SELECT id FROM public.profiles
      WHERE organization_id = webhook_deliveries.organization_id
        AND role = 'admin'
    )
  );

-- 5) Trigger: deal mudou de estágio -> dispara webhook outbound (MVP)
CREATE OR REPLACE FUNCTION public.notify_deal_stage_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  endpoint RECORD;
  board_name TEXT;
  from_label TEXT;
  to_label TEXT;
  contact_name TEXT;
  contact_phone TEXT;
  contact_email TEXT;
  payload JSONB;
  event_id UUID;
  delivery_id UUID;
  req_id BIGINT;
BEGIN
  IF (TG_OP <> 'UPDATE') THEN
    RETURN NEW;
  END IF;

  IF NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id THEN
    RETURN NEW;
  END IF;

  -- Enriquecimento básico para payload humano
  SELECT b.name INTO board_name FROM public.boards b WHERE b.id = NEW.board_id;
  SELECT bs.label INTO to_label FROM public.board_stages bs WHERE bs.id = NEW.stage_id;
  SELECT bs.label INTO from_label FROM public.board_stages bs WHERE bs.id = OLD.stage_id;

  IF NEW.contact_id IS NOT NULL THEN
    SELECT c.name, c.phone, c.email
      INTO contact_name, contact_phone, contact_email
    FROM public.contacts c
    WHERE c.id = NEW.contact_id;
  END IF;

  FOR endpoint IN
    SELECT * FROM public.integration_outbound_endpoints e
    WHERE e.organization_id = NEW.organization_id
      AND e.active = true
      AND 'deal.stage_changed' = ANY(e.events)
  LOOP
    payload := jsonb_build_object(
      'event_type', 'deal.stage_changed',
      'occurred_at', now(),
      'deal', jsonb_build_object(
        'id', NEW.id,
        'title', NEW.title,
        'value', NEW.value,
        'board_id', NEW.board_id,
        'board_name', board_name,
        'from_stage_id', OLD.stage_id,
        'from_stage_label', from_label,
        'to_stage_id', NEW.stage_id,
        'to_stage_label', to_label,
        'contact_id', NEW.contact_id
      ),
      'contact', jsonb_build_object(
        'name', contact_name,
        'phone', contact_phone,
        'email', contact_email
      )
    );

    INSERT INTO public.webhook_events_out (organization_id, event_type, payload, deal_id, from_stage_id, to_stage_id)
    VALUES (NEW.organization_id, 'deal.stage_changed', payload, NEW.id, OLD.stage_id, NEW.stage_id)
    RETURNING id INTO event_id;

    INSERT INTO public.webhook_deliveries (organization_id, endpoint_id, event_id, status)
    VALUES (NEW.organization_id, endpoint.id, event_id, 'queued')
    RETURNING id INTO delivery_id;

    -- Dispara HTTP async (MVP): registra request_id (sucesso/falha final pode ser inspecionado em net._http_response)
    BEGIN
      SELECT net.http_post(
        url := endpoint.url,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'X-Webhook-Secret', endpoint.secret
        ),
        body := payload
      ) INTO req_id;

      UPDATE public.webhook_deliveries
        SET request_id = req_id
      WHERE id = delivery_id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.webhook_deliveries
        SET status = 'failed',
            error = SQLERRM
      WHERE id = delivery_id;
    END;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_deal_stage_changed ON public.deals;
CREATE TRIGGER trg_notify_deal_stage_changed
AFTER UPDATE ON public.deals
FOR EACH ROW
EXECUTE FUNCTION public.notify_deal_stage_changed();

