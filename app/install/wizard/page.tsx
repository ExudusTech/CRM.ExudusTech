'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2, ExternalLink, Sparkles, Pause, Info } from 'lucide-react';
import { AnimatePresence, motion, useMotionValue, useSpring } from 'framer-motion';

// Types
type InstallerMeta = { enabled: boolean; requiresToken: boolean };
type ProjectInfo = { id: string; name: string; teamId?: string; url?: string };
type SupabaseProjectOption = {
  ref: string;
  name: string;
  region?: string;
  status?: string;
  supabaseUrl: string;
  organizationSlug?: string;
};
type SupabaseOrgOption = { slug: string; name: string; id?: string; plan?: string };
type Step = { id: string; status: 'ok' | 'error' | 'warning' | 'running'; message?: string };
type FunctionResult =
  | { slug: string; ok: true; response: unknown }
  | { slug: string; ok: false; error: string; status?: number; response?: unknown };
type RunResult = { ok: boolean; steps: Step[]; functions?: FunctionResult[]; error?: string };

type PreflightOrg = {
  slug: string;
  name: string;
  plan?: string;
  activeCount: number;
  activeProjects: SupabaseProjectOption[];
};

// Constants & Helpers
const STORAGE_TOKEN = 'crm_install_token';
const STORAGE_PROJECT = 'crm_install_project';
const STORAGE_INSTALLER_TOKEN = 'crm_install_installer_token';

function generateStrongPassword(length = 20) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*_-+=';
  const bytes = new Uint8Array(Math.max(12, Math.min(64, length)));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function suggestProjectName(existingNames: string[]) {
  const base = 'nossocrm';
  const lower = new Set(existingNames.map((n) => (n || '').toLowerCase().trim()).filter(Boolean));
  if (!lower.has(base)) return base;
  for (let i = 2; i < 50; i++) {
    const candidate = `${base}-${i}`;
    if (!lower.has(candidate)) return candidate;
  }
  return `${base}-${Math.floor(Date.now() / 1000)}`;
}

function humanizeError(message: string) {
  const lower = String(message || '').toLowerCase();
  if (lower.includes('maximum limits') || lower.includes('2 project limit') || lower.includes('limit of 2 active projects')) {
    return 'Limite do plano Free atingido. Pause um projeto existente para continuar.';
  }
  return message;
}

function buildDbUrl(projectRef: string, dbPassword: string) {
  const host = `db.${projectRef}.supabase.co`;
  return `postgresql://postgres:${encodeURIComponent(dbPassword)}@${host}:6543/postgres?sslmode=require&pgbouncer=true`;
}

function inferProjectRef(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const m = host.match(/^([a-z0-9-]+)\.supabase\.(co|in)$/i);
    return m?.[1] || null;
    } catch {
      return null;
    }
}

