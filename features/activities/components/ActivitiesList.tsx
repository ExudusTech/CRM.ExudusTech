import React, { useMemo } from 'react';
import { Activity, Deal } from '@/types';
import { ActivityRow } from './ActivityRow';

interface ActivitiesListProps {
    activities: Activity[];
    deals: Deal[];
    onToggleComplete: (id: string) => void;
    onEdit: (activity: Activity) => void;
    onDelete: (id: string) => void;
    selectedActivities?: Set<string>;
    onSelectActivity?: (id: string, selected: boolean) => void;
}

/**
 * Componente React `ActivitiesList`.
 *
 * @param {ActivitiesListProps} {
    activities,
    deals,
    onToggleComplete,
    onEdit,
    onDelete,
    selectedActivities = new Set(),
    onSelectActivity
} - Parâmetro `{
    activities,
    deals,
    onToggleComplete,
    onEdit,
    onDelete,
    selectedActivities = new Set(),
    onSelectActivity
}`.
 * @returns {Element} Retorna um valor do tipo `Element`.
 */
export const ActivitiesList: React.FC<ActivitiesListProps> = ({
    activities,
    deals,
    onToggleComplete,
    onEdit,
    onDelete,
    selectedActivities = new Set(),
    onSelectActivity
}) => {
    // Performance: Activities pode ser uma lista grande; evitamos `find` por linha (O(N*M)).
    const dealById = useMemo(() => {
        const map = new Map<string, Deal>();
        for (const d of deals) map.set(d.id, d);
        return map;
    }, [deals]);

    if (activities.length === 0) {
        return (
            <div className="text-center py-12 bg-white dark:bg-dark-card rounded-xl border border-slate-200 dark:border-white/5 border-dashed">
                <p className="text-slate-500 dark:text-slate-400">Nenhuma atividade encontrada</p>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {activities.map(activity => (
                <ActivityRow
                    key={activity.id}
                    activity={activity}
                    deal={activity.dealId ? dealById.get(activity.dealId) : undefined}
                    onToggleComplete={onToggleComplete}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    isSelected={selectedActivities.has(activity.id)}
                    onSelect={onSelectActivity}
                />
            ))}
        </div>
    );
};
