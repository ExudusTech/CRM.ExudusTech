import { z } from 'zod';
import { isAllowedOrigin } from '@/lib/security/sameOrigin';
import { createSupabaseProject, listAllSupabaseOrganizationProjects, listSupabaseProjects } from '@/lib/installer/edgeFunctions';

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const Schema = z
  .object({
    installerToken: z.string().optional(),
    accessToken: z.string().min(1),
    organizationSlug: z.string().min(1),
    name: z.string().min(2).max(64),
    dbPass: z.string().min(12),
    regionSmartGroup: z.enum(['americas', 'emea', 'apac']).optional(),
  })
  .strict();

export async function POST(req: Request) {
  if (!isAllowedOrigin(req)) return json({ error: 'Forbidden' }, 403);

  if (process.env.INSTALLER_ENABLED === 'false') {
    return json({ error: 'Installer disabled' }, 403);
  }

  const raw = await req.json().catch(() => null);
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'Invalid payload', details: parsed.error.flatten() }, 400);
  }

  const expectedToken = process.env.INSTALLER_TOKEN;
  if (expectedToken && parsed.data.installerToken !== expectedToken) {
    return json({ error: 'Invalid installer token' }, 403);
  }

  const created = await createSupabaseProject({
    accessToken: parsed.data.accessToken.trim(),
    organizationSlug: parsed.data.organizationSlug.trim(),
    name: parsed.data.name.trim(),
    dbPass: parsed.data.dbPass,
    regionSmartGroup: parsed.data.regionSmartGroup,
  });

  if (!created.ok) {
    // Never reuse existing projects — always fail if name conflicts.
    // Rationale: existing projects may have stale data/schema from previous deployments.
    return json({ error: created.error, status: created.status, details: created.response }, created.status || 500);
  }

  return json({
    ok: true,
    projectRef: created.projectRef,
    projectName: created.projectName,
    supabaseUrl: `https://${created.projectRef}.supabase.co`,
  });
}

