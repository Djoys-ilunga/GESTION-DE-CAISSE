import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, vi } from 'vitest';
import { App } from './App';
import { ConnectionService } from './hybrid/connection';
it('affiche un accueil français sans inventer de solde et permet la navigation', async () => {
  const c = new ConnectionService(
    'https://example.test',
    'expected',
    false,
    vi.fn().mockRejectedValue(new Error('offline')),
  );
  render(<App connection={c} />);
  expect(screen.getByRole('heading', { name: /Bienvenue sur CaissePro/ })).toBeInTheDocument();
  expect(await screen.findByText('Hors connexion')).toBeInTheDocument();
  expect(screen.getByText('Aucun solde disponible')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Brouillons 0' }));
  expect(screen.getByRole('heading', { name: 'Aucun brouillon disponible' })).toBeInTheDocument();
});
