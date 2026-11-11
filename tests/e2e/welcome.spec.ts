import { test, expect } from '@playwright/test';
test('connexion française hors réseau sans stockage de secret dans le navigateur', async ({
  page,
}) => {
  await page.route('**/api/v1/health/ready', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Connectez-vous à votre espace' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Hors connexion');
  await expect(page.getByLabel('Mot de passe', { exact: true })).toHaveAttribute(
    'type',
    'password',
  );
  await expect(page.getByRole('button', { name: 'Se connecter' })).toBeDisabled();
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
});
test('la disponibilité du serveur ne vaut pas ouverture de session', async ({ page }) => {
  await page.route('**/api/v1/health/ready', (route) =>
    route.fulfill({
      headers: { 'Access-Control-Allow-Origin': '*' },
      json: {
        service: 'caissepro-api',
        protocolVersion: 2,
        deploymentId: 'caissepro-development',
        status: 'ready',
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Serveur disponible');
  await expect(page.getByRole('heading', { name: 'Connectez-vous à votre espace' })).toBeVisible();
  await expect(page.getByText('Soldes de vos caisses')).toHaveCount(0);
  await expect(page.getByText(/Cet aperçu ne permet pas d’ouvrir une session/)).toBeVisible();
  await page.screenshot({ path: 'test-results/caissepro-login.png', fullPage: true });
});
