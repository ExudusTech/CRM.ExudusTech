
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDealsLogic } from './useDealsLogic';

// Mock dependencies
vi.mock('@/context/CRMContext', () => ({
    useCRM: () => ({
        deals: [
            { id: '1', title: 'Deal 1', items: [{ id: 'item1', name: 'Product A' }] }, // Normal deal
            { id: '2', title: 'Deal 2', items: undefined }, // Malformed deal (cause of crash)
        ],
        updateDeal: vi.fn(),
    }),
}));

describe('useDealsLogic - Null Safety', () => {
    it('should not crash when removing item from a deal with undefined items', async () => {
        const { result } = renderHook(() => useDealsLogic());

        // Should work fine for normal deal
        await act(async () => {
            await result.current.removeItemFromDeal('1', 'item1');
        });

        // Should NOT crash for malformed deal
        await expect(
            act(async () => {
                await result.current.removeItemFromDeal('2', 'some-item');
            })
        ).resolves.toBeUndefined();
    });
});