export default function InstallWizardPage() {
  const router = useRouter();
  
  // Meta & Hydration
  const [meta, setMeta] = useState<InstallerMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  
  // Vercel
  const [installerToken, setInstallerToken] = useState('');
  const [vercelToken, setVercelToken] = useState('');
  const [project, setProject] = useState<ProjectInfo | null>(null);

  // Supabase
  const [supabaseAccessToken, setSupabaseAccessToken] = useState('');
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseAnonKey, setSupabaseAnonKey] = useState('');
  const [supabaseServiceKey, setSupabaseServiceKey] = useState('');
  const [supabaseDbUrl, setSupabaseDbUrl] = useState('');
  const [supabaseProjectRef, setSupabaseProjectRef] = useState('');
  const [supabaseDeployEdgeFunctions] = useState(true);
  const [supabaseCreateDbPass, setSupabaseCreateDbPass] = useState('');
  
  // Supabase UI state
  const [supabaseOrgs, setSupabaseOrgs] = useState<SupabaseOrgOption[]>([]);
  const [supabaseOrgsLoading, setSupabaseOrgsLoading] = useState(false);
  const [supabaseOrgsError, setSupabaseOrgsError] = useState<string | null>(null);
  const [supabaseCreating, setSupabaseCreating] = useState(false);
  const [supabaseCreateError, setSupabaseCreateError] = useState<string | null>(null);
  const [supabaseProvisioning, setSupabaseProvisioning] = useState(false);
  const [supabaseProvisioningStatus, setSupabaseProvisioningStatus] = useState<string | null>(null);
  const [supabaseResolving, setSupabaseResolving] = useState(false);
  const [supabaseResolveError, setSupabaseResolveError] = useState<string | null>(null);
  const [supabaseResolvedOk, setSupabaseResolvedOk] = useState(false);
  const [supabasePausingRef, setSupabasePausingRef] = useState<string | null>(null);
  
  // Preflight
  const [supabasePreflight, setSupabasePreflight] = useState<{
    freeGlobalLimitHit: boolean;
    suggestedOrganizationSlug: string | null;
    organizations: PreflightOrg[];
  } | null>(null);
  const [supabasePreflightLoading, setSupabasePreflightLoading] = useState(false);
  
  // Timers
  const provisioningTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const provisioningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveAttemptsRef = useRef(0);
  
  // Admin
  const [companyName, setCompanyName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmTouched, setConfirmTouched] = useState(false);
  
  // Wizard - começa no passo 1 (Supabase), pois Vercel já foi validada no /install/start
  const [currentStep, setCurrentStep] = useState(1);
  const [supabaseUiStep, setSupabaseUiStep] = useState<'pat' | 'deciding' | 'needspace' | 'creating' | 'done'>('pat');
  
  // Install
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [showInstallOverlay, setShowInstallOverlay] = useState(false);
  const [cinePhase, setCinePhase] = useState<'preparing' | 'running' | 'success' | 'error'>('preparing');
  const [cineMessage, setCineMessage] = useState('Preparando a decolagem…');
  const [cineSubtitle, setCineSubtitle] = useState('');
  const [cineProgress, setCineProgress] = useState(0);
  
  // Parallax
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const mxSpring = useSpring(mx, { stiffness: 120, damping: 30, mass: 0.6 });
  const mySpring = useSpring(my, { stiffness: 120, damping: 30, mass: 0.6 });

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    mx.set(((e.clientX - rect.left) / rect.width - 0.5) * 14);
    my.set(((e.clientY - rect.top) / rect.height - 0.5) * 10);
  };

  const sceneVariants = {
    initial: { opacity: 0, y: 20, filter: 'blur(8px)' },
    animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
    exit: { opacity: 0, y: -10, filter: 'blur(6px)' },
  };
  const sceneTransition = { type: 'tween', ease: [0.22, 1, 0.36, 1], duration: 0.4 };
  
  // Derived state
  const passwordValid = adminPassword.length >= 6;
  const passwordsMatch = adminPassword === confirmPassword;
  const vercelReady = Boolean(vercelToken.trim() && project?.id);
  const supabaseReady = Boolean(supabaseUrl.trim() && supabaseResolvedOk && !supabaseProvisioning);
  const adminReady = Boolean(companyName.trim() && adminEmail.trim() && passwordValid && passwordsMatch);
  const canInstall = Boolean(meta?.enabled && vercelReady && supabaseReady && adminReady);
  
  const allFreeActiveProjects = useMemo(() => {
    const orgs = supabasePreflight?.organizations || [];
    const all: (SupabaseProjectOption & { orgName: string })[] = [];
    for (const o of orgs) {
      if ((o.plan || '').toLowerCase() !== 'free') continue;
      for (const p of o.activeProjects || []) {
        all.push({ ...p, orgName: o.name });
      }
    }
    return all;
  }, [supabasePreflight]);
  
  // Effects
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/installer/meta');
        const data = await res.json();
        if (!cancelled) setMeta(data);
      } catch (err) {
        if (!cancelled) setMetaError(err instanceof Error ? err.message : 'Erro ao carregar');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const savedToken = localStorage.getItem(STORAGE_TOKEN);
    const savedProject = localStorage.getItem(STORAGE_PROJECT);
    const savedInstallerToken = localStorage.getItem(STORAGE_INSTALLER_TOKEN);

    if (!savedToken || !savedProject) {
      router.replace('/install/start');
      return;
    }

    try {
      setVercelToken(savedToken);
      setProject(JSON.parse(savedProject));
      if (savedInstallerToken) setInstallerToken(savedInstallerToken);
      setIsHydrated(true);
    } catch {
      router.replace('/install/start');
    }
  }, [router]);

  useEffect(() => {
    if (installerToken.trim()) localStorage.setItem(STORAGE_INSTALLER_TOKEN, installerToken.trim());
  }, [installerToken]);

  useEffect(() => {
    if (!supabaseCreateDbPass) setSupabaseCreateDbPass(generateStrongPassword(20));
  }, [supabaseCreateDbPass]);

  useEffect(() => {
    setSupabaseOrgs([]);
    setSupabaseOrgsError(null);
    setSupabaseUrl('');
    setSupabaseProjectRef('');
    setSupabaseResolvedOk(false);
    setSupabaseResolveError(null);
    setSupabaseUiStep('pat');
    setSupabasePreflight(null);
    setSupabaseCreateError(null);
  }, [supabaseAccessToken]);

  useEffect(() => {
    if (supabaseUiStep !== 'pat') return;
    const pat = supabaseAccessToken.trim();
    if (!/^sbp_[A-Za-z0-9_-]{20,}$/.test(pat)) return;
    if (supabaseOrgsLoading || supabaseOrgs.length > 0 || supabaseOrgsError) return;
    
    const handle = setTimeout(() => void loadOrgsAndDecide(), 400);
    return () => clearTimeout(handle);
  }, [supabaseUiStep, supabaseAccessToken, supabaseOrgsLoading, supabaseOrgs.length, supabaseOrgsError]);
  
  useEffect(() => {
    if (!supabaseAccessToken.trim() || !supabaseUrl.trim()) return;
    if (supabaseResolving || supabaseResolvedOk) return;
    // Não dispara resolve enquanto o projeto ainda está provisionando
    if (supabaseProvisioning) return;
    
    if (resolveTimerRef.current) clearTimeout(resolveTimerRef.current);
    resolveTimerRef.current = setTimeout(() => void resolveKeys('auto'), 600);
    
    return () => { if (resolveTimerRef.current) clearTimeout(resolveTimerRef.current); };
  }, [supabaseAccessToken, supabaseUrl, supabaseResolving, supabaseResolvedOk, supabaseProvisioning]);
  
  // API Functions
  const loadOrgsAndDecide = async () => {
    if (supabaseOrgsLoading || supabasePreflightLoading) return;
    setSupabaseOrgsError(null);
    setSupabaseOrgsLoading(true);
    setSupabasePreflightLoading(true);
    setSupabaseUiStep('deciding');
    
    try {
      const orgsRes = await fetch('/api/installer/supabase/organizations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installerToken: installerToken.trim() || undefined, accessToken: supabaseAccessToken.trim() }),
      });
      const orgsData = await orgsRes.json();
      if (!orgsRes.ok) throw new Error(orgsData?.error || 'Erro');
      const orgs = (orgsData?.organizations || []) as SupabaseOrgOption[];
      setSupabaseOrgs(orgs);
      
      const preflightRes = await fetch('/api/installer/supabase/preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installerToken: installerToken.trim() || undefined, accessToken: supabaseAccessToken.trim() }),
      });
      const preflightData = await preflightRes.json();
      if (!preflightRes.ok) throw new Error(preflightData?.error || 'Erro');
      
      const preflight = {
        freeGlobalLimitHit: Boolean(preflightData?.freeGlobalLimitHit),
        suggestedOrganizationSlug: preflightData?.suggestedOrganizationSlug || null,
        organizations: (preflightData?.organizations || []) as PreflightOrg[],
      };
      setSupabasePreflight(preflight);
      
      await decideAndCreate(orgs, preflight);
      
    } catch (err) {
      setSupabaseOrgsError(err instanceof Error ? err.message : 'Erro');
      setSupabaseUiStep('pat');
    } finally {
      setSupabaseOrgsLoading(false);
      setSupabasePreflightLoading(false);
    }
  };
  
  const decideAndCreate = async (orgs: SupabaseOrgOption[], preflight: typeof supabasePreflight) => {
    if (!preflight) return;
    
    console.log('🔍 [SUPABASE] Preflight:', JSON.stringify(preflight, null, 2));
    
    const paidOrg = preflight.organizations.find((o) => (o.plan || '').toLowerCase() !== 'free');
    if (paidOrg) {
      console.log('💰 [SUPABASE] Usando org PAGA:', paidOrg.slug);
      await createProjectInOrg(paidOrg.slug, paidOrg.activeProjects.map((p) => p.name));
      return;
    }
    
    const freeOrgWithSlot = preflight.organizations.find(
      (o) => (o.plan || '').toLowerCase() === 'free' && o.activeCount < 2
    );
    if (freeOrgWithSlot) {
      console.log('🆓 [SUPABASE] Usando org FREE com slot:', freeOrgWithSlot.slug, '- Projetos ativos:', freeOrgWithSlot.activeCount);
      await createProjectInOrg(freeOrgWithSlot.slug, freeOrgWithSlot.activeProjects.map((p) => p.name));
      return;
    }
    
    console.log('🚫 [SUPABASE] Sem slots disponíveis');
    setSupabaseUiStep('needspace');
  };
  
  const createProjectInOrg = async (orgSlug: string, existingNames: string[]) => {
    if (supabaseCreating) return;
    setSupabaseCreateError(null);
    setSupabaseCreating(true);
    setSupabaseUiStep('creating');
    
    const projectName = suggestProjectName(existingNames);
    const createStart = Date.now();
    
    console.log('🚀 [SUPABASE] Criando projeto:', projectName, 'na org:', orgSlug);
    console.log('⏱️ [SUPABASE] Início:', new Date().toLocaleTimeString());
    
    try {
      const res = await fetch('/api/installer/supabase/create-project', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            installerToken: installerToken.trim() || undefined,
            accessToken: supabaseAccessToken.trim(),
          organizationSlug: orgSlug,
          name: projectName,
          dbPass: supabaseCreateDbPass,
          regionSmartGroup: 'americas',
          }),
        });
      const data = await res.json();
      
      console.log('📦 [SUPABASE] Resposta create-project:', JSON.stringify(data));
      console.log('⏱️ [SUPABASE] create-project levou:', ((Date.now() - createStart) / 1000).toFixed(1), 'segundos');
      
      if (!res.ok) throw new Error(data?.error || 'Erro');
      
      const ref = String(data?.projectRef || '');
      const url = String(data?.supabaseUrl || '');
      
      if (ref) {
        setSupabaseProjectRef(ref);
        setSupabaseUrl(url || `https://${ref}.supabase.co`);
        setSupabaseDbUrl(buildDbUrl(ref, supabaseCreateDbPass));
        
        setSupabaseProvisioning(true);
        setSupabaseProvisioningStatus('COMING_UP');
        
        let pollCount = 0;
        const poll = async () => {
          pollCount++;
          try {
            const st = await fetch('/api/installer/supabase/project-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ installerToken: installerToken.trim() || undefined, accessToken: supabaseAccessToken.trim(), projectRef: ref }),
            });
            const stData = await st.json().catch(() => null);
            const status = stData?.status || '';
            setSupabaseProvisioningStatus(status);
            
            console.log(`📊 [SUPABASE] Poll #${pollCount}: ${status} (${((Date.now() - createStart) / 1000).toFixed(0)}s)`);
            
            if (status.toUpperCase().startsWith('ACTIVE')) {
              const totalTime = ((Date.now() - createStart) / 1000).toFixed(1);
              console.log('✅ [SUPABASE] Projeto ATIVO!');
              console.log('⏱️ [SUPABASE] TEMPO TOTAL:', totalTime, 'segundos');
              
              setSupabaseProvisioning(false);
              if (provisioningTimerRef.current) clearInterval(provisioningTimerRef.current);
              if (provisioningTimeoutRef.current) clearTimeout(provisioningTimeoutRef.current);
              setSupabaseUiStep('done');
              void resolveKeys('auto');
            }
          } catch {}
        };
        
        void poll();
        provisioningTimerRef.current = setInterval(poll, 4000);
        provisioningTimeoutRef.current = setTimeout(() => {
          setSupabaseProvisioning(false);
          setSupabaseResolveError('Projeto ainda está subindo. Aguarde.');
          if (provisioningTimerRef.current) clearInterval(provisioningTimerRef.current);
        }, 210_000);
      }
    } catch (err) {
      console.error('❌ [SUPABASE] Erro:', err);
      setSupabaseCreateError(humanizeError(err instanceof Error ? err.message : 'Erro'));
      setSupabaseUiStep('needspace');
    } finally {
      setSupabaseCreating(false);
    }
  };
  
  const pauseProject = async (projectRef: string) => {
    if (supabasePausingRef) return;
    setSupabasePausingRef(projectRef);
    
    try {
      const res = await fetch('/api/installer/supabase/pause-project', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installerToken: installerToken.trim() || undefined, accessToken: supabaseAccessToken.trim(), projectRef }),
      });
      if (!res.ok) throw new Error('Falha ao pausar');
      
      setSupabaseUiStep('deciding');
      
      const preflightRes = await fetch('/api/installer/supabase/preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installerToken: installerToken.trim() || undefined, accessToken: supabaseAccessToken.trim() }),
      });
      const preflightData = await preflightRes.json();
      
      const preflight = {
        freeGlobalLimitHit: Boolean(preflightData?.freeGlobalLimitHit),
        suggestedOrganizationSlug: preflightData?.suggestedOrganizationSlug || null,
        organizations: (preflightData?.organizations || []) as PreflightOrg[],
      };
      setSupabasePreflight(preflight);
      
      await decideAndCreate(supabaseOrgs, preflight);
      
    } catch (err) {
      setSupabaseCreateError(err instanceof Error ? err.message : 'Erro');
    } finally {
      setSupabasePausingRef(null);
    }
  };
  
  const resolveKeys = async (mode: 'auto' | 'manual' = 'manual') => {
    if (supabaseResolving) return;
    const pat = supabaseAccessToken.trim();
    const url = supabaseUrl.trim();
    const ref = supabaseProjectRef.trim() || inferProjectRef(url);
    
    if (!pat || (!url && !ref)) {
      if (mode === 'manual') setSupabaseResolveError('Informe o PAT e selecione um projeto.');
      return;
    }
    
    if (resolveTimerRef.current) clearTimeout(resolveTimerRef.current);
    setSupabaseResolveError(null);
    setSupabaseResolving(true);
    setSupabaseResolvedOk(false);
    
    try {
      const res = await fetch('/api/installer/supabase/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installerToken: installerToken.trim() || undefined, accessToken: pat, supabaseUrl: url || undefined, projectRef: ref || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Erro');
      
      if (data?.projectRef) setSupabaseProjectRef(data.projectRef);
      if (data?.publishableKey) setSupabaseAnonKey(data.publishableKey);
      if (data?.secretKey) setSupabaseServiceKey(data.secretKey);
      if (data?.dbUrl) setSupabaseDbUrl(data.dbUrl);
      
      const warnings = data?.warnings || [];
      const hasDbUrl = Boolean(supabaseDbUrl.trim() || data?.dbUrl);
      const isOnlyDbWarnings = warnings.length > 0 && warnings.every((w: string) => w.toLowerCase().startsWith('db:'));
      
      if (warnings.length > 0 && !hasDbUrl && isOnlyDbWarnings) {
        resolveAttemptsRef.current += 1;
        if (resolveAttemptsRef.current < 6 && mode === 'auto') {
          setSupabaseResolveError(`Aguardando banco ficar pronto… (${resolveAttemptsRef.current}/6)`);
          resolveTimerRef.current = setTimeout(() => void resolveKeys('auto'), 2000 * resolveAttemptsRef.current);
          return;
        }
        setSupabaseResolveError('Banco ainda não está pronto.');
      } else if (warnings.length > 0 && !isOnlyDbWarnings) {
        setSupabaseResolveError(`Alguns itens não foram resolvidos: ${warnings.join(' | ')}`);
      } else {
        resolveAttemptsRef.current = 0;
        setSupabaseResolvedOk(true);
        // Vai direto pro próximo passo — sem tela de confirmação
        setCurrentStep(2);
      }
    } catch (err) {
      setSupabaseResolveError(err instanceof Error ? err.message : 'Erro');
    } finally {
      setSupabaseResolving(false);
    }
  };
  
  const runInstaller = async () => {
    if (!canInstall || installing || !project) return;
    setInstalling(true);
    setRunError(null);
    setResult(null);
    setShowInstallOverlay(true);
    setCinePhase('preparing');
    setCineMessage('Preparando a decolagem…');
    setCineSubtitle('Verificando sistemas...');
    setCineProgress(0);
    
    await new Promise((r) => setTimeout(r, 800));
    setCinePhase('running');
    
    try {
      const res = await fetch('/api/installer/run-stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          installerToken: installerToken.trim() || undefined,
          vercel: { token: vercelToken.trim(), teamId: project.teamId, projectId: project.id, targets: ['production', 'preview'] },
          supabase: {
            url: supabaseUrl.trim(),
            anonKey: supabaseAnonKey.trim() || undefined,
            serviceRoleKey: supabaseServiceKey.trim() || undefined,
            dbUrl: supabaseDbUrl.trim() || undefined,
            accessToken: supabaseAccessToken.trim() || undefined,
            projectRef: supabaseProjectRef.trim() || undefined,
            deployEdgeFunctions: supabaseDeployEdgeFunctions,
          },
          admin: { companyName: companyName.trim(), email: adminEmail.trim(), password: adminPassword },
        }),
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData?.error || 'Erro ao iniciar instalação');
      }
      
      const reader = res.body?.getReader();
      if (!reader) throw new Error('Streaming não suportado');
      
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            
            if (event.type === 'phase') {
              setCineMessage(event.title || 'Processando...');
              setCineSubtitle(event.subtitle || '');
              setCineProgress(event.progress || 0);
            } else if (event.type === 'complete' && event.ok) {
              setCinePhase('success');
              setCineMessage('Missão cumprida');
              setCineSubtitle('Bem-vindo ao novo mundo.');
              setCineProgress(100);
              setResult({ ok: true, steps: [] });
            } else if (event.type === 'error') {
              throw new Error(event.error || 'Erro durante a instalação');
            }
          } catch (parseErr) {
            console.warn('SSE parse error:', parseErr);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro';
      setRunError(message);
      setCinePhase('error');
      setCineMessage('Falha na missão');
      setCineSubtitle(message);
    } finally {
      setInstalling(false);
    }
  };

  if (!isHydrated) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
      </div>
    );
  }
  
  const goNext = () => setCurrentStep((s) => Math.min(s + 1, 3));
  const goBack = () => setCurrentStep((s) => Math.max(s - 1, 1));

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-slate-950 relative overflow-hidden"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => { mx.set(0); my.set(0); }}
    >
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.03)_0%,transparent_42%,rgba(2,6,23,0.95)_100%)]" />
        <motion.div
          className="absolute -top-[20%] -right-[10%] w-[50%] h-[50%] rounded-full blur-[120px] bg-cyan-500/15"
          style={{ x: mxSpring, y: mySpring }}
        />
        <motion.div
          className="absolute top-[40%] -left-[10%] w-[40%] h-[40%] rounded-full blur-[100px] bg-teal-500/12"
          style={{ x: mxSpring, y: mySpring }}
        />
      </div>

      <div className="w-full max-w-lg relative z-10 px-4">
        <div className="flex justify-center gap-2 mb-8">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className={`h-2 rounded-full transition-all duration-300 ${
                i === currentStep ? 'w-8 bg-cyan-400' : i < currentStep ? 'w-2 bg-cyan-400/60' : 'w-2 bg-white/20'
              }`}
            />
          ))}
              </div>

        <AnimatePresence mode="wait">
          {currentStep === 1 && (
            <motion.div key="step-supabase" variants={sceneVariants} initial="initial" animate="animate" exit="exit" transition={sceneTransition}>
              <AnimatePresence mode="wait">
                {supabaseUiStep === 'pat' && (
                  <motion.div key="supabase-pat" variants={sceneVariants} initial="initial" animate="animate" exit="exit" transition={sceneTransition} className="text-center">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 mb-6">
                      <Sparkles className="w-8 h-8 text-emerald-400" />
                  </div>
                    <h1 className="text-2xl font-bold text-white mb-2">Conectar Supabase</h1>
                    <p className="text-slate-400 mb-6">Cole seu token de acesso para continuar.</p>
                    <input type="password" value={supabaseAccessToken} onChange={(e) => setSupabaseAccessToken(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-4 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400/50 focus:border-transparent mb-4" placeholder="sbp_..." autoFocus />
                    <a href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-cyan-400 hover:text-cyan-300 mb-6">Gerar token <ExternalLink className="w-4 h-4" /></a>
                    {supabaseOrgsError && <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-4 text-red-400 text-sm">{supabaseOrgsError}</div>}
                  </motion.div>
                )}
                
                {supabaseUiStep === 'deciding' && (
                  <motion.div key="supabase-deciding" variants={sceneVariants} initial="initial" animate="animate" exit="exit" transition={sceneTransition} className="text-center py-12">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 mb-6">
                      <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
                        </div>
                    <h1 className="text-2xl font-bold text-white mb-2">Preparando seu projeto</h1>
                    <p className="text-slate-400">Verificando sua conta Supabase…</p>
                  </motion.div>
                )}
                
                {supabaseUiStep === 'needspace' && (
                  <motion.div key="supabase-needspace" variants={sceneVariants} initial="initial" animate="animate" exit="exit" transition={sceneTransition}>
                    <div className="text-center mb-6">
                      <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 mb-6">
                        <Pause className="w-8 h-8 text-amber-400" />
                        </div>
                      <h1 className="text-2xl font-bold text-white mb-2">Precisamos de espaço</h1>
                      <p className="text-slate-400">Seu plano permite 2 projetos ativos.<br />Pause um para continuar:</p>
                        </div>
                    <div className="space-y-3 mb-6">
                      {allFreeActiveProjects.map((p) => (
                        <div key={p.ref} className="flex items-center justify-between gap-4 bg-white/5 border border-white/10 rounded-xl p-4">
                                    <div className="min-w-0">
                            <div className="text-white font-medium truncate">{p.name}</div>
                            <div className="text-slate-500 text-sm truncate">{p.orgName}</div>
                                      </div>
                          <button onClick={() => void pauseProject(p.ref)} disabled={supabasePausingRef === p.ref} className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-white font-medium text-sm transition-all disabled:opacity-50 shrink-0">
                            {supabasePausingRef === p.ref ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Pausar'}
                                      </button>
                                  </div>
                                ))}
                                </div>
                    <div className="flex items-start gap-3 bg-white/5 border border-white/10 rounded-xl p-4 text-sm text-slate-400">
                      <Info className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
                      <span>Você pode reativar a qualquer momento no painel do Supabase.</span>
                              </div>
                    {supabaseCreateError && <div className="mt-4 rounded-xl bg-red-500/10 border border-red-500/20 p-4 text-red-400 text-sm">{supabaseCreateError}</div>}
                  </motion.div>
                )}
                
                {supabaseUiStep === 'creating' && (
                  <motion.div key="supabase-creating" variants={sceneVariants} initial="initial" animate="animate" exit="exit" transition={sceneTransition} className="text-center py-12">
                    <div className="relative inline-flex items-center justify-center w-24 h-24 mb-8">
                      <motion.div className="absolute inset-0 rounded-full border-2 border-cyan-400/30" animate={{ scale: [1, 1.3, 1], opacity: [0.5, 0, 0.5] }} transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }} />
                      <motion.div className="absolute inset-2 rounded-full border-2 border-cyan-400/50" animate={{ scale: [1, 1.2, 1], opacity: [0.7, 0.2, 0.7] }} transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut', delay: 0.3 }} />
                      <div className="w-16 h-16 rounded-full bg-cyan-500/20 flex items-center justify-center">
                        <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
                              </div>
                            </div>
                    <h1 className="text-2xl font-bold text-white mb-2">Criando seu projeto</h1>
                    <p className="text-slate-400 mb-4">{supabaseProvisioningStatus === 'COMING_UP' ? 'Inicializando infraestrutura…' : supabaseProvisioningStatus ? `Status: ${supabaseProvisioningStatus}` : 'Preparando ambiente…'}</p>
                    <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                      <motion.div className="h-full bg-gradient-to-r from-cyan-400 to-teal-400" initial={{ width: '0%' }} animate={{ width: '100%' }} transition={{ duration: 120, ease: 'linear' }} />
                              </div>
                    <p className="text-slate-500 text-sm mt-4">Isso pode levar até 2 minutos. Não feche esta página.</p>
                  </motion.div>
                )}
                
                {supabaseUiStep === 'done' && (
                  <motion.div key="supabase-done" variants={sceneVariants} initial="initial" animate="animate" exit="exit" transition={sceneTransition} className="text-center">
                    {supabaseResolving ? (
                      <>
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 mb-6"><Loader2 className="w-8 h-8 text-cyan-400 animate-spin" /></div>
                        <h1 className="text-2xl font-bold text-white mb-2">Configurando chaves</h1>
                        <p className="text-slate-400">Aguarde um momento…</p>
                      </>
                    ) : supabaseResolvedOk ? (
                      <>
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 mb-6"><CheckCircle2 className="w-8 h-8 text-emerald-400" /></div>
                        <h1 className="text-2xl font-bold text-white mb-2">Supabase configurado</h1>
                        <p className="text-slate-400 mb-8">Projeto pronto para usar.</p>
                        <button onClick={goNext} className="w-full py-4 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-white font-semibold text-lg transition-all shadow-lg shadow-cyan-500/25">Continuar</button>
                      </>
                    ) : supabaseResolveError ? (
                      <>
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 mb-6"><AlertCircle className="w-8 h-8 text-amber-400" /></div>
                        <h1 className="text-2xl font-bold text-white mb-2">Quase lá</h1>
                        <p className="text-slate-400 mb-4">{supabaseResolveError}</p>
                        <button onClick={() => void resolveKeys('manual')} className="w-full py-4 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-white font-semibold transition-all">Tentar novamente</button>
                      </>
                    ) : (
                      <>
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 mb-6"><Loader2 className="w-8 h-8 text-cyan-400 animate-spin" /></div>
                        <h1 className="text-2xl font-bold text-white mb-2">Finalizando</h1>
                        <p className="text-slate-400">Resolvendo configurações…</p>
                      </>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
          
          {currentStep === 2 && (
            <motion.div key="step-admin" variants={sceneVariants} initial="initial" animate="animate" exit="exit" transition={sceneTransition}>
              <h1 className="text-2xl font-bold text-white mb-2 text-center">Criar administrador</h1>
              <p className="text-slate-400 mb-6 text-center">Configure o primeiro acesso ao sistema.</p>
              <div className="space-y-4">
                <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-4 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400/50" placeholder="Nome da empresa" />
                <input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-4 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400/50" placeholder="Email do administrador" />
                <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-4 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400/50" placeholder="Senha (mínimo 6 caracteres)" />
                <input type="password" value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); setConfirmTouched(true); }} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-4 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400/50" placeholder="Confirmar senha" />
                {confirmTouched && !passwordsMatch && confirmPassword.length > 0 && <p className="text-red-400 text-sm">As senhas não conferem.</p>}
                        </div>
              <button onClick={goNext} disabled={!adminReady} className="w-full mt-6 py-4 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-white font-semibold text-lg transition-all shadow-lg shadow-cyan-500/25 disabled:opacity-50">Continuar</button>
            </motion.div>
          )}
          
          {currentStep === 3 && (
            <motion.div key="step-launch" variants={sceneVariants} initial="initial" animate="animate" exit="exit" transition={sceneTransition} className="text-center">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-cyan-400 to-teal-400 mb-6"><Sparkles className="w-10 h-10 text-white" /></div>
              <h1 className="text-3xl font-bold text-white mb-2">Tudo pronto!</h1>
              <p className="text-slate-400 mb-8">Clique para iniciar a instalação do seu CRM.</p>
              <button onClick={runInstaller} disabled={!canInstall || installing} className="w-full py-5 rounded-2xl bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 text-white font-bold text-xl transition-all shadow-xl shadow-cyan-500/30 disabled:opacity-50">
                {installing ? <span className="flex items-center justify-center gap-3"><Loader2 className="w-6 h-6 animate-spin" />Instalando…</span> : '🚀 Lançar'}
                        </button>
              {runError && !showInstallOverlay && <div className="mt-4 rounded-xl bg-red-500/10 border border-red-500/20 p-4 text-red-400 text-sm">{runError}</div>}
            </motion.div>
          )}
        </AnimatePresence>
        
        {currentStep > 1 && currentStep < 3 && supabaseUiStep !== 'creating' && supabaseUiStep !== 'deciding' && (
          <button onClick={goBack} className="mt-6 w-full py-3 text-slate-400 hover:text-white transition-colors">← Voltar</button>
                      )}
                    </div>
      
      <AnimatePresence>
        {showInstallOverlay && (
          <motion.div key="install-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950">
            {/* Background cinematográfico */}
            <div className="absolute inset-0 overflow-hidden">
              {/* Gradiente pulsante */}
              <motion.div 
                className="absolute top-1/2 left-1/2 w-[800px] h-[800px] -translate-x-1/2 -translate-y-1/2" 
                animate={{ 
                  background: [
                    'radial-gradient(circle, rgba(34,211,238,0.12) 0%, transparent 60%)', 
                    'radial-gradient(circle, rgba(45,212,191,0.15) 0%, transparent 65%)', 
                    'radial-gradient(circle, rgba(34,211,238,0.12) 0%, transparent 60%)'
                  ] 
                }} 
                transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }} 
              />
              {/* Estrelas em movimento */}
              {cinePhase === 'running' && (
                <motion.div 
                  className="absolute inset-0" 
                  style={{ 
                    backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.4) 1px, transparent 1px)', 
                    backgroundSize: '50px 50px' 
                  }} 
                  animate={{ backgroundPositionY: ['0px', '-300px'] }} 
                  transition={{ duration: 8, repeat: Infinity, ease: 'linear' }} 
                />
              )}
              {/* Vignette */}
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(2,6,23,0.8)_100%)]" />
            </div>
            
            <div className="relative text-center px-4 max-w-md">
              {/* Ícone central */}
              <div className="relative inline-flex items-center justify-center w-32 h-32 mb-8">
                {cinePhase === 'preparing' || cinePhase === 'running' ? (
                  <>
                    {/* Anéis pulsantes estilo radar */}
                    <motion.div 
                      className="absolute inset-0 rounded-full border border-cyan-400/20" 
                      animate={{ scale: [1, 2, 2], opacity: [0.6, 0, 0] }} 
                      transition={{ duration: 2.5, repeat: Infinity, ease: 'easeOut' }} 
                    />
                    <motion.div 
                      className="absolute inset-0 rounded-full border border-cyan-400/20" 
                      animate={{ scale: [1, 2, 2], opacity: [0.6, 0, 0] }} 
                      transition={{ duration: 2.5, repeat: Infinity, ease: 'easeOut', delay: 0.8 }} 
                    />
                    <motion.div 
                      className="absolute inset-0 rounded-full border border-cyan-400/20" 
                      animate={{ scale: [1, 2, 2], opacity: [0.6, 0, 0] }} 
                      transition={{ duration: 2.5, repeat: Infinity, ease: 'easeOut', delay: 1.6 }} 
                    />
                    {/* Círculo central com spinner */}
                    <div className="w-24 h-24 rounded-full bg-gradient-to-br from-cyan-500/20 to-teal-500/20 border border-cyan-400/30 flex items-center justify-center backdrop-blur-sm">
                      <Loader2 className="w-10 h-10 text-cyan-400 animate-spin" />
                    </div>
                  </>
                ) : cinePhase === 'success' ? (
                  <>
                    {/* Explosão de partículas no sucesso */}
                    <motion.div className="absolute inset-0 pointer-events-none">
                      {Array.from({ length: 24 }).map((_, i) => {
                        const angle = (Math.PI * 2 * i) / 24;
                        const distance = 120 + Math.random() * 80;
                        return (
                          <motion.div 
                            key={i} 
                            className="absolute left-1/2 top-1/2 w-2 h-2 rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400" 
                            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }} 
                            animate={{ 
                              x: Math.cos(angle) * distance, 
                              y: Math.sin(angle) * distance, 
                              opacity: 0,
                              scale: 0.5
                            }} 
                            transition={{ duration: 1.2, delay: i * 0.03, ease: 'easeOut' }} 
                          />
                        );
                      })}
                    </motion.div>
                    <motion.div 
                      initial={{ scale: 0, rotate: -180 }} 
                      animate={{ scale: 1, rotate: 0 }} 
                      transition={{ type: 'spring', stiffness: 200, damping: 15 }} 
                      className="w-32 h-32 rounded-full bg-gradient-to-br from-emerald-400 to-cyan-400 flex items-center justify-center shadow-lg shadow-emerald-500/30"
                    >
                      <CheckCircle2 className="w-16 h-16 text-white" />
                    </motion.div>
                  </>
                ) : (
                  <motion.div 
                    initial={{ scale: 0.8 }} 
                    animate={{ scale: 1 }}
                    className="w-32 h-32 rounded-full bg-red-500/20 border border-red-500/30 flex items-center justify-center"
                  >
                    <AlertCircle className="w-16 h-16 text-red-400" />
                  </motion.div>
                )}
              </div>
              
              {/* Título principal */}
              <AnimatePresence mode="wait">
                <motion.h1 
                  key={cineMessage} 
                  initial={{ opacity: 0, y: 20 }} 
                  animate={{ opacity: 1, y: 0 }} 
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.4 }}
                  className="text-3xl font-bold text-white mb-3"
                >
                  {cineMessage}
                </motion.h1>
              </AnimatePresence>
              
              {/* Subtítulo */}
              <AnimatePresence mode="wait">
                <motion.p 
                  key={cineSubtitle} 
                  initial={{ opacity: 0 }} 
                  animate={{ opacity: 1 }} 
                  exit={{ opacity: 0 }}
                  className="text-slate-400 mb-6 h-6"
                >
                  {cineSubtitle}
                </motion.p>
              </AnimatePresence>
              
              {/* Barra de progresso (só durante running) */}
              {cinePhase === 'running' && (
                <div className="w-full max-w-xs mx-auto mb-8">
                  <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                    <motion.div 
                      className="h-full bg-gradient-to-r from-cyan-400 to-teal-400 rounded-full"
                      initial={{ width: '0%' }}
                      animate={{ width: `${cineProgress}%` }}
                      transition={{ duration: 0.5, ease: 'easeOut' }}
                    />
                  </div>
                  <p className="text-xs text-slate-500 mt-2">{cineProgress}%</p>
                </div>
              )}
              
              {/* Botões de ação */}
              {cinePhase === 'success' && (
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}>
                  <p className="text-slate-400 mb-6">Seu CRM está pronto. Aguarde o redeploy e faça login.</p>
                  <button 
                    onClick={() => setShowInstallOverlay(false)} 
                    className="px-8 py-4 rounded-2xl bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 text-white font-semibold text-lg shadow-lg shadow-cyan-500/30 transition-all"
                  >
                    Concluir
                  </button>
                </motion.div>
              )}
              
              {cinePhase === 'error' && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <p className="text-red-400/80 mb-6">{runError || 'Algo deu errado durante a instalação.'}</p>
                  <button 
                    onClick={() => setShowInstallOverlay(false)} 
                    className="px-8 py-4 rounded-2xl bg-white/10 hover:bg-white/20 text-white font-semibold transition-all"
                  >
                    Voltar
                  </button>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
