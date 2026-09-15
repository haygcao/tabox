/** @jest-environment jsdom */
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import AIChatAvatar from '../app/ai/AIChatAvatar';

test('identifies Tabox AI with its branded avatar', () => {
    render(<AIChatAvatar />);
    expect(screen.getByRole('img', { name: 'Tabox AI' })).toHaveAttribute('src', 'icons/icon48.png');
});

test('uses the user photo and falls back to initials if it fails', () => {
    render(<AIChatAvatar user={{ displayName: 'Gil Goldstein', photoLink: 'https://example.com/me.png' }} role="user" />);
    const photo = screen.getByRole('img', { name: 'You' });
    expect(photo).toHaveAttribute('src', 'https://example.com/me.png');
    fireEvent.error(photo);
    expect(screen.getByRole('img', { name: 'You' })).toHaveTextContent('GG');
});
