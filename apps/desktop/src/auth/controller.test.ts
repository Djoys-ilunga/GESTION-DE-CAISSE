import { describe, it, expect } from 'vitest';
import { AuthController, anonymous } from './controller';
import { fakeGateway, view, profile } from './test-fixture';
describe('Transitions de session du frontend', () => {
  it('ignore un résultat de connexion tardif après déconnexion', async () => {
    const { gateway } = fakeGateway();
    const controller = new AuthController(gateway);
    let resolve!: (value: ReturnType<typeof view>) => void;
    const delayed = new Promise<ReturnType<typeof view>>((done) => {
      resolve = done;
    });
    const login = controller.action(() => delayed);
    await controller.logout();
    resolve(view());
    await login;
    expect(controller.getSnapshot().state).toBe('anonymous');
  });
  it('ne réintroduit pas les données d’un utilisateur précédent', async () => {
    const { gateway } = fakeGateway();
    const controller = new AuthController(gateway);
    await controller.action(async () => view(profile('Alice')));
    await controller.logout();
    await controller.action(async () => ({
      ...view(profile('Bob')),
      generation: controller.getSnapshot().generation + 1,
    }));
    expect(controller.getSnapshot().profile?.user.displayName).toBe('Bob');
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('Alice');
  });
  it('retire le profil après expiration signalée par le courtier', async () => {
    const { gateway, set } = fakeGateway(view());
    const controller = new AuthController(gateway);
    await controller.refresh();
    set({ ...anonymous, reason: 'SESSION_EXPIRED', generation: 2 });
    await controller.refresh();
    expect(controller.getSnapshot().profile).toBeNull();
    expect(controller.getSnapshot().reason).toBe('SESSION_EXPIRED');
  });
  it('efface son état et ignore les réponses après arrêt', async () => {
    const { gateway } = fakeGateway(view());
    const controller = new AuthController(gateway);
    await controller.refresh();
    controller.stop();
    expect(controller.getSnapshot().profile).toBeNull();
  });
  it('refuse un ancien profil même après une nouvelle actualisation', async () => {
    const { gateway, set } = fakeGateway({ ...view(), generation: 4 });
    const controller = new AuthController(gateway);
    await controller.refresh();
    set({ ...anonymous, generation: 5, reason: 'SESSION_REVOKED' });
    await controller.refresh();
    set({ ...view(), generation: 4 });
    await controller.refresh();
    expect(controller.getSnapshot().profile).toBeNull();
    expect(controller.getSnapshot().generation).toBe(5);
  });
});
