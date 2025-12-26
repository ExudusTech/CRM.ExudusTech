import React, { useCallback, useMemo } from 'react';
import Image from 'next/image';
import { DealView, CustomFieldDefinition, BoardStage } from '@/types';
import { ActivityStatusIcon } from './ActivityStatusIcon';
import { getActivityStatus } from '@/features/boards/hooks/useBoardsController';

type QuickAddType = 'CALL' | 'MEETING' | 'EMAIL';

type KanbanListRowProps = {
  deal: DealView;
  stageLabel: string;
  customFieldDefinitions: CustomFieldDefinition[];
  isMenuOpen: boolean;
  onSelect: (dealId: string) => void;
  onToggleMenu: (e: React.MouseEvent, dealId: string) => void;
  onQuickAdd: (dealId: string, type: QuickAddType, dealTitle: string) => void;
  onCloseMenu: () => void;
};

/**
 * Performance: tabela pode ter muitas linhas.
 * `React.memo` + `isMenuOpen` por-linha evita re-render em massa ao alternar o menu.
 */
const KanbanListRow = React.memo(function KanbanListRow({
  deal,
  stageLabel,
  customFieldDefinitions,
  isMenuOpen,
  onSelect,
  onToggleMenu,
  onQuickAdd,
  onCloseMenu,
}: KanbanListRowProps) {
  return (
    <tr
      onClick={() => onSelect(deal.id)}
      className="hover:bg-slate-50/50 dark:hover:bg-white/5 transition-colors cursor-pointer group"
    >
      <td className="px-6 py-3 text-center">
        <ActivityStatusIcon
          status={getActivityStatus(deal)}
          type={deal.nextActivity?.type}
          dealId={deal.id}
          dealTitle={deal.title}
          isOpen={isMenuOpen}
          onToggle={(e) => onToggleMenu(e, deal.id)}
          onQuickAdd={(type) => onQuickAdd(deal.id, type, deal.title)}
          onRequestClose={onCloseMenu}
        />
      </td>
      <td className="px-6 py-3 font-bold text-slate-900 dark:text-white">{deal.title}</td>
      <td className="px-6 py-3 text-slate-600 dark:text-slate-300">{deal.companyName}</td>
      <td className="px-6 py-3">
        <span
          className={`text-xs font-bold px-2 py-1 rounded ${
            deal.isWon
              ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300'
              : deal.isLost
                ? 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
          } `}
        >
          {stageLabel}
        </span>
      </td>
      <td className="px-6 py-3 font-mono text-slate-700 dark:text-slate-200">${deal.value.toLocaleString()}</td>
      <td className="px-6 py-3">
        <div className="flex items-center gap-2">
          <Image src={deal.owner.avatar} alt="" width={20} height={20} className="w-5 h-5 rounded-full" unoptimized />
          <span className="text-xs text-slate-500">{deal.owner.name}</span>
        </div>
      </td>
      {/* Custom Fields Cells */}
      {customFieldDefinitions.map((field) => (
        <td key={field.id} className="px-6 py-3 text-right text-slate-600 dark:text-slate-300 text-sm">
          {deal.customFields?.[field.key] || '-'}
        </td>
      ))}
    </tr>
  );
});

interface KanbanListProps {
  stages: BoardStage[];
  filteredDeals: DealView[];
  customFieldDefinitions: CustomFieldDefinition[];
  setSelectedDealId: (id: string | null) => void;
  openActivityMenuId: string | null;
  setOpenActivityMenuId: (id: string | null) => void;
  handleQuickAddActivity: (
    dealId: string,
    type: 'CALL' | 'MEETING' | 'EMAIL',
    dealTitle: string
  ) => void;
}

/**
 * Componente React `KanbanList`.
 *
 * @param {KanbanListProps} {
  stages,
  filteredDeals,
  customFieldDefinitions,
  setSelectedDealId,
  openActivityMenuId,
  setOpenActivityMenuId,
  handleQuickAddActivity,
} - Parâmetro `{
  stages,
  filteredDeals,
  customFieldDefinitions,
  setSelectedDealId,
  openActivityMenuId,
  setOpenActivityMenuId,
  handleQuickAddActivity,
}`.
 * @returns {Element} Retorna um valor do tipo `Element`.
 */
export const KanbanList: React.FC<KanbanListProps> = ({
  stages,
  filteredDeals,
  customFieldDefinitions,
  setSelectedDealId,
  openActivityMenuId,
  setOpenActivityMenuId,
  handleQuickAddActivity,
}) => {
  // Performance: evitar `find` por linha (O(N*S)) ao renderizar tabela.
  const stageLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of stages) {
      if (s?.id) map.set(s.id, s.label);
    }
    return map;
  }, [stages]);

  // Performance: callbacks estáveis evitam re-render de subcomponentes memoizados.
  const handleRowClick = useCallback(
    (dealId: string) => {
      setSelectedDealId(dealId);
    },
    [setSelectedDealId]
  );

  const handleToggleMenu = useCallback(
    (e: React.MouseEvent, dealId: string) => {
      e.stopPropagation();
      setOpenActivityMenuId(openActivityMenuId === dealId ? null : dealId);
    },
    [openActivityMenuId, setOpenActivityMenuId]
  );

  const handleCloseMenu = useCallback(() => setOpenActivityMenuId(null), [setOpenActivityMenuId]);

  const handleQuickAdd = useCallback(
    (dealId: string, type: QuickAddType, dealTitle: string) => {
      handleQuickAddActivity(dealId, type, dealTitle);
    },
    [handleQuickAddActivity]
  );

  return (
    <div className="h-full overflow-hidden glass rounded-xl border border-slate-200 dark:border-white/5 shadow-sm">
      <div className="h-full overflow-auto">
        <table className="w-full text-left text-sm border-collapse">
          <thead className="bg-slate-50/80 dark:bg-white/5 border-b border-slate-200 dark:border-white/5 sticky top-0 z-10 backdrop-blur-sm">
            <tr>
              <th className="px-6 py-3 font-bold text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider w-10"></th>
              <th className="px-6 py-3 font-bold text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                Negócio
              </th>
              <th className="px-6 py-3 font-bold text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                Empresa
              </th>
              <th className="px-6 py-3 font-bold text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                Estágio
              </th>
              <th className="px-6 py-3 font-bold text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                Valor
              </th>
              <th className="px-6 py-3 font-bold text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                Dono
              </th>
              {/* Custom Fields Columns */}
              {customFieldDefinitions.map(field => (
                <th
                  key={field.id}
                  className="px-6 py-3 font-bold text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider text-right"
                >
                  {field.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/5">
            {filteredDeals.map((deal) => (
              <KanbanListRow
                key={deal.id}
                deal={deal}
                stageLabel={stageLabelById.get(deal.status) || deal.status}
                customFieldDefinitions={customFieldDefinitions}
                isMenuOpen={openActivityMenuId === deal.id}
                onSelect={handleRowClick}
                onToggleMenu={handleToggleMenu}
                onQuickAdd={handleQuickAdd}
                onCloseMenu={handleCloseMenu}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
