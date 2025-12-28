'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, Sparkles } from 'lucide-react';
import { AnimatePresence, motion, useMotionValue, useSpring } from 'framer-motion';

type InstallerMeta = { enabled: boolean; requiresToken: boolean };

const STORAGE_TOKEN = 'crm_install_token';
const STORAGE_PROJECT = 'crm_install_project';
const STORAGE_INSTALLER_TOKEN = 'crm_install_installer_token';

export default function InstallStartPage() {
  const router = useRouter();
  
  const [meta, setMeta] = useState<InstallerMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [installerToken, setInstallerToken] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [step, setStep] = useState<'input' | 'validating' | 'success'>('input');
  const [isLoading, setIsLoading] = useState(false);
  
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
    
    if (savedInstallerToken) setInstallerToken(savedInstallerToken);
    
    // Se já tem dados salvos, vai direto pro wizard
    if (savedToken && savedProject) {
      router.push('/install/wizard');
    }
  }, [router]);
  
  useEffect(() => {
    if (step !== 'input') return;
    const t = token.trim();
    if (t.length < 20) return;
    if (isLoading) return;
    
    const handle = setTimeout(() => void handleValidate(), 500);
    return () => clearTimeout(handle);
  }, [token, step, isLoading]);
  
  const handleValidate = async () => {
    const t = token.trim();
    if (!t) return;
    if (meta?.requiresToken && !installerToken.trim()) {
      setError('Installer token obrigatório');
      return;
    }
    
    setError('');
    setIsLoading(true);
    setStep('validating');
    
    try {
      const res = await fetch('/api/installer/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: t,
          installerToken: installerToken.trim() || undefined,
          domain: typeof window !== 'undefined' ? window.location.hostname : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Erro ao validar token');
      
      // Salva e vai direto pro wizard — sem confirmação!
      localStorage.setItem(STORAGE_TOKEN, t);
      localStorage.setItem(STORAGE_PROJECT, JSON.stringify(data.project));
      if (installerToken.trim()) localStorage.setItem(STORAGE_INSTALLER_TOKEN, installerToken.trim());
      
      setStep('success');
      setTimeout(() => router.push('/install/wizard'), 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao validar token');
      setStep('input');
    } finally {
      setIsLoading(false);
    }
  };
  
  if (!meta && !metaError) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
      </div>
    );
  }
  
  if (metaError || (meta && !meta.enabled)) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 mb-6">
            <AlertCircle className="w-8 h-8 text-red-400" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Instalador indisponível</h1>
          <p className="text-slate-400">{metaError || 'Instalador desabilitado no servidor.'}</p>
        </div>
      </div>
    );
  }
  
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
        <AnimatePresence mode="wait">
          {step === 'input' && (
            <motion.div
              key="step-input"
              variants={sceneVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={sceneTransition}
              className="text-center"
            >
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 mb-6">
                <Sparkles className="w-8 h-8 text-cyan-400" />
              </div>
              
              <h1 className="text-2xl font-bold text-white mb-2">Conectar com a Vercel</h1>
              <p className="text-slate-400 mb-6">Cole seu token de acesso para continuar.</p>
              
              {meta?.requiresToken && (
                <input
                  type="password"
                  value={installerToken}
                  onChange={(e) => setInstallerToken(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-4 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400/50 focus:border-transparent mb-3"
                  placeholder="Installer token"
                />
              )}
              
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-4 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400/50 focus:border-transparent mb-4"
                placeholder="Cole seu token aqui..."
                autoFocus
              />
              
              <a
                href="https://vercel.com/account/tokens"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm text-cyan-400 hover:text-cyan-300 mb-6"
              >
                Gerar token <ExternalLink className="w-4 h-4" />
              </a>
              
              {error && (
                <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-4 text-red-400 text-sm">
                  {error}
                </div>
              )}
            </motion.div>
          )}
          
          {step === 'validating' && (
            <motion.div
              key="step-validating"
              variants={sceneVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={sceneTransition}
              className="text-center py-12"
            >
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 mb-6">
                <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
              </div>
              
              <h1 className="text-2xl font-bold text-white mb-2">Detectando projeto</h1>
              <p className="text-slate-400">Verificando sua conta Vercel…</p>
            </motion.div>
          )}
          
          {step === 'success' && (
            <motion.div
              key="step-success"
              variants={sceneVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={sceneTransition}
              className="text-center py-12"
            >
              <div className="relative inline-flex items-center justify-center w-20 h-20 mb-6">
                <motion.div
                  className="absolute inset-0 rounded-full border-2 border-cyan-400/30"
                  animate={{ scale: [1, 1.3, 1], opacity: [0.5, 0, 0.5] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                />
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-cyan-400 to-teal-400 flex items-center justify-center">
                  <CheckCircle2 className="w-8 h-8 text-white" />
                </div>
              </div>
              
              <h1 className="text-2xl font-bold text-white mb-2">Conectado!</h1>
              <p className="text-slate-400">Entrando no assistente…</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
