import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { App } from './App';
import { fakeGateway, view, profile } from './auth/test-fixture';
describe('Interface d’authentification avec courtier simulé', () => {
  it('termine le contrôle de disponibilité après le remontage StrictMode', async () => {
    const { gateway } = fakeGateway();
    render(
      <StrictMode>
        <App gateway={gateway} />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Serveur disponible'));
  });
  it('connecte un utilisateur et masque les écrans non autorisés', async () => {
    const { gateway } = fakeGateway();
    render(<App gateway={gateway} />);
    expect(
      screen.getByRole('heading', { name: 'Connectez-vous à votre espace' }),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Code entreprise'), 'TEST');
    await userEvent.type(screen.getByLabelText('Adresse e-mail'), 'alice@example.test');
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'Mot-de-passe-test-2026');
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('heading', { name: /Bienvenue, Alice/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Utilisateurs' })).not.toBeInTheDocument();
    expect(gateway.login).toHaveBeenCalledWith(
      'TEST',
      'alice@example.test',
      'Mot-de-passe-test-2026',
    );
  });
  it('affiche une erreur générique et efface le mot de passe après échec', async () => {
    const { gateway } = fakeGateway();
    vi.mocked(gateway.login).mockRejectedValueOnce(new Error('INVALID_CREDENTIALS'));
    render(<App gateway={gateway} />);
    await userEvent.type(screen.getByLabelText('Code entreprise'), 'TEST');
    await userEvent.type(screen.getByLabelText('Adresse e-mail'), 'alice@example.test');
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'incorrect');
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Identifiants ou déverrouillage non valides.',
    );
    expect(screen.getByLabelText('Mot de passe')).toHaveValue('');
  });
  it('retire les données à la déconnexion et lors du changement d’utilisateur', async () => {
    const { gateway } = fakeGateway(view());
    render(<App gateway={gateway} />);
    expect(await screen.findByRole('heading', { name: /Bienvenue, Alice/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Déconnexion' }));
    expect(
      await screen.findByRole('heading', { name: 'Connectez-vous à votre espace' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('verrouille l’écran sans montrer les données et propose un déverrouillage', async () => {
    const p = profile(),
      { gateway } = fakeGateway({ ...view(p), state: 'locked', profile: null });
    render(<App gateway={gateway} />);
    expect(await screen.findByRole('heading', { name: 'Session verrouillée' })).toBeInTheDocument();
    expect(screen.queryByText('Soldes de vos caisses')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Votre mot de passe')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Changer d’utilisateur' })).toBeInTheDocument();
  });
  it('réserve le changement du mot de passe initial avant tout accès financier', async () => {
    const p = profile();
    p.user.mustChangePassword = true;
    p.offlineUntil = null;
    const { gateway } = fakeGateway(view(p));
    render(<App gateway={gateway} />);
    expect(
      await screen.findByRole('heading', { name: 'Renouvelez votre mot de passe' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Soldes de vos caisses')).not.toBeInTheDocument();
  });
  it('signale les informations non actualisées en mode hors connexion', async () => {
    const { gateway } = fakeGateway({ ...view(), state: 'offline' });
    vi.mocked(gateway.health).mockResolvedValue(false);
    vi.mocked(gateway.revalidate).mockRejectedValue(new Error('SERVER_UNAVAILABLE'));
    render(<App gateway={gateway} />);
    await waitFor(() =>
      expect(screen.getByText(/Accès hors connexion limité jusqu’à/)).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Une révocation récente peut ne pas encore être connue/),
    ).toBeInTheDocument();
  });
});
