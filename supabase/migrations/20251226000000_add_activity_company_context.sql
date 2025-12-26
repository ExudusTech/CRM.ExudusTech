-- Add company + participants context to activities (market-standard CRM pattern)
-- - client_company_id: CRM client company this activity relates to
-- - participant_contact_ids: optional participants list (supports multi-contact meetings/calls)

ALTER TABLE public.activities
ADD COLUMN IF NOT EXISTS client_company_id UUID REFERENCES public.crm_companies(id),
ADD COLUMN IF NOT EXISTS participant_contact_ids UUID[];

-- Backfill company from deal or contact
UPDATE public.activities a
SET client_company_id = d.client_company_id
FROM public.deals d
WHERE a.client_company_id IS NULL
  AND a.deal_id IS NOT NULL
  AND d.id = a.deal_id
  AND d.client_company_id IS NOT NULL;

UPDATE public.activities a
SET client_company_id = c.client_company_id
FROM public.contacts c
WHERE a.client_company_id IS NULL
  AND a.contact_id IS NOT NULL
  AND c.id = a.contact_id;

-- Backfill participants: prefer explicit contact_id; fallback to deal.contact_id
UPDATE public.activities a
SET participant_contact_ids = ARRAY[a.contact_id]::UUID[]
WHERE a.participant_contact_ids IS NULL
  AND a.contact_id IS NOT NULL;

UPDATE public.activities a
SET participant_contact_ids = ARRAY[d.contact_id]::UUID[]
FROM public.deals d
WHERE a.participant_contact_ids IS NULL
  AND a.contact_id IS NULL
  AND a.deal_id IS NOT NULL
  AND d.id = a.deal_id
  AND d.contact_id IS NOT NULL;

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_activities_client_company_id ON public.activities (client_company_id);
CREATE INDEX IF NOT EXISTS idx_activities_participant_contact_ids ON public.activities USING GIN (participant_contact_ids);

