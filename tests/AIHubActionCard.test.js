/** @jest-environment jsdom */
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import AIHubActionCard from '../app/ai/AIHubActionCard';

test('keeps details out of the initial decision and exposes one primary action', () => {
    const apply = jest.fn();
    render(<AIHubActionCard title="7 loose collections" primary={{ label: 'Organize collections', onClick: apply }}><input aria-label="Advanced option" /></AIHubActionCard>);
    expect(screen.getByLabelText('Advanced option')).not.toBeVisible();
    fireEvent.click(screen.getByText('Organize collections'));
    expect(apply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('View details'));
    expect(screen.getByLabelText('Advanced option')).toBeVisible();
});

test('completed work collapses to a quiet result with undo', () => {
    render(<AIHubActionCard title="7 collections organized" done primary={{ label: 'Undo', onClick: jest.fn() }}><p>Detailed results</p></AIHubActionCard>);
    expect(screen.getByText('7 collections organized')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
    expect(screen.getByText('Detailed results')).not.toBeVisible();
});
