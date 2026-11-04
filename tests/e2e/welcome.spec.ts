import { test, expect } from '@playwright/test';
test('accueil hors connexion et navigation sans stockage sensible', async ({ page }) => {
  await page.route('**/api/v1/health/ready', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Bienvenue sur CaissePro/ })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Hors connexion');
  await page.getByRole('button', { name: 'Brouillons 0' }).click();
  await expect(page.getByRole('heading', { name: 'Aucun brouillon disponible' })).toBeVisible();
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
});
test('un contrat de disponibilité valide affiche En ligne sans ouvrir de session', async ({
  page,
}) => {
  await page.route('**/api/v1/health/ready', (route) =>
    route.fulfill({
      headers: { 'Access-Control-Allow-Origin': '*' },
      json: {
        service: 'caissepro-api',
        protocolVersion: 1,
        deploymentId: 'caissepro-development',
        status: 'ready',
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('En ligne');
  await expect(page.getByText('Session non ouverte')).toBeVisible();
  await page.screenshot({ path: 'test-results/caissepro-welcome.png', fullPage: true });
});
